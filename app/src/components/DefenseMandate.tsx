"use client";

import { useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { clearMandateCalls, mandateCalls, readBaseFunds, readMandate, type Mandate } from "@/lib/defense";
import type { GatewaySigner } from "@/lib/gatewaySigner";
import { network, txUrl } from "@/lib/network";

/**
 * The defense mandate: what the keeper's CCTP alarm may spend from the
 * owner's wallet on Base when a position falls under the guard's minimum and
 * the reserve is not enough. USDC first, then WETH sold against Chainlink
 * within the slippage chosen; only to repay the owner's account on Arc.
 *
 * @param props.signer Sends the Base transactions for the connected wallet.
 * @param props.owner The owner's wallet.
 */
export function DefenseMandate({ signer, owner }: { signer: GatewaySigner; owner: Address }) {
  const [mandate, setMandate] = useState<Mandate | null>();
  const [funds, setFunds] = useState<{ usdc: bigint; weth: bigint }>();
  const [usdc, setUsdc] = useState("1");
  const [weth, setWeth] = useState("0.0002");
  const [slippage, setSlippage] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [version, setVersion] = useState(0);
  const [readError, setReadError] = useState<string>();

  useEffect(() => {
    let current = true;
    readMandate(owner).then(
      (m) => {
        if (!current) return;
        setMandate(m);
        setReadError(undefined);
      },
      (e: Error) => current && setReadError(e.message.split("\n")[0]),
    );
    readBaseFunds(owner).then((f) => current && setFunds(f), () => undefined);
    return () => {
      current = false;
    };
  }, [owner, version]);

  async function run(calls: () => { to: Address; data: `0x${string}` }[]) {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await signer.sendOnBase(calls()));
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  }

  const choice = () => ({ usdcPerDay: usdc, wethPerDay: weth, maxSlippageBps: Math.round((Number(slippage) || 0) * 100) });

  return (
    <div className="flex flex-col gap-3">
      <div>
        <span className="eyebrow">Defense mandate</span>
        <p className="mt-1 text-sm text-muted">
          If the reserve is not enough, a Circle-attested alarm from Arc lets the executor spend these from your wallet on{" "}
          {network.base.label}, USDC first, then WETH sold at most at the slippage below the Chainlink price, only to repay your
          account.
        </p>
      </div>
      {readError ? (
        <p className="text-sm text-danger">Could not read your mandate: {readError}</p>
      ) : mandate === undefined ? (
        <p className="text-sm text-muted">Reading your mandate…</p>
      ) : mandate ? (
        <p className="rounded-xl border border-line px-3 py-2 text-sm">
          Active: {mandate.assets.map((a) => `${a.cap} ${a.symbol}`).join(" then ")} per {mandate.periodHours} h, at most{" "}
          {mandate.maxSlippageBps / 100}% slippage.
        </p>
      ) : (
        <p className="text-sm text-faint">No mandate yet.</p>
      )}
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">USDC per day</span>
          <input className="field font-mono text-sm" inputMode="decimal" value={usdc} onChange={(e) => setUsdc(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">WETH per day</span>
          <input className="field font-mono text-sm" inputMode="decimal" value={weth} onChange={(e) => setWeth(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Max slippage %</span>
          <input className="field font-mono text-sm" inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
        </label>
      </div>
      {funds && (
        <p className="text-xs text-faint">
          In your wallet on {network.base.label}: {formatUnits(funds.usdc, 6)} USDC, {formatUnits(funds.weth, 18)} WETH. The caps
          are a ceiling: only what you hold can be spent.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary px-4 py-2 text-sm" disabled={busy || readError !== undefined || mandate === undefined} onClick={() => void run(() => mandateCalls(choice()))}>
          {busy ? "Confirm in your wallet…" : mandate ? "Update mandate" : "Set mandate"}
        </button>
        {mandate && (
          <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={busy} onClick={() => void run(clearMandateCalls)}>
            Remove
          </button>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {done && (
        <p className="text-sm text-muted">
          Done.{" "}
          <a className="underline" href={txUrl(network.base, done as `0x${string}`)} target="_blank" rel="noreferrer">
            Transaction
          </a>
        </p>
      )}
      <p className="text-xs text-faint">It covers all the positions of this wallet, the one closest to liquidation first.</p>
    </div>
  );
}
