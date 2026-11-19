/**
 * Stress test of a position and its reserve, computed in the browser from
 * values already read (positions on each venue, reserve balances). Nothing
 * here touches the chain: it answers "what if bitcoin fell by X%".
 *
 * Model, in USD, with plain numbers since the results are only displayed:
 * - A venue's health factor is `riskAdjustedCollateral / debt`; a bitcoin
 *   drop `d` scales the collateral, so the health factor becomes `hf * (1 - d)`.
 * - The reserve is drawn in priority order, fastest first, and only in a
 *   crisis: an asset that falls with bitcoin (ETH) counts at its value after
 *   the scenario's ETH drop.
 * - The guard and keeper bring a position under the minimum back to the
 *   target; it survives as long as every health factor stays at or above 1.
 */

/** How a venue liquidates a position whose health factor falls under 1. */
export type LiquidationRule =
  /**
   * Aave V4: the liquidator repays debt until the health factor reaches
   * `targetHealthFactor`, and takes that debt plus a bonus in collateral.
   * The bonus grows from `bonusFactor * maxBonus` at a health factor of 1 to
   * `maxBonus` at `healthFactorForMaxBonus`.
   */
  | { kind: "aave"; maxBonus: number; bonusFactor: number; healthFactorForMaxBonus: number; targetHealthFactor: number }
  /** Morpho: the whole debt can be repaid, with a fixed incentive on top. */
  | { kind: "morpho"; incentive: number };

/**
 * Aave V4 Main Spoke on Arc, cirBTC reserve (id 2), read on chain on
 * 2026-11-19: `getDynamicReserveConfig` gives a 78% collateral factor and a
 * 107.22% maximum liquidation bonus; `getLiquidationConfig` a 1.24 target
 * health factor, maximum bonus at 0.9 and a 90% bonus factor.
 */
export const AAVE_V4_CIRBTC: LiquidationRule = {
  kind: "aave",
  maxBonus: 0.0722,
  bonusFactor: 0.9,
  healthFactorForMaxBonus: 0.9,
  targetHealthFactor: 1.24,
};

/**
 * Morpho's liquidation incentive for an 86% LLTV market:
 * `min(1.15, 1 / (0.3 * LLTV + 0.7)) - 1`, from Morpho's documentation.
 */
export const MORPHO_86: LiquidationRule = { kind: "morpho", incentive: 1 / (0.3 * 0.86 + 0.7) - 1 };

/** A position with debt on one venue. */
export interface StressPosition {
  venueName: string;
  /** Collateral value, USD. */
  collateralUsd: number;
  /** Debt, USD. */
  debtUsd: number;
  healthFactor: number;
  liquidation: LiquidationRule;
}

/** How quickly a reserve asset can repay. */
export type ReserveSpeed = "instant" | "automatic" | "manual";

/** One asset the owner holds that can defend the position. */
export interface ReserveAsset {
  asset: "USDC" | "ETH";
  chain: string;
  /** Where it sits, for example "Gateway reserve". */
  place: string;
  /** Value today, USD. */
  valueUsd: number;
  speed: ReserveSpeed;
}

/** A market scenario: how far bitcoin and ether fall. */
export interface Scenario {
  /** Bitcoin drop between 0 and 1. */
  btcDrop: number;
  /** Ether drop between 0 and 1. */
  ethDrop: number;
}

/** Guard thresholds the keeper acts on. */
export interface Thresholds {
  minHealthFactor: number;
  targetHealthFactor: number;
}

/** One reserve asset as the crisis sees it. */
export interface ReserveLine extends ReserveAsset {
  /** Share of its value lost in the scenario. */
  haircut: number;
  /** Value left to repay with in the scenario, USD. */
  defenseUsd: number;
  /** Share of the whole reserve's defense value. */
  weight: number;
  /** 1 is drawn first. */
  priority: number;
}

/** A point of the health factor curve. */
export interface CurvePoint {
  btcDrop: number;
  /** Lowest health factor without any repayment. */
  without: number;
  /** Lowest health factor once the keeper has drawn on the reserve. */
  withArdoise: number;
}

/** What the scenario does to the account. */
export interface StressResult {
  reserve: ReserveLine[];
  curve: CurvePoint[];
  /** USD drawn from each reserve line, in priority order. */
  drawn: number[];
  /** Whether every position stays at or above a health factor of 1. */
  survives: boolean;
  /** Lowest health factor at the end of the scenario, after repayments. */
  finalHealthFactor: number;
  /** Liquidation penalty the user would pay without Ardoise, USD. */
  liquidationLossUsd: number;
  /** Largest bitcoin drop the reserve covers, with ether falling in the scenario's proportion. */
  maxBtcDropCovered: number;
}

const SPEED_ORDER: Record<ReserveSpeed, number> = { instant: 0, automatic: 1, manual: 2 };
const CURVE_STEPS = 40;

/** Share of an asset's value lost in the scenario: ETH falls, USDC does not. */
export function haircut(asset: ReserveAsset, scenario: Scenario): number {
  return asset.asset === "ETH" ? clamp(scenario.ethDrop) : 0;
}

/**
 * The reserve as the scenario sees it: each asset's crisis value, weight and
 * the order the keeper or the owner would draw on it (fastest first, then
 * stable before volatile, then largest first).
 */
export function reserveLines(assets: ReserveAsset[], scenario: Scenario): ReserveLine[] {
  const valued = assets.map((a) => {
    const cut = haircut(a, scenario);
    return { ...a, haircut: cut, defenseUsd: a.valueUsd * (1 - cut) };
  });
  const total = valued.reduce((sum, a) => sum + a.defenseUsd, 0);
  return valued
    .sort(
      (a, b) =>
        SPEED_ORDER[a.speed] - SPEED_ORDER[b.speed] ||
        Number(a.asset === "ETH") - Number(b.asset === "ETH") ||
        b.defenseUsd - a.defenseUsd,
    )
    .map((a, i) => ({ ...a, weight: total > 0 ? a.defenseUsd / total : 0, priority: i + 1 }));
}

