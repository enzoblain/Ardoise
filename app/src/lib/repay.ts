import { encodeFunctionData, type Address } from "viem";
import { accountAbi } from "@/lib/contracts/abis";
import { erc20Abi } from "@/lib/contracts/deployments";
import { gateway } from "@/lib/gateway";
import type { Call } from "@/lib/wallet";

/**
 * Headroom added to what a line is estimated to owe: interest keeps accruing
 * between the read and the transaction, and the venue only takes what is
 * owed, so the account sends the rest back to the payer.
 */
export const REPAY_HEADROOM = 10_000n; // 0.01 USDC

/**
 * How much to send to close a line: its estimate plus headroom, never more
 * than the wallet holds.
 *
 * @param owed What the line is estimated to owe, USDC units.
 * @param walletBalance USDC in the owner's wallet on Arc, USDC units.
 * @returns The amount to approve and repay; 0 when the wallet is empty.
 */
export function repayAmount(owed: bigint, walletBalance: bigint): bigint {
  const wanted = owed + REPAY_HEADROOM;
  return wanted < walletBalance ? wanted : walletBalance;
}

/**
 * The calls that repay a line from the owner's wallet on Arc: approve the
 * account for the amount, then `repay(lineId, amount)`. The account repays
 * through the line's venue and returns what the venue does not take.
 *
 * @param account The owner's Ardoise account.
 * @param lineId The line to repay.
 * @param amount USDC units to send.
 * @returns The two calls, in order.
 */
export function repayCalls(account: Address, lineId: bigint, amount: bigint): Call[] {
  return [
    { to: gateway.arcUsdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [account, amount] }) },
    { to: account, data: encodeFunctionData({ abi: accountAbi, functionName: "repay", args: [lineId, amount] }) },
  ];
}

/**
 * The calls that repay several lines in one go from the owner's wallet: one
 * approval for the total, then `repay` on each line with its estimate plus
 * headroom.
 *
 * @param account The owner's Ardoise account.
 * @param lines The lines to repay, with what each is estimated to owe.
 * @returns The calls and the total approved, USDC units.
 */
export function repayAllCalls(account: Address, lines: { lineId: bigint; owed: bigint }[]): { calls: Call[]; total: bigint } {
  const each = lines.map((l) => ({ lineId: l.lineId, amount: l.owed + REPAY_HEADROOM }));
  const total = each.reduce((sum, l) => sum + l.amount, 0n);
  return {
    total,
    calls: [
      { to: gateway.arcUsdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [account, total] }) },
      ...each.map((l) => ({ to: account, data: encodeFunctionData({ abi: accountAbi, functionName: "repay", args: [l.lineId, l.amount] }) })),
    ],
  };
}
