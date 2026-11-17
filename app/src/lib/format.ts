import { formatUnits } from "viem";

/**
 * Formats a USDC amount for display, with at least two decimals.
 *
 * @param units Amount in USDC units (6 decimals).
 * @returns For example "20.00" or "0.054508".
 */
export function formatUsdc(units: bigint): string {
  const [whole, fraction = ""] = formatUnits(units, 6).split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/**
 * Formats a rate in basis points as a percentage.
 *
 * @param bps Rate in basis points.
 * @returns For example "3.10%".
 */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Formats a share between 0 and 1 as a whole percentage.
 *
 * @param share Value between 0 and 1.
 * @returns For example "49%".
 */
export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}
