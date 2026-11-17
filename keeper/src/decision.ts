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
 * Smallest balance worth a transaction, in USDC base units (0.01 USDC).
 * Gas on Arc is paid in USDC, so sweeping dust costs more than it repays.
 */
export const MIN_SWEEP_AMOUNT = 10_000n;

/** A user's position on one venue, as returned by `IVenue.health(owner)`. */
export interface VenuePosition {
  /** Health factor (WAD); `type(uint256).max` without debt. */
  healthFactor: bigint;
  /** Debt value in USD (WAD). */
  debtUsd: bigint;
}

/** Margin thresholds read from the guard (WAD). */
export interface Thresholds {
  minHealthFactor: bigint;
  targetHealthFactor: bigint;
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
      /** `underfunded`: a position is under the minimum but the account holds nothing to repay with. */
      reason: "no-debt" | "no-balance" | "dust" | "underfunded";
      shortfall: bigint;
    };

/**
 * USDC a position must repay to return to the target health factor, assuming
 * the collateral value does not move.
 *
 * The health factor is `riskAdjustedCollateral / debt`, so the largest debt
 * that still meets the target is `healthFactor * debt / target`.
 *
 * @param position Position to restore.
 * @param targetHealthFactor Health factor to reach (WAD).
 * @returns Amount to repay in USDC base units, rounded up; 0 if the position
 * is already at or above the target.
 */
export function repaymentToTarget(position: VenuePosition, targetHealthFactor: bigint): bigint {
  if (position.debtUsd === 0n || position.healthFactor >= targetHealthFactor) return 0n;
  const riskAdjustedCollateralUsd = (position.healthFactor * position.debtUsd) / WAD;
  const debtAtTargetUsd = (riskAdjustedCollateralUsd * WAD) / targetHealthFactor;
  const excessUsd = position.debtUsd - debtAtTargetUsd;
  return (excessUsd + USDC_UNIT_IN_WAD - 1n) / USDC_UNIT_IN_WAD;
}

/**
 * Decides whether the keeper should call `sweep()` on an account.
 *
 * Sweeping is always in the user's interest when the account holds USDC and
 * has debt: the balance can do nothing else there, and repaying stops the
 * interest. The thresholds only change how the decision is labelled and
 * whether a shortfall is reported.
 *
 * @param state What the keeper read about the account.
 * @returns `sweep` when a transaction is worth sending, otherwise `wait` with
 * the reason. `shortfall` is the USDC that would still be missing after the
 * sweep to bring every position under the minimum back to the target.
 */
export function decide(state: AccountState): Decision {
  const hasDebt = state.positions.some((position) => position.debtUsd > 0n);
  if (!hasDebt) return { action: "wait", reason: "no-debt", shortfall: 0n };

  const thresholds = state.thresholds;
  const needed =
    thresholds === null
      ? 0n
      : state.positions
          .filter((position) => position.debtUsd > 0n && position.healthFactor < thresholds.minHealthFactor)
          .reduce((sum, position) => sum + repaymentToTarget(position, thresholds.targetHealthFactor), 0n);
  const underMinimum = needed > 0n;
  const canSweep = state.usdcBalance >= MIN_SWEEP_AMOUNT;

  if (canSweep) {
    return {
      action: "sweep",
      reason: underMinimum ? "restore-margin" : "repay-idle-balance",
      shortfall: needed > state.usdcBalance ? needed - state.usdcBalance : 0n,
    };
  }
  if (underMinimum) return { action: "wait", reason: "underfunded", shortfall: needed };
  return { action: "wait", reason: state.usdcBalance === 0n ? "no-balance" : "dust", shortfall: 0n };
}
