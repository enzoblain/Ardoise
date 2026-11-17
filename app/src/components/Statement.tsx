"use client";

import { useEffect, useState } from "react";
import type { ArdoiseClient, Venue } from "@/lib/ardoise";
import { formatBps, formatUsdc } from "@/lib/format";
import { chainByDomain } from "@/lib/network";
import { buildStatement, type Statement as StatementData } from "@/lib/statement";

// Interest accrues every second; refreshing the estimate this often is enough
// to see it move without re-reading events.
const TICK_MS = 10_000;

/**
 * Line-by-line statement of the account, built from its `Paid` and
 * `LineRepaid` events: amount, venue, rate, payee, memo and interest accrued
 * so far.
 *
 * @param props.account Account to read events from.
 * @param props.venues Known venues, to name them.
 * @param props.version Changes after each payment, to re-read the events.
 */
export function Statement({ account, venues, version }: { account: ArdoiseClient; venues: Venue[]; version: number }) {
  const [events, setEvents] = useState<Awaited<ReturnType<ArdoiseClient["events"]>>>();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    account
      .events()
      .then((e) => current && setEvents(e))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [account, version]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (error) return <p className="text-sm text-red-600">Could not read the statement: {error}</p>;
  if (!events) return null;

  let statement: StatementData;
  try {
    statement = buildStatement(events.logs, events.blockTimes, venues, now);
  } catch (e) {
    return <p className="text-sm text-red-600">Could not read the statement: {(e as Error).message}</p>;
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="statement-title">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="statement-title" className="text-xl font-semibold">
          Statement
        </h2>
        <div className="text-right">
          <div className="text-xl font-semibold tabular-nums">{formatUsdc(statement.totalOwed)} USDC</div>
          <div className="text-xs opacity-60">
            owed, of which {formatUsdc(statement.totalInterest)} interest
          </div>
        </div>
      </div>

      {statement.lines.length === 0 ? (
        <p className="text-sm opacity-70">No payments yet.</p>
      ) : (
        <ol className="flex flex-col divide-y divide-black/10 dark:divide-white/10">
          {statement.lines.map((line) => {
            const chain = chainByDomain(line.destinationDomain);
            return (
              <li key={line.lineId.toString()} className="flex flex-col gap-1 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">{line.memo || "Payment"}</span>
                  <span className="font-semibold tabular-nums">{formatUsdc(line.amount)} USDC</span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 text-sm opacity-70">
                  <span>
                    To <span className="font-mono">{shortAddress(line.payee)}</span> on{" "}
                    {chain?.label ?? `CCTP domain ${line.destinationDomain}`} · {formatDate(line.paidAt)}
                  </span>
                  <span>#{line.lineId.toString()}</span>
                </div>
                <div className="text-sm opacity-70">
                  Borrowed {formatUsdc(line.borrowed)} from {line.venueName} at {formatBps(line.rateBps)}
                  {line.maxFee > 0n && <> (incl. {formatUsdc(line.maxFee)} CCTP fee)</>} · interest{" "}
                  <span className="tabular-nums">{formatUsdc(line.accruedInterest)}</span>
                  {line.repaid > 0n && <> · repaid {formatUsdc(line.repaid)}</>} ·{" "}
                  <span className={line.owed === 0n ? "text-emerald-600 dark:text-emerald-400" : ""}>
                    {line.owed === 0n ? "repaid" : `owed ${formatUsdc(line.owed)}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-xs opacity-60">
        Interest is an estimate at each line&apos;s opening rate; the lending venue&apos;s own debt figure is what is
        actually owed.
      </p>
    </section>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
