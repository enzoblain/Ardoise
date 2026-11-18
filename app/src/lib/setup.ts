import { encodeFunctionData, zeroAddress, type Account, type Address, type Chain, type Hash, type PublicClient, type Transport, type WalletClient } from "viem";
import { accountAbi, factoryAbi } from "@/lib/contracts/abis";
import { aaveSpokeAbi, aaveTakerAbi, erc20Abi, type Deployment } from "@/lib/contracts/deployments";
import type { Call } from "@/lib/wallet";

/** Where the owner stands in the one-time setup (docs/api.md, *One-time user setup on Aave V4*). */
export interface SetupState {
  /** cirBTC the owner supplies on the Main Spoke, in its 8 decimals. */
  collateral: bigint;
  /** cirBTC held in the owner's wallet and not supplied yet, in its 8 decimals. */
  walletCirBtc: bigint;
  collateralEnabled: boolean;
  takerApproved: boolean;
  giverApproved: boolean;
  /** The owner's `ArdoiseAccount`, or `null` before `createAccount()`. */
  account: Address | null;
  /** USDC the adapter may still borrow for the owner on Aave V4. */
  borrowAllowance: bigint;
  /** The account's per-payment cap (the factory's default before it exists): an allowance below it blocks a full payment. */
  perPaymentCap: bigint;
}

/** Steps the app can run from the owner's wallet, in order. */
export type SetupStep = "approveTaker" | "approveGiver" | "createAccount" | "approveBorrow";

/**
 * Reads the owner's setup state on Arc.
 *
 * @param client Public client on the deployment's network.
 * @param deployment Deployed addresses.
 * @param owner Wallet that owns the collateral and the account.
 * @returns The current state.
 */
export async function readSetup(
  client: PublicClient<Transport, Chain>,
  deployment: Deployment,
  owner: Address,
): Promise<SetupState> {
  const spoke = { address: deployment.aaveSpoke, abi: aaveSpokeAbi } as const;
  const [collateral, walletCirBtc, [collateralEnabled], takerApproved, giverApproved, account, borrowAllowance, perPaymentCap] = await Promise.all([
    client.readContract({ ...spoke, functionName: "getUserSuppliedAssets", args: [deployment.cirBtcReserveId, owner] }),
    client.readContract({ address: deployment.cirBtc, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ ...spoke, functionName: "getUserReserveStatus", args: [deployment.cirBtcReserveId, owner] }),
    client.readContract({ ...spoke, functionName: "isPositionManager", args: [owner, deployment.aaveTaker] }),
    client.readContract({ ...spoke, functionName: "isPositionManager", args: [owner, deployment.aaveGiver] }),
    client.readContract({ address: deployment.factory, abi: factoryAbi, functionName: "accountOf", args: [owner] }),
    client.readContract({
      address: deployment.aaveTaker,
      abi: aaveTakerAbi,
      functionName: "borrowAllowance",
      args: [deployment.aaveSpoke, deployment.usdcReserveId, owner, deployment.aaveAdapter],
    }),
    client.readContract({ address: deployment.factory, abi: factoryAbi, functionName: "defaultPerPaymentCap" }),
  ]);
  // Once the account exists, its own cap counts: the owner may have raised it.
  const cap =
    account === zeroAddress
      ? perPaymentCap
      : (await client.readContract({ address: account, abi: accountAbi, functionName: "caps" }))[0];
  return {
    collateral,
    walletCirBtc,
    collateralEnabled,
    takerApproved,
    giverApproved,
    account: account === zeroAddress ? null : account,
    borrowAllowance,
    perPaymentCap: cap,
  };
}

/**
 * Steps still missing, in the order to run them. Supplying cirBTC is not
 * one of them: the owner does it on Aave, since buying collateral is their
 * call.
 *
 * @param state Current setup state.
 * @returns The steps the app can run, first one first.
 */
export function missingSteps(state: SetupState): SetupStep[] {
  const steps: SetupStep[] = [];
  if (!state.takerApproved) steps.push("approveTaker");
  if (!state.giverApproved) steps.push("approveGiver");
  if (state.account === null) steps.push("createAccount");
  // Renewed once it no longer covers a full payment, not only when empty.
  if (state.borrowAllowance < state.perPaymentCap) steps.push("approveBorrow");
  return steps;
}

/**
 * The call behind one setup step.
 *
 * @param step Step to encode.
 * @param deployment Deployed addresses.
 * @param borrowCap Borrow allowance to give the adapter, in USDC units; a
 *   finite cap, since the adapter is shared by every user (docs/api.md).
 * @returns The contract call that runs the step.
 */
