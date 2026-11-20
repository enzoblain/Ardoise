import { describe, expect, it } from "vitest";
import { REPAY_HEADROOM, repayAllCalls, repayAmount, repayCalls } from "@/lib/repay";

describe("repayAmount", () => {
  it("adds headroom to the estimate", () => {
    expect(repayAmount(100_000n, 10_000_000n)).toBe(100_000n + REPAY_HEADROOM);
  });
  it("never sends more than the wallet holds", () => {
    expect(repayAmount(100_000n, 50_000n)).toBe(50_000n);
  });
});

describe("repayCalls", () => {
  it("approves the account, then repays the line", () => {
    const account = "0x6Ce5C993328265425175cE044b0843F74aE98aB3";
    const calls = repayCalls(account, 1n, 110_000n);
    expect(calls).toHaveLength(2);
    expect(calls[1].to).toBe(account);
  });
});

describe("repayAllCalls", () => {
  it("approves the total once, then repays each line", () => {
    const { calls, total } = repayAllCalls("0x6Ce5C993328265425175cE044b0843F74aE98aB3", [
      { lineId: 1n, owed: 100_000n },
      { lineId: 2n, owed: 50_000n },
    ]);
    expect(calls).toHaveLength(3);
    expect(total).toBe(150_000n + 2n * REPAY_HEADROOM);
  });
});
