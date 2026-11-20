import { describe, expect, it } from "vitest";
import { BASE_USDC, DEFENSE_EXECUTOR, WETH, clearMandateCalls, mandateCalls } from "@/lib/defense";

describe("mandateCalls", () => {
  it("approves USDC then WETH, then sets the policy on the executor", () => {
    const calls = mandateCalls({ usdcPerDay: "1", wethPerDay: "0.0002", maxSlippageBps: 100 });
    expect(calls.map((c) => c.to)).toEqual([BASE_USDC, WETH, DEFENSE_EXECUTOR]);
  });
  it("leaves out an asset at 0", () => {
    expect(mandateCalls({ usdcPerDay: "0", wethPerDay: "0.001", maxSlippageBps: 100 }).map((c) => c.to)).toEqual([WETH, DEFENSE_EXECUTOR]);
  });
  it("refuses no asset and a slippage under the executor's floor", () => {
    expect(() => mandateCalls({ usdcPerDay: "0", wethPerDay: "", maxSlippageBps: 100 })).toThrow();
    expect(() => mandateCalls({ usdcPerDay: "1", wethPerDay: "0", maxSlippageBps: 5 })).toThrow();
    expect(() => mandateCalls({ usdcPerDay: "abc", wethPerDay: "0", maxSlippageBps: 100 })).toThrow();
  });
});

describe("clearMandateCalls", () => {
  it("clears the policy and both approvals", () => {
    expect(clearMandateCalls().map((c) => c.to)).toEqual([DEFENSE_EXECUTOR, BASE_USDC, WETH]);
  });
});
