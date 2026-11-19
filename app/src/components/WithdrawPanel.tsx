"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { arcClient } from "@/lib/arc";
import { formatUsdc } from "@/lib/format";
import { network, txUrl } from "@/lib/network";
import type { ConnectedWallet } from "@/lib/wallet";
import { parseWithdrawAmount, readIdleUsdc, sendWithdraw } from "@/lib/withdraw";

/**
 * The USDC sitting on the live account (waiting for `sweep()`, or more than
 * the debt) and a form for the owner to take it back with `withdraw(amount)`,
 * signed like a payment: by the browser wallet on Arc, or as one passkey user
 * operation.
 *
 * @param props.wallet The owner's connected wallet.
 * @param props.account The owner's `ArdoiseAccount`.
 */
export function WithdrawPanel({ wallet, account }: { wallet: ConnectedWallet; account: Address }) {
  const [balance, setBalance] = useState<bigint>();
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [lastTx, setLastTx] = useState<`0x${string}`>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setBalance(await readIdleUsdc(arcClient, account));
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    }
  }, [account]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const parsed = balance === undefined || input === "" ? undefined : parseWithdrawAmount(input, balance);

  async function withdraw() {
    if (!parsed?.ok) return;
    setRunning(true);
    setError(undefined);
    try {
      setLastTx(await sendWithdraw(wallet, arcClient, account, parsed.amount));
      setInput("");
      await refresh();
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="withdraw-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="withdraw-title" className="text-lg font-semibold tracking-tight">
          Withdraw
        </h2>
        <span className="text-sm text-muted">
          {balance === undefined ? "Reading…" : <span className="font-mono text-foreground">{formatUsdc(balance)} USDC</span>} on
          the account
        </span>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        USDC on your account repays your debt at the next sweep. Take back what you do not want applied, for example a
        reserve larger than the debt; it goes to your own wallet.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void withdraw();
        }}
      >
        <input
          aria-label="Amount to withdraw, in USDC"
          inputMode="decimal"
          placeholder="0.00"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-32 rounded-xl border border-line bg-background px-3 py-2 font-mono text-sm"
        />
        <button
          type="button"
          disabled={!balance || running}
          onClick={() => balance !== undefined && setInput(formatUnits(balance, 6))}
          className="btn-secondary px-3 py-2 text-sm"
        >
          Max
        </button>
        <button type="submit" disabled={!parsed?.ok || running} className="btn-primary px-4 py-2 text-sm">
          {running ? (wallet.kind === "passkey" ? "Confirm with your passkey…" : "Confirm in your wallet…") : "Withdraw"}
        </button>
      </form>
      {parsed && !parsed.ok && <p className="text-xs text-faint">{parsed.error}</p>}
      {lastTx && (
        <p className="text-xs text-faint">
          Withdrawn:{" "}
          <a className="underline" href={txUrl(network.arc, lastTx)} target="_blank" rel="noreferrer">
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}
