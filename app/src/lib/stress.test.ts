import { describe, expect, it } from "vitest";
import { AAVE_V4_CIRBTC, MORPHO_86, liquidationLoss, reserveLines, runStress, type ReserveAsset, type StressPosition } from "@/lib/stress";

// 250 USD of cirBTC at a 78% collateral factor, 100 USD of debt: health factor 1.95.
const AAVE: StressPosition = { venueName: "Aave V4", collateralUsd: 250, debtUsd: 100, healthFactor: 1.95, liquidation: AAVE_V4_CIRBTC };
const GUARD = { minHealthFactor: 1.25, targetHealthFactor: 1.5 };
const usdc = (valueUsd: number, speed: ReserveAsset["speed"], place = "Gateway reserve"): ReserveAsset => ({
  asset: "USDC",
  chain: "Base",
  place,
  valueUsd,
  speed,
});

describe("reserve lines", () => {
  it("orders the reserve fastest first, stable before volatile, and cuts ETH by the scenario's drop", () => {
    const lines = reserveLines(
      [
        { asset: "ETH", chain: "Base", place: "Wallet", valueUsd: 40, speed: "manual" },
        usdc(20, "manual", "Wallet"),
        usdc(30, "automatic"),
        { asset: "USDC", chain: "Arc", place: "Ardoise account", valueUsd: 10, speed: "instant" },
      ],
      { btcDrop: 0.4, ethDrop: 0.5 },
    );
    expect(lines.map((l) => [l.place, l.asset])).toEqual([
      ["Ardoise account", "USDC"],
      ["Gateway reserve", "USDC"],
      ["Wallet", "USDC"],
      ["Wallet", "ETH"],
    ]);
    expect(lines[3]).toMatchObject({ haircut: 0.5, defenseUsd: 20, priority: 4 });
    expect(lines.reduce((sum, l) => sum + l.weight, 0)).toBeCloseTo(1, 9);
    expect(lines[1].weight).toBeCloseTo(30 / 80, 9);
  });
});

describe("stress test", () => {
  it("restores the margin from the reserve, drawn in order, when the guard minimum is crossed", () => {
    // -40%: health factor 1.17, under 1.25; back to 1.5 needs 100 - 117 / 1.5 = 22 USD.
    const result = runStress([AAVE], [usdc(10, "instant"), usdc(30, "automatic")], { btcDrop: 0.4, ethDrop: 0.5 }, GUARD);
    expect(result.survives).toBe(true);
    expect(result.drawn[0]).toBeCloseTo(10, 9);
    expect(result.drawn[1]).toBeCloseTo(12, 9);
    expect(result.finalHealthFactor).toBeCloseTo(1.5, 9);
    expect(result.curve.at(-1)!.without).toBeCloseTo(1.17, 9);
    expect(result.liquidationLossUsd).toBe(0);
  });

  it("keeps a position out of liquidation that would lose the Aave bonus without Ardoise", () => {
    // -60%: health factor 0.78 without repayment; Aave liquidates the whole debt at a 7.22% bonus.
    const result = runStress([AAVE], [usdc(50, "automatic")], { btcDrop: 0.6, ethDrop: 0.7 }, GUARD);
    expect(result.curve.at(-1)!.without).toBeCloseTo(0.78, 9);
    expect(result.survives).toBe(true);
    expect(result.finalHealthFactor).toBeCloseTo(1.5, 9);
    expect(result.liquidationLossUsd).toBeCloseTo(7.22, 6);
  });

  it("finds the largest bitcoin drop the reserve covers", () => {
    // Survives while 100 - 195 (1 - d) <= 50, that is d <= 1 - 50 / 195.
    const result = runStress([AAVE], [usdc(50, "automatic")], { btcDrop: 0.4, ethDrop: 0.5 }, GUARD);
    expect(result.maxBtcDropCovered).toBeCloseTo(1 - 50 / 195, 6);
  });

  it("counts ETH at its crisis value, falling with bitcoin", () => {
    const eth: ReserveAsset = { asset: "ETH", chain: "Base", place: "Wallet", valueUsd: 50, speed: "manual" };
    const stable = runStress([AAVE], [usdc(50, "automatic")], { btcDrop: 0.4, ethDrop: 0.5 }, GUARD).maxBtcDropCovered;
    const volatile = runStress([AAVE], [eth], { btcDrop: 0.4, ethDrop: 0.5 }, GUARD).maxBtcDropCovered;
    expect(volatile).toBeLessThan(stable);
  });

  it("reports a reserve too small to avoid liquidation", () => {
    const result = runStress([AAVE], [usdc(5, "automatic")], { btcDrop: 0.6, ethDrop: 0.7 }, GUARD);
    expect(result.survives).toBe(false);
    expect(result.finalHealthFactor).toBeLessThan(1);
    expect(result.drawn[0]).toBeCloseTo(5, 9);
  });

  it("defends the weaker of two positions first", () => {
    const morpho: StressPosition = { venueName: "Morpho", collateralUsd: 100, debtUsd: 60, healthFactor: 1.4333, liquidation: MORPHO_86 };
    const result = runStress([AAVE, morpho], [usdc(30, "automatic")], { btcDrop: 0.3, ethDrop: 0.4 }, GUARD);
    // Morpho at 1.0033 needs 60 - 60.2 / 1.5 = 19.87 to reach 1.5; Aave at 1.365 is above the minimum.
    expect(result.survives).toBe(true);
    expect(result.drawn[0]).toBeCloseTo(60 - (1.4333 * 60 * 0.7) / 1.5, 3);
  });

  it("charges Morpho's incentive on the whole debt", () => {
    const morpho: StressPosition = { venueName: "Morpho", collateralUsd: 100, debtUsd: 60, healthFactor: 1.4333, liquidation: MORPHO_86 };
    expect(liquidationLoss(morpho, 0.5)).toBeCloseTo(60 * (1 / 0.958 - 1), 9);
    expect(liquidationLoss(morpho, 0.2)).toBe(0);
  });

  it("has nothing to defend without debt", () => {
    const result = runStress([{ ...AAVE, debtUsd: 0, healthFactor: Infinity }], [], { btcDrop: 0.9, ethDrop: 0.9 }, GUARD);
    expect(result.survives).toBe(true);
    expect(result.maxBtcDropCovered).toBe(1);
  });
});
