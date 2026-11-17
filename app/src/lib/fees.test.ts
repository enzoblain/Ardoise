import { describe, expect, it } from "vitest";
import { computeMaxFee, type IrisFee } from "@/lib/fees";

// Iris answer for Arc (26) -> Base (6) on mainnet, with forward=true.
const ARC_TO_BASE: IrisFee[] = [
  { finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 53077, med: 53482, high: 54508 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 53077, med: 53482, high: 54508 } },
];

describe("computeMaxFee", () => {
  it("adds the high forwarder estimate to a zero protocol fee", () => {
    expect(computeMaxFee(ARC_TO_BASE, 20_000_000n)).toBe(54_508n);
  });

  it("charges the protocol fee on the burned amount, fee included", () => {
    const fees: IrisFee[] = [{ finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 0, med: 0, high: 50_000 } }];
    const amount = 20_000_000n;
    const maxFee = computeMaxFee(fees, amount);
    // CCTP takes 1.3 bps of what is burned; what is left must cover amount + forwarder.
    const burned = amount + maxFee;
    const protocol = (burned * 13n + 99_999n) / 100_000n;
    expect(burned - protocol).toBeGreaterThanOrEqual(amount + 50_000n);
    expect(maxFee).toBe(52_607n);
  });

  it("rounds fractional bps exactly and never down", () => {
    // 1.1 * 100 is 110.00000000000001 in floating point.
    expect(computeMaxFee([{ finalityThreshold: 1000, minimumFee: 1.1 }], 100_000_000n)).toBe(11_002n);
    expect(computeMaxFee([{ finalityThreshold: 1000, minimumFee: 1.3 }], 1n)).toBe(1n);
  });

  it("fails without a fast-transfer entry", () => {
    expect(() => computeMaxFee([{ finalityThreshold: 2000, minimumFee: 0 }], 1n)).toThrow();
  });
});
