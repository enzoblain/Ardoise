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

/** Starting state of a mock account. */
export interface MockOptions {
  collateralUsd: bigint;
  debtUsd: bigint;
  /** Share of the collateral value that can be borrowed before liquidation (WAD). */
  liquidationThreshold: bigint;
  minHealthFactor: bigint;
  perPaymentCap: bigint;
  dailyCap: bigint;
}

// A small demo position: $250 of cirBTC with $100 already borrowed, Aave
// V4's 78% collateral factor for cirBTC, and a guard that keeps the health
// factor above 1.25.
export const DEFAULT_MOCK: MockOptions = {
  collateralUsd: 250n * WAD,
  debtUsd: 100n * WAD,
  liquidationThreshold: (78n * WAD) / 100n,
  minHealthFactor: (125n * WAD) / 100n,
  perPaymentCap: 100_000_000n,
  dailyCap: 300_000_000n,
};

/**
 * In-browser stand-in for an Ardoise account, venues and guard. It applies
 * the rules `IArdoise.pay()` documents, in the same order: payee, caps, best
 * venue, guard. Venue rates come from the caller (real reads); the position,
 * caps and debt lines are simulated.
 *
 * @param venues Venues to choose from.
 * @param options Starting position, guard threshold and caps.
 * @returns A client whose state lives in memory until the page reloads.
 */
export function createMockArdoise(venues: Venue[], options: MockOptions = DEFAULT_MOCK): ArdoiseClient {
  let debtUsd = options.debtUsd;
  let spentToday = 0n;
  const lines: DebtLine[] = [];

  const healthFactor = (debt: bigint) =>
    debt === 0n ? NO_DEBT_HEALTH : (options.collateralUsd * options.liquidationThreshold) / debt;
  const health = (): Health => ({
    healthFactor: healthFactor(debtUsd),
    collateralUsd: options.collateralUsd,
    debtUsd,
  });

  function quote(request: PaymentRequest): PaymentQuote {
    const borrow = request.amount + request.maxFee;
    const base: PaymentQuote = { borrow, healthBefore: health(), minHealthFactor: options.minHealthFactor };

    if (!isAddress(request.payee) || request.payee === zeroAddress) {
      return { ...base, error: { code: "InvalidPayee" } };
    }
    const remaining = minBigint(options.perPaymentCap, options.dailyCap - spentToday);
    if (borrow > remaining) {
      return { ...base, error: { code: "CapExceeded", remaining: remaining > 0n ? remaining : 0n } };
    }
    const venue = venues
      .filter((v) => v.available >= borrow)
      .sort((a, b) => a.rateBps - b.rateBps)[0];
    if (!venue) return { ...base, error: { code: "NoVenueAvailable" } };

    const healthAfter = healthFactor(debtUsd + usdcToUsd(borrow));
    // IGuard.checkMargin: the largest borrow that keeps the minimum health factor.
    const maxDebt = (options.collateralUsd * options.liquidationThreshold) / options.minHealthFactor;
    const allowed = maxDebt > debtUsd ? usdToUsdc(maxDebt - debtUsd) : 0n;
    if (allowed < borrow) {
      return { ...base, venue, healthAfter, error: { code: "PaymentRefused", allowed } };
    }
    return { ...base, venue, healthAfter };
  }

  return {
    simulated: true,
    health: async () => health(),
    minHealthFactor: async () => options.minHealthFactor,
    caps: async () => ({ perPayment: options.perPaymentCap, daily: options.dailyCap, spentToday }),
    lines: async () => [...lines],
    quote: async (request) => quote(request),
    pay: async (request) => {
      const q = quote(request);
      if (q.error) throw new PaymentFailed(q.error);
      const venue = q.venue!;
      debtUsd += usdcToUsd(q.borrow);
      spentToday += q.borrow;
      const id = BigInt(lines.length + 1);
      lines.push({
        id,
        venue,
        principal: q.borrow,
        repaid: 0n,
        accruedInterest: 0n,
        rateBps: venue.rateBps,
        destinationDomain: request.destinationDomain,
        openedAt: Math.floor(Date.now() / 1000),
        payee: payeeToBytes32(request.payee),
        memo: request.memo,
      });
      return id;
    },
  };
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
