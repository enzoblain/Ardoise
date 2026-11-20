"use client";

import { useEffect, useState } from "react";
import type { ArdoiseClient, Venue } from "@/lib/ardoise";
import { formatBps, formatUsdc } from "@/lib/format";
import { chainByDomain } from "@/lib/network";
import { buildStatement, type StatementLine } from "@/lib/statement";

/**
 * The owner's positions still open: every payment line not fully repaid,
 * with what is still owed on it, newest first.
 *
 * @param props.account Account to read events from (demo or on-chain).
 * @param props.venues Known venues, to name them.
 * @param props.version Bumped after each payment, to read again.
 */
export function OpenPositions({ account, venues, version }: { account: ArdoiseClient; venues: Venue[]; version: number }) {
  const [open, setOpen] = useState<{ lines: StatementLine[]; owed: bigint }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    account
      .events()
      .then((e) => {
        if (!current) return;
        const statement = buildStatement(e.account, e.logs, e.blockTimes, venues, Math.floor(Date.now() / 1000));
        setOpen({ lines: statement.lines.filter((l) => l.owed > 0n), owed: statement.totalOwed });
        setError(undefined);
      })
      .catch((e: Error) => current && setError(e.message.split("\n")[0]));
    return () => {
      current = false;
    };
  }, [account, venues, version]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="eyebrow">In progress</p>
          <h2 className="text-lg font-semibold">My open positions</h2>
        </div>
        {open && (
          <div className="text-right">
            <div className="text-xl font-semibold tabular-nums">{formatUsdc(open.owed)} USDC</div>
            <div className="text-xs text-faint">
              owed on {open.lines.length} {open.lines.length === 1 ? "position" : "positions"}
            </div>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-danger">Could not read your positions: {error}</p>}
      {!open && !error && <p className="text-sm text-muted">Reading your positions…</p>}
      {open && open.lines.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line-strong p-6 text-center text-sm text-muted">
          No open position: every payment is repaid.
        </p>
      )}
      {open && open.lines.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {open.lines.map((line) => {
            const chain = chainByDomain(line.destinationDomain);
            return (
              <li key={line.lineId.toString()} className="flex flex-col gap-2 rounded-2xl border border-line p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">
                    <span className="mr-2 font-mono text-xs text-muted">#{line.lineId.toString()}</span>
                    {line.memo || "Payment"}
                  </span>
                  <span className="font-semibold tabular-nums">{formatUsdc(line.owed)} USDC</span>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted">Lender</dt>
                    <dd className="text-foreground">{line.venueName}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Rate</dt>
                    <dd className="font-mono text-foreground">{formatBps(line.rateBps)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Paid on</dt>
                    <dd className="text-foreground">{chain?.label ?? `domain ${line.destinationDomain}`}</dd>
                  </div>
                </dl>
                <p className="text-xs text-faint">
                  Borrowed {formatUsdc(line.borrowed)} · interest {formatUsdc(line.accruedInterest)}
                  {line.repaid > 0n && <> · repaid {formatUsdc(line.repaid)}</>} ·{" "}
                  {new Date(line.paidAt * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
