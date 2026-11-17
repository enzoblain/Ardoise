import { getAddress, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { ardoiseEventsAbi } from "@/lib/abi";
import type { Venue } from "@/lib/ardoise";

const SECONDS_PER_YEAR = 31_536_000n;

/** One row of the statement: a payment and the debt line it opened. */
export interface StatementLine {
  lineId: bigint;
  /** Unix time of the block that recorded the payment. */
  paidAt: number;
  transactionHash: Hex;
  venueAddress: Address;
  /** Venue name, or the address when the venue is unknown to the app. */
  venueName: string;
  /** What the payee receives at least. */
  amount: bigint;
  maxFee: bigint;
  borrowed: bigint;
  rateBps: number;
  destinationDomain: number;
  /** Payee as an EVM address (the bytes32 payee's last 20 bytes). */
  payee: Address;
  memo: string;
  repaid: bigint;
  /** Simple interest at `rateBps` since `paidAt`, as `IArdoise.lines()` estimates it. */
  accruedInterest: bigint;
  /** `borrowed + accruedInterest - repaid`, never negative. */
  owed: bigint;
}

/** The statement and its totals, in USDC units (6 decimals). */
export interface Statement {
  /** Newest first. */
  lines: StatementLine[];
  totalBorrowed: bigint;
  totalInterest: bigint;
  totalOwed: bigint;
}

/**
 * Builds the statement from the account's `Paid` and `LineRepaid` events.
 *
 * Interest is an estimate, like `DebtLine.accruedInterest`: venues compound a
 * variable rate on one debt per position, so the venue's `debtOf` is what is
 * actually owed.
 *
 * @param logs Raw logs emitted by the account; other events are ignored.
 * @param blockTimes Unix time of each block the logs come from.
 * @param venues Known venues, to name them by address.
 * @param now Unix time to accrue interest to.
 * @returns The statement, newest line first.
 * @throws If a log's block has no time in `blockTimes`.
 */
export function buildStatement(
  logs: Log[],
  blockTimes: ReadonlyMap<bigint, number>,
  venues: Venue[],
  now: number,
): Statement {
  const events = parseEventLogs({ abi: ardoiseEventsAbi, logs });
  const names = new Map(venues.map((v) => [v.address.toLowerCase(), v.name]));

  const repaid = new Map<bigint, bigint>();
  for (const e of events) {
    if (e.eventName === "LineRepaid") {
      repaid.set(e.args.lineId, (repaid.get(e.args.lineId) ?? 0n) + e.args.amount);
    }
  }

  const lines: StatementLine[] = [];
  for (const e of events) {
    if (e.eventName !== "Paid") continue;
    const paidAt = blockTimes.get(e.blockNumber);
    if (paidAt === undefined) throw new Error(`No time for block ${e.blockNumber}`);
    const elapsed = BigInt(Math.max(0, now - paidAt));
    const accruedInterest = (e.args.borrowed * BigInt(e.args.rateBps) * elapsed) / (10_000n * SECONDS_PER_YEAR);
    const lineRepaid = repaid.get(e.args.lineId) ?? 0n;
    const due = e.args.borrowed + accruedInterest - lineRepaid;
    lines.push({
      lineId: e.args.lineId,
      paidAt,
      transactionHash: e.transactionHash,
      venueAddress: e.args.venue,
      venueName: names.get(e.args.venue.toLowerCase()) ?? e.args.venue,
      amount: e.args.amount,
      maxFee: e.args.maxFee,
      borrowed: e.args.borrowed,
      rateBps: e.args.rateBps,
      destinationDomain: e.args.destinationDomain,
      payee: getAddress(`0x${e.args.payee.slice(-40)}`),
      memo: e.args.memo,
      repaid: lineRepaid,
      accruedInterest,
      owed: due > 0n ? due : 0n,
    });
  }
  lines.sort((a, b) => (a.lineId < b.lineId ? 1 : -1));

  return {
    lines,
    totalBorrowed: lines.reduce((sum, l) => sum + l.borrowed, 0n),
    totalInterest: lines.reduce((sum, l) => sum + l.accruedInterest, 0n),
    totalOwed: lines.reduce((sum, l) => sum + l.owed, 0n),
  };
}
