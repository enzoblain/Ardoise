import { describe, expect, it } from "vitest";
import { addCollateralCalls, parseCirBtc } from "@/lib/collateral";
import { MAINNET_DEPLOYMENT } from "@/lib/contracts/deployments";

describe("parseCirBtc", () => {
  it("parses 8 decimals", () => {
    expect(parseCirBtc("0.0001", 20_000n)).toEqual({ ok: true, amount: 10_000n });
  });
  it("refuses zero, too many decimals, text and more than the balance", () => {
    expect(parseCirBtc("0", 1n).ok).toBe(false);
    expect(parseCirBtc("0.000000001", 10n).ok).toBe(false);
    expect(parseCirBtc("abc", 10n).ok).toBe(false);
    expect(parseCirBtc("1", 10n).ok).toBe(false);
  });
});

describe("addCollateralCalls", () => {
  const owner = "0x54e1714a0ffae58d3AA227C80FD48668e11f18d7" as const;
  it("approves then supplies and enables collateral on Aave V4", () => {
    const calls = addCollateralCalls("aave-v4", 1000n, owner, MAINNET_DEPLOYMENT);
    expect(calls.map((c) => c.to)).toEqual([MAINNET_DEPLOYMENT.cirBtc, MAINNET_DEPLOYMENT.aaveSpoke, MAINNET_DEPLOYMENT.aaveSpoke]);
  });
  it("approves then supplies collateral on Morpho", () => {
    const calls = addCollateralCalls("morpho", 1000n, owner, MAINNET_DEPLOYMENT);
    expect(calls).toHaveLength(2);
    expect(calls[0].to).toBe(MAINNET_DEPLOYMENT.cirBtc);
  });
  it("adds the Morpho authorization only when asked", () => {
    expect(addCollateralCalls("morpho", 1000n, owner, MAINNET_DEPLOYMENT, true)).toHaveLength(3);
  });
});
