import { network, type PayoutChain } from "@/lib/network";

/** One entry of Iris `GET /v2/burn/USDC/fees/{source}/{destination}`. */
export interface IrisFee {
  finalityThreshold: number;
  /** Protocol fee in basis points of the burned amount (may be fractional). */
  minimumFee: number;
  /** Forwarder fee in USDC units (6 decimals), when `forward=true`. */
  forwardFee?: { low: number; med: number; high: number };
}

// Fast transfers use the lowest finality threshold Iris lists.
const FAST_FINALITY = 1000;
// Protocol fees are handled in parts per 1e10, i.e. millionths of a basis
// point, so fractional bps stay exact integers.
const PARTS = 10_000_000_000n;

/**
 * Highest fee a fast CCTP transfer with Circle's forwarder may take, so
 * `pay()` can borrow it on top of `amount`.
 *
 * `pay()` burns `amount + maxFee` and CCTP takes its protocol fee on the
 * burned amount, so the fee is solved for that total: with rate `r`,
 * `protocol = ceil((amount + forward) * r / (1 - r))`. The forwarder part
 * uses Iris's `high` estimate: whatever `maxFee` does not use reaches the
 * payee.
 *
 * @param fees Fee entries returned by Iris for the route.
 * @param amount Amount the payee must receive, in USDC units (6 decimals).
 * @returns The maximum fee in USDC units.
 * @throws If Iris lists no fast-transfer entry.
 */
export function computeMaxFee(fees: IrisFee[], amount: bigint): bigint {
  const fast = fees.find((f) => f.finalityThreshold === FAST_FINALITY);
  if (!fast) throw new Error("Circle lists no fast transfer for this route");
  const forward = BigInt(fast.forwardFee?.high ?? 0);
  // Round the float to a whole number of parts first: 1.1 * 1e6 must not
  // become 1100000.0000000002.
  const rate = BigInt(Math.round(fast.minimumFee * 1_000_000));
  const protocol = ceilDiv((amount + forward) * rate, PARTS - rate);
  return protocol + forward;
}

/**
 * Fetches Circle's fee schedule for payments from Arc to `destination`.
 *
 * The schedule does not depend on the amount, so callers fetch it once per
 * route and run `computeMaxFee` locally.
 *
 * @param destination Chain the payee is on.
 * @returns `null` for a payment on Arc (a plain transfer, no fee), otherwise
 *   the fee entries.
 * @throws If Iris cannot be reached.
 */
export async function fetchFeeSchedule(destination: PayoutChain): Promise<IrisFee[] | null> {
  if (destination.cctpDomain === network.arc.cctpDomain) return null;
  const url = `${network.irisUrl}/v2/burn/USDC/fees/${network.arc.cctpDomain}/${destination.cctpDomain}?forward=true`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Circle fee quote failed (${res.status})`);
  return (await res.json()) as IrisFee[];
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
