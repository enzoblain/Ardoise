"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { marginFromHealth, NO_DEBT_HEALTH, WAD, type ArdoiseClient, type Health, type Venue } from "@/lib/ardoise";
import { DEMO_MANDATE, readMandate, type Mandate } from "@/lib/defense";
import { formatBps, formatPercent, formatUsdc } from "@/lib/format";
import { chainByDomain } from "@/lib/network";
import { demoReserve, readReserve, type ReserveRead } from "@/lib/reserve";
import { buildStatement, type StatementLine } from "@/lib/statement";

function formatUsd(wad: bigint): string {
  return `$${(Number(wad / 10n ** 14n) / 10_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatHealth(healthFactor: bigint): string {
  return healthFactor >= NO_DEBT_HEALTH ? "no debt" : (Number((healthFactor * 100n) / WAD) / 100).toFixed(2);
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Card {
  key: string;
  lender: string;
  collateral: string;
  health?: Health;
  error?: string;
  lines: StatementLine[];
  /** Shown only on the demo account: a lender the contracts do not have. */
  illustrative?: boolean;
}

/**
 * The owner's positions, one card per lender: collateral, debt, the margin
 * bar against the guard's minimum, and the borrowings still owed on that
 * lender. Below, the protection the keeper uses for all of them: USDC on the
 * account, the Gateway reserve and its standing orders, and the defense
 * mandate on Base. On the demo account, a third position with a tokenized
 * real-world asset as collateral shows how another collateral would look.
 *
 * @param props.account Account client (demo or on-chain).
 * @param props.venues Venues the account borrows from.
 * @param props.version Bumped after each payment, to read again.
 * @param props.owner The owner's wallet on the live account; omitted on the demo account.
 * @param props.accountAddress The Ardoise account on the live account.
 */
export function MyPositions(props: { account: ArdoiseClient; venues: Venue[]; version: number; owner?: Address; accountAddress?: Address }) {
  const { account, venues, version, owner, accountAddress } = props;
  const live = owner !== undefined && accountAddress !== undefined;
  const [cards, setCards] = useState<Card[]>();
  const [minHealth, setMinHealth] = useState<bigint | null>();
  const [reserve, setReserve] = useState<ReserveRead>();
  const [mandate, setMandate] = useState<Mandate | null>();
  const [protectionError, setProtectionError] = useState<string>();

  useEffect(() => {
    let current = true;
    const now = Math.floor(Date.now() / 1000);
    void Promise.all([
      Promise.all(venues.map((v) => account.health(v.id).then((h) => ({ h }), (e: Error) => ({ e: e.message.split("\n")[0] })))),
      account.events().then(
        (e) => buildStatement(e.account, e.logs, e.blockTimes, venues, now).lines.filter((l) => l.owed > 0n),
        () => [] as StatementLine[],
      ),
    ]).then(([healths, lines]) => {
      if (!current) return;
      const read: Card[] = venues.map((v, i) => ({
        key: v.id,
        lender: v.name,
        collateral: "cirBTC",
        health: "h" in healths[i] ? healths[i].h : undefined,
        error: "e" in healths[i] ? healths[i].e : undefined,
        lines: lines.filter((l) => l.venueAddress.toLowerCase() === v.address.toLowerCase()),
      }));
      if (!live) read.push(RWA_DEMO);
      setCards(read);
    });
    account.minHealthFactor().then((m) => current && setMinHealth(m), () => undefined);
    return () => {
      current = false;
    };
  }, [account, venues, version, live]);

  useEffect(() => {
    let current = true;
    setProtectionError(undefined);
    Promise.all([
      live ? readReserve(owner, accountAddress) : demoReserve(),
      live ? readMandate(owner) : Promise.resolve(DEMO_MANDATE),
    ]).then(
      ([r, m]) => {
        if (!current) return;
        setReserve(r);
        setMandate(m);
      },
      (e: Error) => current && setProtectionError(e.message.split("\n")[0]),
    );
    return () => {
      current = false;
    };
  }, [live, owner, accountAddress, version]);

  const minMargin = minHealth ? marginFromHealth(minHealth) : undefined;
  const reserveIn = (speed: string) => reserve?.assets.filter((a) => a.speed === speed).reduce((s, a) => s + a.valueUsd, 0) ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="eyebrow">{live ? "Live on Arc mainnet" : "Demo account"}</p>
        <h2 className="text-2xl font-semibold tracking-tight">My positions</h2>
        <p className="mt-1 text-sm text-muted">
          One position per lender: your collateral and your debt there. Each borrowing adds to the debt of the lender it was
          taken from.
        </p>
      </div>

      {!cards && <p className="text-sm text-muted">Reading your positions…</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {cards?.map((card) => {
          const margin = card.health ? marginFromHealth(card.health.healthFactor) : 0;
          const low = minMargin !== undefined && card.health && card.health.healthFactor < NO_DEBT_HEALTH && margin < minMargin;
          const owed = card.lines.reduce((s, l) => s + l.owed, 0n);
          return (
            <section key={card.key} className="card flex flex-col gap-3" aria-label={`Position on ${card.lender}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold">{card.lender}</h3>
                <span className="text-xs text-muted">
                  {card.collateral} → USDC{card.illustrative && " · illustration"}
                </span>
              </div>
              {card.error ? (
                <p className="text-sm text-danger">Could not read this position: {card.error}</p>
              ) : card.health ? (
                <>
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted">Collateral</dt>
                      <dd className="font-mono">{formatUsd(card.health.collateralUsd)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Debt</dt>
                      <dd className="font-mono">{formatUsd(card.health.debtUsd)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Health factor</dt>
                      <dd className={`font-mono ${low ? "text-danger" : ""}`}>{formatHealth(card.health.healthFactor)}</dd>
                    </div>
                  </dl>
                  <div
                    className="relative h-1.5 rounded-full bg-line"
                    role="meter"
                    aria-label={`Margin on ${card.lender}`}
                    aria-valuenow={Math.round(margin * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className={`h-full rounded-full ${low ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.round(margin * 100)}%` }} />
                    {minMargin !== undefined && (
                      <span className="absolute -top-1 h-3.5 w-px bg-danger" style={{ left: `${Math.round(minMargin * 100)}%` }} aria-hidden />
                    )}
                  </div>
                  <p className="text-xs text-muted">
                    Margin before liquidation {formatPercent(margin)}
                    {minMargin !== undefined && <> · the red mark is the guard&apos;s minimum, where the keeper steps in</>}
                  </p>
                </>
              ) : null}
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">Borrowings in progress</span>
                  <span className="font-mono text-muted">{formatUsdc(owed)} USDC owed</span>
                </div>
                {card.lines.length === 0 ? (
                  <p className="text-xs text-faint">No borrowing open on this lender.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {card.lines.map((line) => (
                      <li key={line.lineId.toString()} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate text-muted">
                          <span className="font-mono">#{line.lineId.toString()}</span> {line.memo || "Payment"} ·{" "}
                          {chainByDomain(line.destinationDomain)?.label ?? `domain ${line.destinationDomain}`} · {formatBps(line.rateBps)}
                        </span>
                        <span className="shrink-0 font-mono">{formatUsdc(line.owed)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <section className="card flex flex-col gap-4" aria-label="Protection">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="eyebrow">Shared by all your positions</p>
            <h3 className="text-lg font-semibold">Protection: what the keeper repays with</h3>
          </div>
          <Link href="/app?tab=new" className="text-sm text-muted underline-offset-4 hover:text-foreground hover:underline">
            Manage
          </Link>
        </div>
        <p className="text-sm text-muted">
          The keeper holds no money of its own: it pays gas only. When a position falls under the guard&apos;s minimum it
          repays the debt from your funds, in this order, on the position closest to liquidation.
        </p>
        {protectionError && <p className="text-sm text-danger">Could not read the protection: {protectionError}</p>}
        <ol className="grid gap-3 sm:grid-cols-3">
          <li className="rounded-2xl border border-line p-4">
            <p className="text-xs text-muted">1 · USDC on the account (Arc)</p>
            <p className="mt-1 font-mono text-lg">{reserve ? usd(reserveIn("instant")) : "…"}</p>
            <p className="mt-1 text-xs text-faint">Repaid at once with the public sweep().</p>
          </li>
          <li className="rounded-2xl border border-line p-4">
            <p className="text-xs text-muted">2 · Gateway reserve on Base</p>
            <p className="mt-1 font-mono text-lg">{reserve ? usd(reserveIn("automatic")) : "…"}</p>
            <p className="mt-1 text-xs text-faint">
              Covered by signed standing orders, brought to Arc in seconds.
              {reserve && reserveIn("manual") > 0 && <> {usd(reserveIn("manual"))} more without an order (wallet or Gateway), moved by you.</>}
            </p>
          </li>
          <li className="rounded-2xl border border-line p-4">
            <p className="text-xs text-muted">3 · Defense mandate on Base (CCTP alarm)</p>
            {mandate === undefined ? (
              <p className="mt-1 font-mono text-lg">…</p>
            ) : mandate === null ? (
              <p className="mt-1 text-sm text-muted">No mandate set.</p>
            ) : (
              <>
                <p className="mt-1 font-mono text-sm">{mandate.assets.map((a) => `${a.cap} ${a.symbol}`).join(" then ")}</p>
                <p className="mt-1 text-xs text-faint">
                  Per {mandate.periodHours} h, at most {mandate.maxSlippageBps / 100}% below the Chainlink price. Spent only on a
                  Circle-attested alarm from Arc, and only to repay your account.
                </p>
              </>
            )}
          </li>
        </ol>
      </section>
    </div>
  );
}

/**
 * A position the contracts do not have, shown on the demo account only: a
 * tokenized real-world asset (US Treasury bills) as collateral, to show that
 * a position is the same whatever the collateral.
 */
const RWA_DEMO: Card = {
  key: "rwa-demo",
  lender: "Tokenized T-bills (RWA)",
  collateral: "USYC",
  illustrative: true,
  health: { collateralUsd: 400n * WAD, debtUsd: 120n * WAD, healthFactor: 3n * WAD },
  lines: [],
};