export function stepCall(step: SetupStep, deployment: Deployment, borrowCap: bigint): Call {
  switch (step) {
    case "approveTaker":
    case "approveGiver":
      return {
        to: deployment.aaveSpoke,
        data: encodeFunctionData({
          abi: aaveSpokeAbi,
          functionName: "setUserPositionManager",
          args: [step === "approveTaker" ? deployment.aaveTaker : deployment.aaveGiver, true],
        }),
      };
    case "createAccount":
      return { to: deployment.factory, data: encodeFunctionData({ abi: factoryAbi, functionName: "createAccount" }) };
    case "approveBorrow":
      return {
        to: deployment.aaveTaker,
        data: encodeFunctionData({
          abi: aaveTakerAbi,
          functionName: "approveBorrow",
          args: [deployment.aaveSpoke, deployment.usdcReserveId, deployment.aaveAdapter, borrowCap],
        }),
      };
  }
}

/**
 * Every call a smart account needs to become ready, for one user operation:
 * supplying the cirBTC it holds (approve, then supply on the Main Spoke),
 * enabling it as collateral, then the missing setup steps.
 *
 * A browser wallet signs one transaction per step instead (`runStep`), and
 * supplies cirBTC on Aave itself.
 *
 * @param state Current setup state of the smart account.
 * @param deployment Deployed addresses.
 * @param owner The smart account, which supplies on its own behalf.
 * @param borrowCap Borrow allowance to give the adapter, in USDC units.
 * @returns The calls in order; empty when the account is ready.
 */
export function activationCalls(state: SetupState, deployment: Deployment, owner: Address, borrowCap: bigint): Call[] {
  const calls: Call[] = [];
  if (state.walletCirBtc > 0n) {
    calls.push(
      {
        to: deployment.cirBtc,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployment.aaveSpoke, state.walletCirBtc] }),
      },
      {
        to: deployment.aaveSpoke,
        data: encodeFunctionData({
          abi: aaveSpokeAbi,
          functionName: "supply",
          args: [deployment.cirBtcReserveId, state.walletCirBtc, owner],
        }),
      },
    );
  }
  if (!state.collateralEnabled && (state.collateral > 0n || state.walletCirBtc > 0n)) {
    calls.push({
      to: deployment.aaveSpoke,
      data: encodeFunctionData({
        abi: aaveSpokeAbi,
        functionName: "setUsingAsCollateral",
        args: [deployment.cirBtcReserveId, true, owner],
      }),
    });
  }
  for (const step of missingSteps(state)) calls.push(stepCall(step, deployment, borrowCap));
  return calls;
}

/**
 * Sends one setup step from the owner's wallet and waits for it.
 *
 * @param step Step to run.
 * @param wallet Owner's wallet client.
 * @param client Public client, to wait for the receipt.
 * @param deployment Deployed addresses.
 * @param borrowCap Borrow allowance to give the adapter, in USDC units.
 * @returns The transaction hash.
 * @throws If the wallet refuses or the transaction reverts.
 */
export async function runStep(
  step: SetupStep,
  wallet: WalletClient<Transport, Chain, Account>,
  client: PublicClient<Transport, Chain>,
  deployment: Deployment,
  borrowCap: bigint,
): Promise<Hash> {
  const common = { account: wallet.account, chain: wallet.chain } as const;
  // writeContract rather than sendTransaction with stepCall's data, so the
  // wallet's errors keep the decoded revert reason.
  let hash: Hash;
  switch (step) {
    case "approveTaker":
    case "approveGiver":
      hash = await wallet.writeContract({
        ...common,
        address: deployment.aaveSpoke,
        abi: aaveSpokeAbi,
        functionName: "setUserPositionManager",
        args: [step === "approveTaker" ? deployment.aaveTaker : deployment.aaveGiver, true],
      });
      break;
    case "createAccount":
      hash = await wallet.writeContract({ ...common, address: deployment.factory, abi: factoryAbi, functionName: "createAccount" });
      break;
    case "approveBorrow":
      hash = await wallet.writeContract({
        ...common,
        address: deployment.aaveTaker,
        abi: aaveTakerAbi,
        functionName: "approveBorrow",
        args: [deployment.aaveSpoke, deployment.usdcReserveId, deployment.aaveAdapter, borrowCap],
      });
      break;
  }
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return hash;
}
