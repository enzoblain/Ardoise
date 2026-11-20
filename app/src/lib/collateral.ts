import { encodeFunctionData, parseAbi, parseUnits, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { aaveSpokeAbi, erc20Abi, type Deployment } from "@/lib/contracts/deployments";
import { network } from "@/lib/network";
import { sendFromPasskey, switchChain, type Call, type ConnectedWallet } from "@/lib/wallet";

/** Lenders the app can add cirBTC collateral to. */
export type CollateralLender = "aave-v4" | "morpho";

/** Morpho on Arc mainnet and its cirBTC/USDC market (86% LLTV), the one `MorphoAdapter` borrows on. */
const MORPHO: Address = "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD";
const MORPHO_MARKET = {
  loanToken: "0x3600000000000000000000000000000000000000",
  collateralToken: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
  oracle: "0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab",
  irm: "0xF02615d094Fc02fC031C35fe705e175aA4653f20",
  lltv: 860000000000000000n,
} as const;
const morphoAbi = parseAbi([
  "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function setAuthorization(address authorized, bool newIsAuthorized)",
  "function isAuthorized(address authorizer, address authorized) view returns (bool)",
]);

/**
 * Whether the owner already lets the Morpho adapter borrow on their behalf.
 *
 * @param client Public client on Arc.
 * @param owner The owner's wallet.
 * @param adapter The deployment's Morpho adapter.
 * @returns True when authorized.
 */
export function morphoAuthorized(client: PublicClient<Transport, Chain>, owner: Address, adapter: Address): Promise<boolean> {
  return client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [owner, adapter] });
}

/**
 * Parses a cirBTC amount (8 decimals) typed by the user.
 *
 * @param input The text typed.
 * @param balance cirBTC in the wallet, in satoshis.
 * @returns The amount in satoshis, or why it is refused.
 */
export function parseCirBtc(input: string, balance: bigint): { ok: true; amount: bigint } | { ok: false; error: string } {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return { ok: false, error: "Enter an amount of cirBTC." };
  const [, decimals = ""] = text.split(".");
  if (decimals.length > 8) return { ok: false, error: "cirBTC has 8 decimals." };
  const amount = parseUnits(text, 8);
  if (amount === 0n) return { ok: false, error: "Enter more than 0." };
  if (amount > balance) return { ok: false, error: "More than the cirBTC in your wallet." };
  return { ok: true, amount };
}

/**
 * The calls that add cirBTC from the owner's wallet as collateral in the
 * owner's own position on a lender: approve, then supply on the Aave V4 Main
 * Spoke (and enable it as collateral), or `supplyCollateral` on Morpho's
 * cirBTC/USDC market. The position stays the owner's: Ardoise never holds it.
 *
 * @param lender Where to add it.
 * @param amount Satoshis.
 * @param owner The owner's wallet, which supplies on its own behalf.
 * @param deployment Deployed addresses.
 * @param authorizeMorpho On Morpho, also let the Morpho adapter borrow for the owner (Morpho
 *   reverts when the authorization is already set, so only when it is not).
 * @returns The calls, in order.
 */
export function addCollateralCalls(
  lender: CollateralLender,
  amount: bigint,
  owner: Address,
  deployment: Deployment,
  authorizeMorpho = false,
): Call[] {
  if (lender === "morpho") {
    const calls: Call[] = [
      { to: deployment.cirBtc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO, amount] }) },
      { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [MORPHO_MARKET, amount, owner, "0x"] }) },
    ];
    if (authorizeMorpho && deployment.morphoAdapter) {
      calls.push({ to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [deployment.morphoAdapter, true] }) });
    }
    return calls;
  }
  return [
    { to: deployment.cirBtc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployment.aaveSpoke, amount] }) },
    {
      to: deployment.aaveSpoke,
      data: encodeFunctionData({ abi: aaveSpokeAbi, functionName: "supply", args: [deployment.cirBtcReserveId, amount, owner] }),
    },
    {
      to: deployment.aaveSpoke,
      data: encodeFunctionData({ abi: aaveSpokeAbi, functionName: "setUsingAsCollateral", args: [deployment.cirBtcReserveId, true, owner] }),
    },
  ];
}

/**
 * Sends calls from the owner's wallet on Arc: one user operation from a
 * passkey smart account, or one transaction per call from a browser wallet,
 * each waited for before the next.
 *
 * @param wallet The connected wallet.
 * @param client Public client on Arc, to wait for receipts.
 * @param calls Calls to send.
 * @returns The hash of the last transaction.
 * @throws If the wallet refuses or a transaction reverts.
 */
export async function sendCalls(wallet: ConnectedWallet, client: PublicClient<Transport, Chain>, calls: Call[]): Promise<Hex> {
  if (wallet.kind === "passkey") return sendFromPasskey(wallet, calls);
  await switchChain(wallet.provider, network.arc.chain);
  let hash: Hex = "0x";
  for (const call of calls) {
    hash = await wallet.client.sendTransaction({ account: wallet.client.account!, chain: wallet.client.chain, to: call.to, data: call.data });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  }
  return hash;
}
