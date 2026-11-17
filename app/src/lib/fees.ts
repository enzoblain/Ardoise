import { network, type PayoutChain } from "@/lib/network";

/** One entry of Iris `GET /v2/burn/USDC/fees/{source}/{destination}`. */
export interface IrisFee {
  finalityThreshold: number;
  /** Protocol fee in basis points of the amount (may be fractional). */
  minimumFee: number;
  /** Forwarder fee in USDC units (6 decimals), when `forward=true`. */
  forwardFee?: { low: number; med: number; high: number };
}

// Fast transfers use the lowest finality threshold Iris lists.
const FAST_FINALITY = 1000;

/**
 * Highest fee a fast CCTP transfer with Circle's forwarder may take on
 * `amount`, so `pay()` can borrow it on top of the payment.
 *
 * Uses the `high` forwarder estimate: the unused part of `maxFee` still
 * reaches the payee, so overestimating costs nothing but a little debt.
 *
 * @param fees Fee entries returned by Iris.
 * @param amount Payment amount in USDC units (6 decimals).
 * @returns The maximum fee in USDC units.
 * @throws If Iris lists no fast-transfer entry.
 */
export function computeMaxFee(fees: IrisFee[], amount: bigint): bigint {
  const fast = fees.find((f) => f.finalityThreshold === FAST_FINALITY);
  if (!fast) throw new Error("Circle lists no fast transfer for this route");
  // Basis points with two decimals, rounded up so the fee is never short.
  const hundredthsOfBps = BigInt(Math.ceil(fast.minimumFee * 100));
  const protocolFee = (amount * hundredthsOfBps + 999_999n) / 1_000_000n;
  return protocolFee + BigInt(fast.forwardFee?.high ?? 0);
}

/**
 * Asks Circle for the maximum fee of a payment to `destination`.
 *
 * @param destination Chain the payee is on.
 * @param amount Payment amount in USDC units (6 decimals).
 * @returns 0 for a payment on Arc (a plain transfer), otherwise the maximum
 *   CCTP fee in USDC units.
 * @throws If Iris cannot be reached or lists no fast transfer.
 */
export async function quoteMaxFee(destination: PayoutChain, amount: bigint): Promise<bigint> {
  if (destination.cctpDomain === network.arc.cctpDomain) return 0n;
  const url = `${network.irisUrl}/v2/burn/USDC/fees/${network.arc.cctpDomain}/${destination.cctpDomain}?forward=true`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Circle fee quote failed (${res.status})`);
  return computeMaxFee((await res.json()) as IrisFee[], amount);
}
