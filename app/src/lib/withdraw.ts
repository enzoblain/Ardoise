import { encodeFunctionData, parseUnits, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { accountAbi } from "@/lib/contracts/abis";
import { erc20Abi } from "@/lib/contracts/deployments";
import { formatUsdc } from "@/lib/format";
import { network } from "@/lib/network";
import { sendFromPasskey, switchChain, type Call, type ConnectedWallet } from "@/lib/wallet";

const USDC_DECIMALS = 6;

/** Result of reading the amount typed in the Withdraw panel. */
export type WithdrawAmount = { ok: true; amount: bigint } | { ok: false; error: string };

/**
 * Reads a USDC amount typed by the owner and checks it against the account's
 * idle balance, as `withdraw(amount)` would: it reverts with `ZeroAmount` for
 * 0 and with `InsufficientBalance` above the balance (docs/api.md, *Withdrawal*).
 *
 * @param input What the owner typed, for example "12.5".
 * @param balance USDC on the account, in USDC units (6 decimals).
 * @returns The amount in USDC units, or why it cannot be withdrawn.
 */
export function parseWithdrawAmount(input: string, balance: bigint): WithdrawAmount {
  const text = input.trim();
  if (text === "") return { ok: false, error: "Enter an amount." };
  if (!/^\d*\.?\d*$/.test(text) || text === ".") return { ok: false, error: "Enter a number, for example 12.50." };
  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > USDC_DECIMALS) return { ok: false, error: "USDC has at most 6 decimals." };
  const amount = parseUnits(text, USDC_DECIMALS);
  if (amount === 0n) return { ok: false, error: "Enter an amount above 0." };
  if (amount > balance) return { ok: false, error: `The account holds ${formatUsdc(balance)} USDC.` };
  return { ok: true, amount };
}

/**
 * The `withdraw(amount)` call on the owner's account, for a smart account batch.
 *
 * @param account The owner's `ArdoiseAccount`.
 * @param amount USDC units to send back to the owner.
 * @returns The contract call.
 */
export function withdrawCall(account: Address, amount: bigint): Call {
  return { to: account, data: encodeFunctionData({ abi: accountAbi, functionName: "withdraw", args: [amount] }) };
}

/**
 * Reads the USDC sitting on the account (waiting for `sweep()` or a withdrawal).
 *
 * @param client Public client on Arc.
 * @param account The owner's `ArdoiseAccount`.
 * @returns The balance in USDC units (6 decimals).
 */
export async function readIdleUsdc(client: PublicClient<Transport, Chain>, account: Address): Promise<bigint> {
  const usdc = await client.readContract({ address: account, abi: accountAbi, functionName: "usdc" });
  return client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

/**
 * Withdraws `amount` of the account's idle USDC to the owner, the way payments
 * are sent: one transaction from a browser wallet on Arc, or one user
 * operation from a passkey smart account.
 *
 * @param wallet The owner's connected wallet.
 * @param client Public client on Arc, to wait for the receipt.
 * @param account The owner's `ArdoiseAccount`.
 * @param amount USDC units to withdraw.
 * @returns The hash of the transaction that carried the withdrawal.
 * @throws If the wallet refuses, or the transaction or user operation reverts.
 */
export async function sendWithdraw(
  wallet: ConnectedWallet,
  client: PublicClient<Transport, Chain>,
  account: Address,
  amount: bigint,
): Promise<Hex> {
  if (wallet.kind === "passkey") return sendFromPasskey(wallet, [withdrawCall(account, amount)]);
  // The wallet may still be on Base after a deposit from the Protection panel.
  await switchChain(wallet.provider, network.arc.chain);
  const hash = await wallet.client.writeContract({
    account: wallet.client.account,
    chain: wallet.client.chain,
    address: account,
    abi: accountAbi,
    functionName: "withdraw",
    args: [amount],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return hash;
}
