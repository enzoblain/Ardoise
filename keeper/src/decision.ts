/**
 * Decision logic of the keeper, kept free of any chain access so that it can
 * be unit-tested: given what the keeper read about one account, say whether
 * to call `sweep()`.
 *
 * The keeper has a single lever. `IArdoise.sweep()` applies the USDC already
 * sitting on the account to its debt, so the keeper can only act when someone
 * (the user, or a later deleveraging step) has sent USDC to the account.
 */

const WAD = 10n ** 18n;

/** USD values are WAD and USDC has 6 decimals: 1 USDC base unit = 1e12 WAD. */
const USDC_UNIT_IN_WAD = 10n ** 12n;

/**
 * Smallest repayment worth a transaction, in USDC base units (0.1 USDC).
 * Gas on Arc is paid in USDC, so sweeping dust costs more than it repays, and
 * anyone could drain the keeper wallet by sending dust to an indebted account.
 * The one exception is a balance that restores a position under the minimum
 * (see `decide`): that sweep is sent whatever its size.
 *
 * TODO: set this to a multiple of the measured cost of `sweep()` once
 * `ArdoiseAccount` is deployed (A4); until then 0.1 USDC is a margin over the
 * 0.038 USDC measured for a simple operation on Arc (see docs/roadmap.md).
 */
export const MIN_SWEEP_AMOUNT = 100_000n;

/** A user's position on one venue, as returned by `IVenue.health(owner)`. */
export interface VenuePosition {
  /** Health factor (WAD); `type(uint256).max` without debt. */
  healthFactor: bigint;
  /** Debt value in USD (WAD). */
  debtUsd: bigint;
  /**
   * USDC debt in base units, as returned by `IVenue.debtOf(owner)`: the most
   * a repayment can absorb. `null` when that read failed.
   */
  debt: bigint | null;
}

/** Margin thresholds read from the guard (WAD). */
export interface Thresholds {
  minHealthFactor: bigint;
  targetHealthFactor: bigint;
  /**
   * Simulated drop of the collateral price set on the guard for the demo, in
   * basis points; 0 when the simulation is off.
   */
  simulatedDropBps: bigint;
}

/** Everything the keeper reads about one account before deciding. */
export interface AccountState {
  /** USDC held by the account, in base units (6 decimals). */
  usdcBalance: bigint;
  /** The owner's position on every venue of the factory. */
  positions: readonly VenuePosition[];
  /** Guard thresholds, or `null` while the factory has no guard. */
  thresholds: Thresholds | null;
}

export type Decision =
  | {
      action: "sweep";
      /** `restore-margin` when a position is under the minimum health factor. */
      reason: "restore-margin" | "repay-idle-balance";
      /** USDC still missing to bring every position back to the target (0 if none). */
      shortfall: bigint;
    }
  | {
      action: "wait";
      /**
       * `underfunded`: a position is under the minimum but the account does
       * not hold enough to restore it. `unrepayable`: a position is under the
       * minimum and has no USDC debt on its venue, so USDC cannot restore it.
       */
      reason: "no-debt" | "no-balance" | "dust" | "underfunded" | "unrepayable";
      shortfall: bigint;
    };

const BPS = 10_000n;
const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Position as the guard sees it under a simulated price drop: the same debt,
 * and a health factor scaled by the drop, with the same rounding as
 * `MarginGuard.simulatedHealth`. The keeper must judge a position the way
 * the guard does, otherwise it would not repay when the guard refuses.
 *
 * @param position Position read from the venue.
 * @param dropBps Simulated drop in basis points (0 = no simulation).
 * @returns The position to decide on; unchanged without simulation or debt.
 */
export function applySimulatedDrop(position: VenuePosition, dropBps: bigint): VenuePosition {
  if (dropBps === 0n || position.healthFactor === MAX_UINT256) return position;
  return { ...position, healthFactor: (position.healthFactor * (BPS - dropBps)) / BPS };
}

/**
 * USDC a position must repay to return to the target health factor, assuming
 * the collateral value does not move.
 *
 * The health factor is `riskAdjustedCollateral / debt`, so the largest debt
 * that still meets the target is `healthFactor * debt / target`.
 *
 * The result is capped at the venue's USDC debt, as `DefenseAlarm.shortfall`
 * caps it: `debtUsd` can exceed it (a debt in another asset on the same
 * venue, thresholds set far above the position), and USDC sent to the
 * account beyond its debt cannot leave it, since accounts have no withdrawal.
 *
 * @param position Position to restore.
 * @param targetHealthFactor Health factor to reach (WAD).
 * @returns Amount to repay in USDC base units, rounded up and never above
 * `position.debt` when it is known; 0 if the position is already at or above
 * the target.
 */
