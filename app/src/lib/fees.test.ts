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

  it("rounds a fractional protocol fee up", () => {
    const fees: IrisFee[] = [{ finalityThreshold: 1000, minimumFee: 1.3 }];
    // 1.3 bps of 20 USDC = 0.0026 USDC = 2600 units.
    expect(computeMaxFee(fees, 20_000_000n)).toBe(2_600n);
    // 1.3 bps of 1 unit rounds up to 1 unit.
    expect(computeMaxFee(fees, 1n)).toBe(1n);
  });

  it("fails without a fast-transfer entry", () => {
    expect(() => computeMaxFee([{ finalityThreshold: 2000, minimumFee: 0 }], 1n)).toThrow();
  });
});
