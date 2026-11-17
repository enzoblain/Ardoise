import { isAddress, zeroAddress } from "viem";
import {
  NO_DEBT_HEALTH,
  PaymentFailed,
  WAD,
  payeeToBytes32,
  usdToUsdc,
  usdcToUsd,
  type ArdoiseClient,
  type DebtLine,
  type Health,
  type PaymentQuote,
  type PaymentRequest,
  type Venue,
} from "@/lib/ardoise";

/** The user's collateral position on one venue. */
export interface MockPosition {
  collateralUsd: bigint;
  debtUsd: bigint;
  /** Share of the collateral value that can be borrowed before liquidation (WAD). */
  liquidationThreshold: bigint;
}

/** Starting state of a mock account. */
export interface MockOptions {
  /** Position per venue id. A venue without a position cannot be borrowed from. */
  positions: Record<string, MockPosition>;
  minHealthFactor: bigint;
  perPaymentCap: bigint;
  dailyCap: bigint;
}

// A small demo account: $250 of cirBTC on each venue, $100 already borrowed
// on Aave V4. Thresholds are the real ones for cirBTC: 78% collateral factor
// on the Aave V4 Main Spoke, 86% LLTV on the Morpho market. The guard keeps
// the health factor above 1.25.
export const DEFAULT_MOCK: MockOptions = {
  positions: {
    "aave-v4": { collateralUsd: 250n * WAD, debtUsd: 100n * WAD, liquidationThreshold: (78n * WAD) / 100n },
    morpho: { collateralUsd: 250n * WAD, debtUsd: 0n, liquidationThreshold: (86n * WAD) / 100n },
  },
  minHealthFactor: (125n * WAD) / 100n,
  perPaymentCap: 100_000_000n,
  dailyCap: 300_000_000n,
};

/**
 * In-browser stand-in for an Ardoise account, venues and guard. It applies
 * the rules `IArdoise.pay()` documents, in the same order: payee, caps, best
 * venue, guard. Venue rates come from the caller (real reads); positions,
 * caps and debt lines are simulated.
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

  function quote(request: PaymentRequest): PaymentQuote {
    const borrow = request.amount + request.maxFee;
    // IArdoise.bestVenue: lowest rate among the venues that can lend `borrow`.
    const venue = venues
      .filter((v) => positions.has(v.id) && v.available >= borrow)
      .sort((a, b) => a.rateBps - b.rateBps)[0];
    const position = venue && positionOf(venue.id);
    const base: PaymentQuote = {
      borrow,
      venue,
      healthBefore: venue && health(venue.id),
      healthAfter: position && healthFactor(position, position.debtUsd + usdcToUsd(borrow)),
      minHealthFactor: options.minHealthFactor,
    };

    // Errors in the order pay() checks them.
    if (!isAddress(request.payee) || request.payee === zeroAddress) {
      return { ...base, error: { code: "InvalidPayee" } };
    }
    const remaining = minBigint(options.perPaymentCap, options.dailyCap - spentToday);
    if (borrow > remaining) {
      return { ...base, error: { code: "CapExceeded", remaining: remaining > 0n ? remaining : 0n } };
    }
    if (!venue || !position) return { ...base, error: { code: "NoVenueAvailable" } };

    // IGuard.checkMargin(user, venue, borrow): the largest borrow on this
    // venue that keeps the minimum health factor.
    const maxDebt = (position.collateralUsd * position.liquidationThreshold) / options.minHealthFactor;
    const allowed = maxDebt > position.debtUsd ? usdToUsdc(maxDebt - position.debtUsd) : 0n;
    if (allowed < borrow) return { ...base, error: { code: "PaymentRefused", allowed } };
    return base;
  }

  return {
    simulated: true,
    health: async (venueId) => health(venueId),
    minHealthFactor: async () => options.minHealthFactor,
    caps: async () => ({ perPayment: options.perPaymentCap, daily: options.dailyCap, spentToday }),
    lines: async () => [...lines],
    quote: async (request) => quote(request),
    pay: async (request) => {
      const q = quote(request);
      if (q.error) throw new PaymentFailed(q.error);
      const venue = q.venue!;
      positionOf(venue.id).debtUsd += usdcToUsd(q.borrow);
      spentToday += q.borrow;
      const line: DebtLine = {
        id: BigInt(lines.length + 1),
        venue,
        principal: q.borrow,
        repaid: 0n,
        accruedInterest: 0n,
        rateBps: venue.rateBps,
        destinationDomain: request.destinationDomain,
        openedAt: Math.floor(Date.now() / 1000),
        payee: payeeToBytes32(request.payee),
        memo: request.memo,
      };
      lines.push(line);
      return line;
    },
  };
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
