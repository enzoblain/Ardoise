import { describe, expect, it } from "vitest";
import { NO_DEBT_HEALTH, WAD, marginFromHealth, payeeToBytes32 } from "@/lib/ardoise";

describe("marginFromHealth", () => {
  it("is 1 - 1/HF", () => {
    expect(marginFromHealth(2n * WAD)).toBeCloseTo(0.5);
    expect(marginFromHealth((195n * WAD) / 100n)).toBeCloseTo(0.4872, 3);
  });

  it("is 1 without debt and 0 at or below liquidation", () => {
    expect(marginFromHealth(NO_DEBT_HEALTH)).toBe(1);
    expect(marginFromHealth(WAD)).toBe(0);
    expect(marginFromHealth(WAD / 2n)).toBe(0);
  });
});

describe("payeeToBytes32", () => {
  it("left-pads an address to 32 bytes", () => {
    expect(payeeToBytes32("0xdf41621b35b0c3512d1177DE1423747900fC7a77")).toBe(
      "0x000000000000000000000000df41621b35b0c3512d1177de1423747900fc7a77",
    );
  });

  it("rejects an invalid address", () => {
    expect(() => payeeToBytes32("0x1234")).toThrow();
  });
});