export function repaymentToTarget(position: VenuePosition, targetHealthFactor: bigint): bigint {
  if (position.debtUsd === 0n || position.healthFactor >= targetHealthFactor) return 0n;
  const riskAdjustedCollateralUsd = (position.healthFactor * position.debtUsd) / WAD;
  const debtAtTargetUsd = (riskAdjustedCollateralUsd * WAD) / targetHealthFactor;
  const excessUsd = position.debtUsd - debtAtTargetUsd;
  const repayment = (excessUsd + USDC_UNIT_IN_WAD - 1n) / USDC_UNIT_IN_WAD;
  return position.debt !== null && repayment > position.debt ? position.debt : repayment;
}

/**
 * Most USDC that may still be brought to an account: the owner's debt on
 * every venue, less the USDC already on the account, which the next
 * `sweep()` applies first. Anything above it would stay on the account for
 * good, since accounts have no withdrawal.
 *
 * @param state What the keeper read about the account.
 * @returns The amount in USDC base units; 0 when the balance already covers
 * the whole debt; `null` when the debt on a venue is unknown, in which case
 * nothing may be brought, since the amount could not be capped.
 */
export function debtLeftToFund(state: AccountState): bigint | null {
  let debt = 0n;
  for (const position of state.positions) {
    if (position.debt === null) return null;
    debt += position.debt;
  }
  return debt > state.usdcBalance ? debt - state.usdcBalance : 0n;
}

/**
 * Decides whether the keeper should call `sweep()` on an account.
 *
 * Sweeping is always in the user's interest when the account holds USDC and
 * has debt: the balance can do nothing else there, and repaying stops the
 * interest. The thresholds only change how the decision is labelled and
 * whether a shortfall is reported. Under a simulated price drop, positions
 * are judged with the simulated health factor.
 *
 * A balance under `MIN_SWEEP_AMOUNT` is swept all the same when it is enough
 * to bring every position under the minimum back to the target: nothing else
 * would ever apply it, and the position would stay under the minimum. This
 * cannot be used to drain the keeper wallet with dust: `sweep()` serves the
 * lowest health factor first, and the venue it repays is no longer under
 * the minimum afterwards. With several venues under the minimum the sweep
 * can give the whole balance to the first, so another may stay under it:
 * the next pass then reports its shortfall, and dust can trigger at most one
 * such sweep per venue.
 *
 * @param state What the keeper read about the account.
 * @returns `sweep` when a transaction is worth sending, otherwise `wait` with
 * the reason. `shortfall` is the USDC that would still be missing, once the
 * account's balance is applied, to bring every position under the minimum
 * back to the target; it never exceeds the debt on those venues.
 */
export function decide(state: AccountState): Decision {
  const hasDebt = state.positions.some((position) => position.debtUsd > 0n);
  if (!hasDebt) return { action: "wait", reason: "no-debt", shortfall: 0n };

  const thresholds = state.thresholds;
  const positionsUnderMinimum =
    thresholds === null
      ? []
      : state.positions
          .map((position) => applySimulatedDrop(position, thresholds.simulatedDropBps))
          .filter((position) => position.debtUsd > 0n && position.healthFactor < thresholds.minHealthFactor);
  const needed =
    thresholds === null
      ? 0n
      : positionsUnderMinimum.reduce(
          (sum, position) => sum + repaymentToTarget(position, thresholds.targetHealthFactor),
          0n,
        );
  const underMinimum = needed > 0n;
  // A balance too small to sweep on its own still repays with the next sweep,
  // so it is always deducted, as `DefenseAlarm.shortfall` deducts it.
  const shortfall = needed > state.usdcBalance ? needed - state.usdcBalance : 0n;
  const canSweep = state.usdcBalance >= MIN_SWEEP_AMOUNT || (underMinimum && shortfall === 0n);

  if (canSweep) {
    return { action: "sweep", reason: underMinimum ? "restore-margin" : "repay-idle-balance", shortfall };
  }
  if (underMinimum) return { action: "wait", reason: "underfunded", shortfall };
  // Under the minimum with nothing to repay in USDC (the debt on that venue
  // is in another asset): USDC cannot help, but the operator must know.
  if (positionsUnderMinimum.length > 0) return { action: "wait", reason: "unrepayable", shortfall: 0n };
  return { action: "wait", reason: state.usdcBalance === 0n ? "no-balance" : "dust", shortfall: 0n };
}
