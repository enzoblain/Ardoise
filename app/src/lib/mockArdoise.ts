import {
  encodeAbiParameters,
  encodeEventTopics,
  isAddress,
  keccak256,
  parseAbiParameters,
  toHex,
  zeroAddress,
  type Address,
  type Log,
} from "viem";
import { ardoiseEventsAbi } from "@/lib/abi";
import {
  NO_DEBT_HEALTH,
  PaymentFailed,
  WAD,
  payeeToBytes32,
  usdToUsdc,
  venueUsable,
  usdcToUsd,
  type ArdoiseClient,
  type DebtLine,
  type Health,
  type PaymentQuote,
  type PaymentRequest,
  type Venue,
  type VenueOption,
} from "@/lib/ardoise";

/** The user's collateral position on one venue. */
export interface MockPosition {
  collateralUsd: bigint;
  debtUsd: bigint;
  /** Share of the collateral value that can be borrowed before liquidation (WAD). */
  liquidationThreshold: bigint;
}

/** A payment made before the page opened, replayed to seed the account. */
export interface MockPayment {
  /** Days before now; 0 counts toward today's cap like a new payment. */
  daysAgo: number;
  venueId: string;
  amount: bigint;
  maxFee: bigint;
  destinationDomain: number;
  payee: Address;
  memo: string;
}

/** Starting state of a mock account. */
export interface MockOptions {
  /** Position per venue id. A venue without a position cannot be borrowed from. */
  positions: Record<string, MockPosition>;
  /** Past payments; their borrowed amounts add to the positions' debt. */
  history: MockPayment[];
  minHealthFactor: bigint;
  perPaymentCap: bigint;
  dailyCap: bigint;
}

// The project's dedicated test wallet, already public in docs/roadmap.md.
const DEMO_PAYEE: Address = "0xdf41621b35b0c3512d1177DE1423747900fC7a77";

// A small demo account: $250 of cirBTC on each venue and two past payments
// on Aave V4 that add up to $100 of debt. Thresholds are the real ones for
// cirBTC: 78% collateral factor on the Aave V4 Main Spoke, 86% LLTV on the
// Morpho market. The guard keeps the health factor above 1.25, the minimum
// suggested for deployment (roadmap B1, MarginGuard tests).
export const DEFAULT_MOCK: MockOptions = {
  positions: {
    "aave-v4": { collateralUsd: 250n * WAD, debtUsd: 0n, liquidationThreshold: (78n * WAD) / 100n },
    morpho: { collateralUsd: 250n * WAD, debtUsd: 0n, liquidationThreshold: (86n * WAD) / 100n },
  },
  history: [
    {
      daysAgo: 3,
      venueId: "aave-v4",
      amount: 59_946_052n,
      maxFee: 53_948n,
      destinationDomain: 6,
      payee: DEMO_PAYEE,
      memo: "Design invoice #41",
    },
    { daysAgo: 1, venueId: "aave-v4", amount: 40_000_000n, maxFee: 0n, destinationDomain: 26, payee: DEMO_PAYEE, memo: "Hosting, November" },
  ],
  minHealthFactor: (125n * WAD) / 100n,
  perPaymentCap: 100_000_000n,
  dailyCap: 300_000_000n,
};

/**
 * In-memory stand-in for an Ardoise account, venues and guard, used by the
 * unit tests. It applies the rules `IArdoise.pay()` documents, in the same
 * order: payee, caps, best venue, guard. Venue rates come from the caller;
 * positions, caps and debt lines are simulated.
 *
 * @param venues Venues to choose from.
 * @param options Starting positions, guard threshold and caps.
 * @returns A client whose state lives in memory until the page reloads.
 */
