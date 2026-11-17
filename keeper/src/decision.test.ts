import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_SWEEP_AMOUNT, decide, repaymentToTarget, type Thresholds, type VenuePosition } from "./decision.js";

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;
const MAX_UINT256 = 2n ** 256n - 1n;
/** A third of one USDC base unit, as a WAD USD value. */
const USDC_UNIT_THIRD = 10n ** 12n / 3n;

const thresholds: Thresholds = {
  minHealthFactor: (125n * WAD) / 100n,
  targetHealthFactor: (15n * WAD) / 10n,
};

/** Position with 7,800 USD of risk-adjusted collateral and `debt` USDC of debt. */
function position(debt: bigint): VenuePosition {
  const debtUsd = debt * WAD;
  return { healthFactor: debtUsd === 0n ? MAX_UINT256 : (7_800n * WAD * WAD) / debtUsd, debtUsd };
}

const noDebt = position(0n);
const healthy = position(4_000n); // health factor 1.95
const underMinimum = position(6_500n); // health factor 1.2

test("waits when the account has no debt, even with a balance", () => {
  const decision = decide({ usdcBalance: 500n * USDC, positions: [noDebt], thresholds });
  assert.deepEqual(decision, { action: "wait", reason: "no-debt", shortfall: 0n });
});

test("waits when the factory has no venue", () => {
  const decision = decide({ usdcBalance: 500n * USDC, positions: [], thresholds });
  assert.equal(decision.reason, "no-debt");
});

test("sweeps an idle balance on a healthy position", () => {
  const decision = decide({ usdcBalance: 100n * USDC, positions: [healthy], thresholds });
  assert.deepEqual(decision, { action: "sweep", reason: "repay-idle-balance", shortfall: 0n });
});

test("waits when a healthy position has nothing to repay with", () => {
  const decision = decide({ usdcBalance: 0n, positions: [healthy], thresholds });
  assert.deepEqual(decision, { action: "wait", reason: "no-balance", shortfall: 0n });
});

test("does not spend gas on dust", () => {
  const decision = decide({ usdcBalance: MIN_SWEEP_AMOUNT - 1n, positions: [healthy], thresholds });
  assert.deepEqual(decision, { action: "wait", reason: "dust", shortfall: 0n });
});

test("sweeps from the minimum amount", () => {
  const decision = decide({ usdcBalance: MIN_SWEEP_AMOUNT, positions: [healthy], thresholds });
  assert.equal(decision.action, "sweep");
});

test("sweeps to restore the margin when the balance covers the repayment", () => {
  // 7,800 / 1.5 = 5,200 USDC of debt at the target: 1,300 USDC to repay.
  const decision = decide({ usdcBalance: 1_300n * USDC, positions: [underMinimum], thresholds });
  assert.deepEqual(decision, { action: "sweep", reason: "restore-margin", shortfall: 0n });
});

test("sweeps what is there and reports what is still missing", () => {
  const decision = decide({ usdcBalance: 300n * USDC, positions: [underMinimum], thresholds });
  assert.deepEqual(decision, { action: "sweep", reason: "restore-margin", shortfall: 1_000n * USDC });
});

test("reports an underfunded account that is under the minimum", () => {
  const decision = decide({ usdcBalance: 0n, positions: [underMinimum], thresholds });
  assert.deepEqual(decision, { action: "wait", reason: "underfunded", shortfall: 1_300n * USDC });
});

test("a position between the minimum and the target is not under the minimum", () => {
  const between = position(5_800n); // health factor about 1.34
  const decision = decide({ usdcBalance: 0n, positions: [between], thresholds });
  assert.deepEqual(decision, { action: "wait", reason: "no-balance", shortfall: 0n });
});

test("adds up the repayments of every venue under the minimum", () => {
  const decision = decide({ usdcBalance: 0n, positions: [underMinimum, healthy, underMinimum], thresholds });
  assert.equal(decision.shortfall, 2_600n * USDC);
});

test("still sweeps idle balances while the factory has no guard", () => {
  const decision = decide({ usdcBalance: 100n * USDC, positions: [underMinimum], thresholds: null });
  assert.deepEqual(decision, { action: "sweep", reason: "repay-idle-balance", shortfall: 0n });
});

test("repaymentToTarget is zero without debt or at the target", () => {
  assert.equal(repaymentToTarget(noDebt, thresholds.targetHealthFactor), 0n);
  assert.equal(repaymentToTarget(position(5_200n), thresholds.targetHealthFactor), 0n);
});

test("repaymentToTarget rounds up to the next USDC base unit", () => {
  // One third of a base unit over the target debt must still cost one unit.
  const debtUsd = 5_200n * WAD + USDC_UNIT_THIRD;
  const healthFactor = (7_800n * WAD * WAD) / debtUsd;
  const repayment = repaymentToTarget({ healthFactor, debtUsd }, thresholds.targetHealthFactor);
  assert.equal(repayment, 1n);
});
