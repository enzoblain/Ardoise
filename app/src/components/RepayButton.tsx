"use client";

import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { arcClient } from "@/lib/arc";
import { sendCalls } from "@/lib/collateral";
import { erc20Abi } from "@/lib/contracts/deployments";
import { formatUsdc } from "@/lib/format";
import { gateway } from "@/lib/gateway";
import { GAS_RESERVE, repayAllCalls, repayAmount, repayCalls } from "@/lib/repay";
import type { ConnectedWallet } from "@/lib/wallet";

/**
 * Repays one borrowing in full from the owner's wallet on Arc (USDC there),
 * through the account's `repay`. What the lender does not take comes back.
 *
 * @param props.wallet The connected wallet.
 * @param props.account The owner's Ardoise account.
 * @param props.lineId The borrowing to repay.
 * @param props.owed What it is estimated to owe, USDC units.
 * @param props.onRepaid Called after the repayment, to read again.
 */
export function RepayButton(props: { wallet: ConnectedWallet; account: Address; lineId: bigint; owed: bigint; onRepaid: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function repay() {
    setBusy(true);
    setError(undefined);
    try {
      const balance = await arcClient.readContract({ address: gateway.arcUsdc, abi: erc20Abi, functionName: "balanceOf", args: [props.wallet.address] });
      const amount = repayAmount(props.owed, balance);
      if (amount === 0n) throw new Error("Not enough USDC in your wallet on Arc to repay and pay the gas.");
      await sendCalls(props.wallet, arcClient, repayCalls(props.account, props.lineId, amount));
      if (amount < props.owed) setError(`Repaid ${formatUnits(amount, 6)} USDC, all your wallet held: the rest is still owed.`);
      props.onRepaid();
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={() => void repay()}
        disabled={busy}
        title={`Repay about ${formatUsdc(props.owed)} USDC from your wallet`}
        className="rounded-full border border-line px-2.5 py-0.5 text-xs text-foreground transition-colors hover:border-line-strong disabled:opacity-50"
      >
        {busy ? "Repaying…" : "Repay"}
      </button>
      {error && <span className="max-w-48 text-right text-[11px] text-danger">{error}</span>}
    </span>
  );
}

/**
 * Repays every open borrowing on one lender from the owner's wallet on Arc:
 * one approval, then one `repay` per line. Refuses when the wallet holds
 * less than the total, so a position is either closed or left as it was.
 *
 * @param props.wallet The connected wallet.
 * @param props.account The owner's Ardoise account.
 * @param props.lines The open borrowings on that lender.
 * @param props.onRepaid Called after the repayment, to read again.
 */
export function RepayAllButton(props: { wallet: ConnectedWallet; account: Address; lines: { lineId: bigint; owed: bigint }[]; onRepaid: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function repay() {
    setBusy(true);
    setError(undefined);
    try {
      const { calls, total } = repayAllCalls(props.account, props.lines);
      const balance = await arcClient.readContract({ address: gateway.arcUsdc, abi: erc20Abi, functionName: "balanceOf", args: [props.wallet.address] });
      if (balance < total + GAS_RESERVE)
        throw new Error(`Needs ${formatUnits(total + GAS_RESERVE, 6)} USDC in your wallet on Arc (gas included); it holds ${formatUnits(balance, 6)}.`);
      await sendCalls(props.wallet, arcClient, calls);
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
      // Read again even after a failure: earlier lines may have been repaid before it.
      props.onRepaid();
    }
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <button type="button" onClick={() => void repay()} disabled={busy} className="btn-secondary px-3 py-1 text-xs disabled:opacity-50">
        {busy ? "Repaying…" : "Repay all"}
      </button>
      {error && <span className="max-w-56 text-right text-[11px] text-danger">{error}</span>}
    </span>
  );
}
