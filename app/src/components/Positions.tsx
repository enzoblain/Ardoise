"use client";

import { useEffect, useState } from "react";
import { marginFromHealth, NO_DEBT_HEALTH, WAD, type ArdoiseClient, type Caps, type Health, type Venue } from "@/lib/ardoise";
import { formatPercent, formatUsdc } from "@/lib/format";

/** A USD value in WAD, with cents. */
function formatUsd(wad: bigint): string {
  return `$${(Number(wad / 10n ** 14n) / 10_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A health factor in WAD, or "no debt". */
function formatHealth(healthFactor: bigint): string {
  return healthFactor >= NO_DEBT_HEALTH ? "no debt" : (Number((healthFactor * 100n) / WAD) / 100).toFixed(2);
}

interface Position {
  venue: Venue;
  health?: Health;
  error?: string;
}

/**
 * The owner's position on each lending venue (health factor, collateral,
 * debt, margin before liquidation) and what the account can still spend:
 * the per-payment and daily caps and the guard's minimum.
 *
 * @param props.account Account client to read from (demo or on-chain).
 * @param props.venues Venues the account borrows from.
 * @param props.version Bumped after each payment, to read again.
 */
export function Positions({ account, venues, version }: { account: ArdoiseClient; venues: Venue[]; version: number }) {
  const [positions, setPositions] = useState<Position[]>();
  const [caps, setCaps] = useState<Caps>();
  const [minHealth, setMinHealth] = useState<bigint | null>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      venues.map((venue) =>
        account.health(venue.id).then(
          (health): Position => ({ venue, health }),
          (e: Error): Position => ({ venue, error: e.message.split("\n")[0] }),
        ),
      ),
    ).then((read) => !cancelled && setPositions(read));
    account.caps().then((c) => !cancelled && setCaps(c), () => undefined);
    account.minHealthFactor().then((m) => !cancelled && setMinHealth(m), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [account, venues, version]);

  const minMargin = minHealth ? marginFromHealth(minHealth) : undefined;
  const leftToday = caps ? (caps.daily > caps.spentToday ? caps.daily - caps.spentToday : 0n) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="eyebrow">Collateral on each lender</p>
        <h2 className="text-lg font-semibold">Collateral and limits</h2>
      </div>
      {!positions && <p className="text-sm text-muted">Reading your positions…</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {positions?.map(({ venue, health, error }) => {
          const margin = health ? marginFromHealth(health.healthFactor) : 0;
          const low = minMargin !== undefined && health && health.healthFactor < NO_DEBT_HEALTH && margin < minMargin;
          return (
            <div key={venue.id} className="rounded-2xl border border-line p-4">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{venue.name}</span>
                <span className="text-xs text-muted">cirBTC → USDC</span>
              </div>
              {error ? (
                <p className="mt-2 text-sm text-danger">Could not read this position: {error}</p>
              ) : health ? (
                <>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted">Health factor</dt>
                      <dd className={`font-mono ${low ? "text-danger" : ""}`}>{formatHealth(health.healthFactor)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Collateral</dt>
                      <dd className="font-mono">{formatUsd(health.collateralUsd)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Debt</dt>
                      <dd className="font-mono">{formatUsd(health.debtUsd)}</dd>
                    </div>
                  </dl>
                  <div className="relative mt-3 h-1.5 rounded-full bg-line" role="meter" aria-label={`Margin on ${venue.name}`} aria-valuenow={Math.round(margin * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-full rounded-full ${low ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.round(margin * 100)}%` }} />
                    {minMargin !== undefined && (
                      <span className="absolute -top-1 h-3.5 w-px bg-danger" style={{ left: `${Math.round(minMargin * 100)}%` }} aria-hidden />
                    )}
                  </div>
                  <p className="mt-1.5 text-xs text-muted">Margin before liquidation {formatPercent(margin)}</p>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <dl className="grid grid-cols-3 gap-3 rounded-2xl border border-line p-4 text-sm">
        <div>
          <dt className="text-xs text-muted">Left to spend today</dt>
          <dd className="font-mono">{leftToday === undefined ? "…" : `${formatUsdc(leftToday)} USDC`}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Per payment</dt>
          <dd className="font-mono">{caps ? `${formatUsdc(caps.perPayment)} USDC` : "…"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Guard minimum</dt>
          <dd className="font-mono">{minHealth === undefined ? "…" : minHealth === null ? "no guard" : formatHealth(minHealth)}</dd>
        </div>
      </dl>
    </div>
  );
}