/** Debt to repay for a position to reach `target` after a bitcoin drop. */
function repaymentTo(position: StressPosition, drop: number, target: number): number {
  const riskAdjusted = position.healthFactor * position.debtUsd * (1 - drop);
  return Math.max(0, position.debtUsd - riskAdjusted / target);
}

function healthAfter(position: StressPosition, drop: number, repaid: number): number {
  const debt = position.debtUsd - repaid;
  if (debt <= 0) return Infinity;
  return (position.healthFactor * position.debtUsd * (1 - drop)) / debt;
}

/**
 * Lowest health factor once `budget` USD has been spent the way the keeper
 * does: positions under the minimum are brought back to the target, lowest
 * first (the order `sweep()` serves venues in), and when the budget cannot
 * reach the target it first keeps every position at a health factor of 1.
 */
function defend(positions: StressPosition[], drop: number, budget: number, t: Thresholds): { lowest: number; spent: number } {
  const ordered = [...positions].sort((a, b) => a.healthFactor - b.healthFactor);
  const repaid = ordered.map(() => 0);
  let left = budget;
  // First keep everything out of liquidation, then restore the margin.
  for (const target of [1, t.targetHealthFactor]) {
    ordered.forEach((p, i) => {
      if (target !== 1 && healthAfter(p, drop, repaid[i]) >= t.minHealthFactor) return;
      const need = Math.max(0, repaymentTo(p, drop, target) - repaid[i]);
      const pay = Math.min(need, left);
      repaid[i] += pay;
      left -= pay;
    });
  }
  const lowest = Math.min(...ordered.map((p, i) => healthAfter(p, drop, repaid[i])));
  return { lowest, spent: budget - left };
}

/** Liquidation penalty on one position at a bitcoin drop, USD; 0 if it is not liquidated. */
export function liquidationLoss(position: StressPosition, drop: number): number {
  const hf = healthAfter(position, drop, 0);
  if (hf >= 1) return 0;
  const rule = position.liquidation;
  if (rule.kind === "morpho") return position.debtUsd * rule.incentive;
  const depth = clamp((1 - hf) / (1 - rule.healthFactorForMaxBonus));
  const bonus = rule.maxBonus * (rule.bonusFactor + (1 - rule.bonusFactor) * depth);
  // Repay r with r * (1 + bonus) of collateral taken, until the target is reached.
  const collateral = position.collateralUsd * (1 - drop);
  const threshold = (position.healthFactor * position.debtUsd) / position.collateralUsd;
  const denominator = rule.targetHealthFactor - (1 + bonus) * threshold;
  const toTarget = (rule.targetHealthFactor * position.debtUsd - collateral * threshold) / denominator;
  const repaid = denominator > 0 && toTarget < position.debtUsd ? toTarget : position.debtUsd;
  return repaid * bonus;
}

/**
 * Runs a scenario on the positions with debt and the owner's reserve.
 *
 * @param positions Positions with debt, one per venue.
 * @param assets The owner's reserve.
 * @param scenario How far bitcoin and ether fall.
 * @param thresholds The guard's minimum and target health factors.
 * @returns The curve, the reserve drawn, survival and the penalty avoided.
 */
export function runStress(positions: StressPosition[], assets: ReserveAsset[], scenario: Scenario, thresholds: Thresholds): StressResult {
  const withDebt = positions.filter((p) => p.debtUsd > 0);
  const btcDrop = clamp(scenario.btcDrop);
  const ethPerBtc = btcDrop > 0 ? scenario.ethDrop / btcDrop : 0;
  const budgetAt = (drop: number) =>
    reserveLines(assets, { btcDrop: drop, ethDrop: clamp(drop * ethPerBtc) }).reduce((sum, a) => sum + a.defenseUsd, 0);

  const curve: CurvePoint[] = [];
  for (let i = 0; i <= CURVE_STEPS; i++) {
    const drop = (btcDrop * i) / CURVE_STEPS;
    const without = withDebt.length ? Math.min(...withDebt.map((p) => healthAfter(p, drop, 0))) : Infinity;
    const withArdoise = withDebt.length ? defend(withDebt, drop, budgetAt(drop), thresholds).lowest : Infinity;
    curve.push({ btcDrop: drop, without, withArdoise });
  }

  const reserve = reserveLines(assets, scenario);
  const final = withDebt.length ? defend(withDebt, btcDrop, budgetAt(btcDrop), thresholds) : { lowest: Infinity, spent: 0 };
  let toDraw = final.spent;
  const drawn = reserve.map((line) => {
    const take = Math.min(line.defenseUsd, toDraw);
    toDraw -= take;
    return take;
  });

  // The scenario's ETH/BTC proportion, pushed until the reserve no longer
  // keeps every position out of liquidation.
  const survivesAt = (drop: number) => !withDebt.length || defend(withDebt, drop, budgetAt(drop), thresholds).lowest >= 1;
  let maxBtcDropCovered = 1;
  if (!survivesAt(1)) {
    let low = 0;
    let high = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (survivesAt(mid)) low = mid;
      else high = mid;
    }
    maxBtcDropCovered = low;
  }

  return {
    reserve,
    curve,
    drawn,
    survives: final.lowest >= 1,
    finalHealthFactor: final.lowest,
    liquidationLossUsd: withDebt.reduce((sum, p) => sum + liquidationLoss(p, btcDrop), 0),
    maxBtcDropCovered,
  };
}

function clamp(x: number): number {
  return Math.min(1, Math.max(0, x));
}