export function createMockArdoise(venues: Venue[], options: MockOptions = DEFAULT_MOCK): ArdoiseClient {
  const positions = new Map(
    Object.entries(options.positions).map(([id, p]) => [id, { ...p }] as const),
  );
  let spentToday = 0n;
  const lines: DebtLine[] = [];
  const logs: Log[] = [];
  const blockTimes = new Map<bigint, number>();

  const healthFactor = (p: MockPosition, debt: bigint) =>
    debt === 0n ? NO_DEBT_HEALTH : (p.collateralUsd * p.liquidationThreshold) / debt;
  const health = (venueId: string): Health => {
    const p = positionOf(venueId);
    return { healthFactor: healthFactor(p, p.debtUsd), collateralUsd: p.collateralUsd, debtUsd: p.debtUsd };
  };
  function positionOf(venueId: string): MockPosition {
    const p = positions.get(venueId);
    if (!p) throw new Error(`No position on ${venueId}`);
    return p;
  }

  // IGuard.checkMargin(user, venue, borrow): the largest borrow on this venue
  // that keeps the minimum health factor.
  function allowedOn(position: MockPosition): bigint {
    const maxDebt = (position.collateralUsd * position.liquidationThreshold) / options.minHealthFactor;
    return maxDebt > position.debtUsd ? usdToUsdc(maxDebt - position.debtUsd) : 0n;
  }

  function quote(request: PaymentRequest): PaymentQuote {
    const borrow = request.amount + request.maxFee;
    // A venue without a position is still offered; the guard allows nothing there.
    const venueOptions: VenueOption[] = venues
      .filter((v) => v.borrowable !== false)
      .map((venue) => {
        const position = positions.get(venue.id);
        return {
          venue,
          liquidityOk: venue.available >= borrow,
          allowed: position ? allowedOn(position) : 0n,
          healthBefore: position && health(venue.id),
          healthAfter: position && healthFactor(position, position.debtUsd + usdcToUsd(borrow)),
        };
      });
    // IArdoise.bestVenue: lowest rate among the venues that can lend all of `borrow`,
    // else the one allowing the most.
    const byRate = venueOptions.filter((o) => o.liquidityOk).sort((a, b) => a.venue.rateBps - b.venue.rateBps);
    const recommended = (
      byRate.find((o) => venueUsable(o, borrow)) ??
      byRate.reduce<VenueOption | undefined>((best, o) => (!best || (o.allowed ?? 0n) > (best.allowed ?? 0n) ? o : best), undefined)
    )?.venue;
    const chosen = request.venueId === undefined ? recommended : venueOptions.find((o) => o.venue.id === request.venueId)?.venue;
    const option = chosen && venueOptions.find((o) => o.venue.id === chosen.id);
    const base: PaymentQuote = {
      borrow,
      venue: chosen,
      recommended,
      options: venueOptions,
      healthBefore: option?.healthBefore,
      healthAfter: option?.healthAfter,
      minHealthFactor: options.minHealthFactor,
    };

    // Errors in the order pay() and payVia() check them.
    if (request.venueId !== undefined && !chosen) return { ...base, error: { code: "UnknownVenue" } };
    if (request.amount === 0n) return { ...base, error: { code: "ZeroAmount" } };
    if (request.destinationDomain === ARC_DOMAIN && request.maxFee > 0n) return { ...base, error: { code: "FeeOnArc" } };
    if (!isAddress(request.payee) || request.payee === zeroAddress) {
      return { ...base, error: { code: "InvalidPayee" } };
    }
    const remaining = minBigint(options.perPaymentCap, options.dailyCap - spentToday);
    if (borrow > remaining) {
      return { ...base, error: { code: "CapExceeded", remaining: remaining > 0n ? remaining : 0n } };
    }
    if (!option || !option.liquidityOk) return { ...base, error: { code: "NoVenueAvailable" } };
    const allowed = option.allowed ?? 0n;
    if (allowed < borrow) return { ...base, error: { code: "PaymentRefused", allowed } };
    return base;
  }

  // Applies a payment to the position and emits the Paid log pay() would.
  function record(request: PaymentRequest, venue: Venue, borrowed: bigint, at: number): DebtLine {
    positionOf(venue.id).debtUsd += usdcToUsd(borrowed);
    const line: DebtLine = {
      id: BigInt(lines.length + 1),
      venue,
      principal: borrowed,
      repaid: 0n,
      accruedInterest: 0n,
      rateBps: venue.rateBps,
      destinationDomain: request.destinationDomain,
      openedAt: at,
      payee: payeeToBytes32(request.payee),
      memo: request.memo,
    };
    lines.push(line);
    const blockNumber = BigInt(logs.length + 1);
    blockTimes.set(blockNumber, at);
    logs.push({
      address: MOCK_ACCOUNT,
      topics: encodeEventTopics({ abi: ardoiseEventsAbi, eventName: "Paid", args: { lineId: line.id, venue: venue.address } }) as Log["topics"],
      data: encodeAbiParameters(PAID_DATA, [
        request.amount,
        request.maxFee,
        borrowed,
        venue.rateBps,
        request.destinationDomain,
        line.payee,
        request.memo,
      ]),
      blockNumber,
      blockHash: keccak256(toHex(`block ${blockNumber}`)),
      transactionHash: keccak256(toHex(`payment ${line.id}`)),
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    });
    return line;
  }

  const now = Math.floor(Date.now() / 1000);
  for (const past of options.history) {
    const venue = venues.find((v) => v.id === past.venueId);
    if (!venue || !positions.has(venue.id)) continue;
    const borrowed = past.amount + past.maxFee;
    if (past.daysAgo === 0) spentToday += borrowed;
    record(past, venue, borrowed, now - past.daysAgo * 86_400);
  }

  return {
    simulated: true,
    health: async (venueId) => health(venueId),
    minHealthFactor: async () => options.minHealthFactor,
    // The deployed MarginGuard's target.
    targetHealthFactor: async () => (3n * WAD) / 2n,
    simulatedDropBps: async () => 0,
    caps: async () => ({ perPayment: options.perPaymentCap, daily: options.dailyCap, spentToday }),
    lines: async () => [...lines],
    quote: async (request) => quote(request),
    events: async () => ({ account: MOCK_ACCOUNT, logs: [...logs], blockTimes: new Map(blockTimes) }),
    pay: async (request) => {
      const q = quote(request);
      if (q.error) throw new PaymentFailed(q.error);
      spentToday += q.borrow;
      return record(request, q.venue!, q.borrow, Math.floor(Date.now() / 1000));
    },
  };
}

// IArdoise.ARC_DOMAIN: a payment there is a plain USDC transfer.
const ARC_DOMAIN = 26;
// Stand-in address for the account that emits the mock's logs.
const MOCK_ACCOUNT: Address = "0x000000000000000000000000000000000000a4d0";
// Non-indexed fields of IArdoise.Paid, in order.
const PAID_DATA = parseAbiParameters("uint256, uint256, uint256, uint32, uint32, bytes32, string");

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
