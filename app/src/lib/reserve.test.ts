import { describe, expect, it } from "vitest";
import { coveredByOrders } from "@/lib/reserve";

const usdc = (x: number) => BigInt(Math.round(x * 1e6));

describe("coveredByOrders", () => {
  it("counts an order only when the balance covers its value and Gateway's fee", () => {
    // The live case: one 0.40 USDC order and 0.399 USDC left in Gateway.
    expect(coveredByOrders(usdc(0.399), [usdc(0.4)])).toBe(0n);
    expect(coveredByOrders(usdc(0.42), [usdc(0.4)])).toBe(0n);
    expect(coveredByOrders(usdc(0.43), [usdc(0.4)])).toBe(usdc(0.4));
  });

  it("takes orders smallest first until the balance runs out", () => {
    // 1 USDC: 0.40 + fee, then 0.40 + fee = 0.86; a third 0.40 does not fit.
    expect(coveredByOrders(usdc(1), [usdc(0.4), usdc(0.4), usdc(0.4)])).toBe(usdc(0.8));
    expect(coveredByOrders(usdc(1), [usdc(5), usdc(0.4)])).toBe(usdc(0.4));
  });

  it("is zero without orders", () => {
    expect(coveredByOrders(usdc(30), [])).toBe(0n);
  });
});
