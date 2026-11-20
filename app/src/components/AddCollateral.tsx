"use client";

import { useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { arcClient } from "@/lib/arc";
import { addCollateralCalls, morphoAuthorized, parseCirBtc, sendCalls, type CollateralLender } from "@/lib/collateral";
import { erc20Abi, type Deployment } from "@/lib/contracts/deployments";
import type { ConnectedWallet } from "@/lib/wallet";

/**
 * Adds cirBTC from the wallet as collateral in the owner's own position on
 * Aave V4 or Morpho, to back a new borrowing. On Morpho it also lets the
 * Morpho adapter borrow for the owner the first time.
 *
 * @param props.wallet The connected wallet.
 * @param props.deployment Deployed addresses.
 * @param props.onDone Called after the collateral is added, to read the positions again.
 */
export function AddCollateral({ wallet, deployment, onDone }: { wallet: ConnectedWallet; deployment: Deployment; onDone: () => void }) {
  const [lender, setLender] = useState<CollateralLender>("aave-v4");
  const [balance, setBalance] = useState<bigint>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    arcClient
      .readContract({ address: deployment.cirBtc, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address as Address] })
      .then((b) => current && setBalance(b), () => current && setBalance(0n));
    return () => {
      current = false;
    };
  }, [wallet, deployment, version]);

  const parsed = balance === undefined ? undefined : parseCirBtc(text, balance);

  async function add() {
    if (!parsed?.ok) return;
    setSending(true);
    setError(undefined);
    setDone(undefined);
    try {
      const authorize = lender === "morpho" && deployment.morphoAdapter ? !(await morphoAuthorized(arcClient, wallet.address, deployment.morphoAdapter)) : false;
      const hash = await sendCalls(wallet, arcClient, addCollateralCalls(lender, parsed.amount, wallet.address, deployment, authorize));
      setDone(hash);
      setText("");
      onDone();
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setSending(false);
      setVersion((v) => v + 1);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2" role="radiogroup" aria-label="Lender">
        {(
          [
            ["aave-v4", "Aave V4"],
            ["morpho", "Morpho"],
          ] as const
        ).map(([id, name]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={lender === id}
            onClick={() => setLender(id)}
            className={`rounded-full border px-3 py-1.5 text-sm ${lender === id ? "border-accent text-foreground" : "border-line text-muted"}`}
          >
            {name}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">cirBTC to add</span>
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            inputMode="decimal"
            placeholder="0.0001"
            className="w-full rounded-xl border border-line bg-background px-3 py-2 font-mono text-sm"
          />
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-sm"
            disabled={!balance}
            onClick={() => balance !== undefined && setText(formatUnits(balance, 8))}
          >
            Max
          </button>
        </div>
      </label>
      <p className="text-xs text-muted">
        In your wallet: {balance === undefined ? "…" : `${formatUnits(balance, 8)} cirBTC`}. It goes to your own position on the
        lender; Ardoise never holds it.
      </p>
      {text && parsed && !parsed.ok && <p className="text-xs text-danger">{parsed.error}</p>}
      <button type="button" className="btn-primary px-4 py-2 text-sm" disabled={!parsed?.ok || sending} onClick={() => void add()}>
        {sending ? "Adding…" : "Add collateral"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
      {done && (
        <p className="text-sm text-muted">
          Added.{" "}
          <a className="underline" href={`https://explorer.arc.io/tx/${done}`} target="_blank" rel="noreferrer">
            Transaction
          </a>
        </p>
      )}
    </div>
  );
}
