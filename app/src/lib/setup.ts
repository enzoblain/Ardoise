import { zeroAddress, type Account, type Address, type Chain, type Hash, type PublicClient, type Transport, type WalletClient } from "viem";
import { factoryAbi } from "@/lib/contracts/abis";
import { aaveSpokeAbi, aaveTakerAbi, type Deployment } from "@/lib/contracts/deployments";

/** Where the owner stands in the one-time setup (docs/api.md, *One-time user setup on Aave V4*). */
export interface SetupState {
  /** cirBTC the owner supplies on the Main Spoke, in its 8 decimals. */
  collateral: bigint;
  collateralEnabled: boolean;
  takerApproved: boolean;
  giverApproved: boolean;
  /** The owner's `ArdoiseAccount`, or `null` before `createAccount()`. */
  account: Address | null;
  /** USDC the adapter may still borrow for the owner on Aave V4. */
  borrowAllowance: bigint;
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
  const [collateral, [collateralEnabled], takerApproved, giverApproved, account, borrowAllowance] = await Promise.all([
    client.readContract({ ...spoke, functionName: "getUserSuppliedAssets", args: [deployment.cirBtcReserveId, owner] }),
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
  ]);
  return {
    collateral,
    collateralEnabled,
    takerApproved,
    giverApproved,
    account: account === zeroAddress ? null : account,
    borrowAllowance,
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
  if (state.borrowAllowance === 0n) steps.push("approveBorrow");
  return steps;
}

/**
 * Sends one setup step from the owner's wallet and waits for it.
 *
 * @param step Step to run.
 * @param wallet Owner's wallet client.
 * @param client Public client, to wait for the receipt.
 * @param deployment Deployed addresses.
 * @param borrowCap Borrow allowance to give the adapter, in USDC units; a
 *   finite cap, since the adapter is shared by every user (docs/api.md).
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
