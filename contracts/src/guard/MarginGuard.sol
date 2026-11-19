// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGuard} from "../interfaces/IGuard.sol";
import {IVenue} from "../interfaces/IVenue.sol";

/// @title MarginGuard
/// @notice Position guard of Ardoise: tells `IArdoise.pay()` how much of a payment can be
/// borrowed while the user's health factor stays at or above `minHealthFactor`, and exposes the
/// `targetHealthFactor` the keeper repays a position back to.
/// @dev The guard holds no funds and no per-user state: every answer is derived from the venue
/// adapter's `healthAfter`, so it reads the same oracle and risk parameters as the venue itself.
/// It relies on `healthAfter(user, x)` being non-increasing in `x`, which holds for any venue
/// where more debt against the same collateral cannot improve the health factor.
///
/// Simulation: for the demo, the owner can make the guard reason as if the collateral price
/// had dropped by `simulatedDropBps`. A health factor is risk-adjusted collateral over debt, so
/// with a single collateral asset a price drop of x% scales it by (1 - x%), up to rounding
/// dust. With several collateral assets it means "every collateral dropped by x%", which is
/// stricter than a drop of one of them. The simulation is global: the guard is shared by every
/// account of the factory, so a non-zero drop restricts everyone until the owner resets it. It
/// can only make the guard stricter, never pass a payment the real guard would refuse. The
/// simulation only changes Ardoise's own answers (`checkMargin`, `simulatedHealth`): it never
/// touches the venue or its oracle, and nobody can be liquidated because of it. It is not
/// without effect on users, though: whatever acts on those answers acts on real funds. The
/// keeper repays earlier from the owner's reserve, and a `DefenseAlarm` deployed to honor the
/// simulation sells the assets its owners pre-authorized on Base, for every owner at once.
/// `simulatedDropBps`, `setSimulatedDrop`, `simulatedHealth` and
/// `SimulationUpdated` are additions of this implementation, not part of `IGuard`.
contract MarginGuard is IGuard {
    /// @notice Health factor at which the venue liquidates (WAD). Thresholds must stay above it.
    uint256 public constant LIQUIDATION_HEALTH_FACTOR = 1e18;

    /// @notice Largest simulated price drop, in basis points (90%).
    /// @dev A 100% drop would make every health factor 0 and the required one infinite.
    uint256 public constant MAX_SIMULATED_DROP_BPS = 9_000;

    uint256 private constant BPS = 10_000;

    /// @notice Address allowed to change the thresholds and the simulation.
    /// @dev Immutable on purpose: the factory can point accounts to a new guard, so replacing
    /// the admin means redeploying rather than carrying ownership-transfer logic here.
    address public immutable owner;

    /// @inheritdoc IGuard
    uint256 public minHealthFactor;

    /// @inheritdoc IGuard
    uint256 public targetHealthFactor;

    /// @notice Simulated drop of the collateral price, in basis points; 0 when the simulation
    /// is off, which is the normal state.
    uint256 public simulatedDropBps;

    /// @dev Health factor the venue must report for a payment to pass: `minHealthFactor`
    /// without simulation, scaled up by the simulated drop otherwise. Stored so that the safe
    /// path of `checkMargin` reads one slot, with or without simulation.
    uint256 private _requiredHealthFactor;

    /// @notice Emitted when the simulated price drop changes.
    /// @param dropBps New simulated drop in basis points (0 = simulation off).
    event SimulationUpdated(uint256 dropBps);

    /// @notice Thrown when an address other than `owner` calls an admin function.
    /// @param caller The caller.
    error NotOwner(address caller);

    /// @notice Thrown when the thresholds do not satisfy
    /// `targetHealthFactor > minHealthFactor > LIQUIDATION_HEALTH_FACTOR`.
    /// @param minHealthFactor Rejected minimum health factor (WAD).
    /// @param targetHealthFactor Rejected target health factor (WAD).
    error InvalidThresholds(uint256 minHealthFactor, uint256 targetHealthFactor);

    /// @notice Thrown when the simulated drop exceeds `MAX_SIMULATED_DROP_BPS`.
    /// @param dropBps Rejected drop in basis points.
    error InvalidSimulatedDrop(uint256 dropBps);

    /// @notice Thrown when the owner passed to the constructor is the zero address.
    error ZeroOwner();

    /// @notice Deploys the guard with its admin and initial thresholds.
    /// @dev Reverts with `ZeroOwner` if `owner_` is the zero address and with
    /// `InvalidThresholds` unless `targetHealthFactor_ > minHealthFactor_ > 1e18`.
    /// @param owner_ Address allowed to change the thresholds.
    /// @param minHealthFactor_ Minimum health factor a payment may leave the position at (WAD).
    /// @param targetHealthFactor_ Health factor the keeper repays back to (WAD).
    constructor(address owner_, uint256 minHealthFactor_, uint256 targetHealthFactor_) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        _setThresholds(minHealthFactor_, targetHealthFactor_);
    }

    /// @notice Changes the margin thresholds.
    /// @dev Reverts with `NotOwner` if the caller is not `owner` and with `InvalidThresholds`
    /// unless `targetHealthFactor_ > minHealthFactor_ > 1e18`. Emits `ThresholdsUpdated`.
    /// There is no meaningful upper bound: the owner is trusted, and a minimum set too high
    /// refuses every payment of every account until it is corrected. Values above about 1e73
    /// revert with an arithmetic panic.
    /// @param minHealthFactor_ New minimum health factor after a payment (WAD).
    /// @param targetHealthFactor_ New health factor the keeper repays back to (WAD).
    function setThresholds(uint256 minHealthFactor_, uint256 targetHealthFactor_) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _setThresholds(minHealthFactor_, targetHealthFactor_);
    }

    /// @notice Turns the price-drop simulation on (`dropBps > 0`) or off (`dropBps == 0`).
    /// @dev For demonstrations only. Reverts with `NotOwner` if the caller is not `owner` and
    /// with `InvalidSimulatedDrop` above `MAX_SIMULATED_DROP_BPS`. Emits `SimulationUpdated`.
    /// @param dropBps Simulated drop of the collateral price in basis points (2_000 = -20%).
    function setSimulatedDrop(uint256 dropBps) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (dropBps > MAX_SIMULATED_DROP_BPS) revert InvalidSimulatedDrop(dropBps);
        simulatedDropBps = dropBps;
        _updateRequiredHealthFactor();
        emit SimulationUpdated(dropBps);
    }

    /// @notice Health factor of `user` on `venue` as the guard sees it: the venue's own health
    /// factor, scaled down by the simulated price drop when the simulation is on.
    /// @dev The app's margin gauge reads this to show the number `checkMargin` reasons on.
    /// It is derived from the venue's `health`, while `checkMargin` uses `healthAfter`; an
    /// adapter may round the two a few wei apart, so a gauge exactly at the minimum does not
    /// guarantee that a payment passes. Reverts if the venue's `health` reverts.
    /// @param venue Venue to read.
    /// @param user Owner of the position.
    /// @return healthFactor Health factor (WAD), `type(uint256).max` without debt.
    function simulatedHealth(IVenue venue, address user) external view returns (uint256 healthFactor) {
        // The collateral and debt values are not needed here.
        // forge-lint: disable-next-line(unused-return)
        (healthFactor,,) = venue.health(user);
        uint256 dropBps = simulatedDropBps;
        if (dropBps == 0 || healthFactor == type(uint256).max) return healthFactor;
        uint256 kept = BPS - dropBps;
        // Split so that a very large health factor (tiny debt) cannot overflow: the first term
        // is exact, since it multiplies a whole number of BPS.
        // forge-lint: disable-next-line(divide-before-multiply)
        return (healthFactor / BPS) * kept + (healthFactor % BPS) * kept / BPS;
    }

    /// @inheritdoc IGuard
    /// @dev A safe payment costs a single `healthAfter` call, which is the only path that
    /// matters for gas: `pay()` reverts whenever the answer is lower than `amount`, so the
    /// search below runs in practice in `eth_call`s from the app (to show how much can still be
    /// paid) or in transactions that revert anyway. Reverts if the venue's `healthAfter` reverts,
    /// so the answer is exact for any amount the venue can project; a caller asking for "as much
    /// as possible" should pass a large realistic amount rather than `type(uint256).max`.
    function checkMargin(address user, IVenue venue, uint256 amount) external view returns (uint256 allowed) {
        if (amount == 0) return 0;

        // Under a simulated drop, "scaled health >= minimum" is the same test as "health >=
        // minimum scaled up", so the simulation costs nothing per projection.
        uint256 minHf = _requiredHealthFactor;
        if (venue.healthAfter(user, amount) >= minHf) return amount;

        // A position already under the threshold (or without collateral, where the venue
        // reports 0) cannot borrow anything; checking it first avoids a full search to reach 0.
        if (venue.healthAfter(user, 0) < minHf) return 0;

        // Invariant: borrowing `low` keeps the margin, borrowing `high` does not. The interval
        // halves at every step, so the search ends after at most 256 iterations, and after
        // 40 to 50 for realistic USDC amounts.
        uint256 low = 0;
        uint256 high = amount;
        while (high - low > 1) {
            uint256 mid = low + (high - low) / 2;
            // The loop is bounded as described above and the venue is the adapter chosen by
            // the account, so the repeated external call is intended.
            // forge-lint: disable-next-line(calls-loop)
            if (venue.healthAfter(user, mid) >= minHf) {
                low = mid;
            } else {
                high = mid;
            }
        }
        return low;
    }

    /// @dev Validates and stores the thresholds. The minimum must sit strictly above the
    /// liquidation point so that a payment never leaves a position liquidatable, and the target
    /// strictly above the minimum so that a keeper repayment leaves room for the next payment.
    function _setThresholds(uint256 minHealthFactor_, uint256 targetHealthFactor_) private {
        if (minHealthFactor_ <= LIQUIDATION_HEALTH_FACTOR || targetHealthFactor_ <= minHealthFactor_) {
            revert InvalidThresholds(minHealthFactor_, targetHealthFactor_);
        }
        minHealthFactor = minHealthFactor_;
        targetHealthFactor = targetHealthFactor_;
        _updateRequiredHealthFactor();
        emit ThresholdsUpdated(minHealthFactor_, targetHealthFactor_);
    }

    /// @dev Recomputes the health factor the venue must report. For a venue health `h` and a
    /// drop `d`, `h * (BPS - d) / BPS >= min` holds exactly when `h >= ceil(min * BPS / (BPS - d))`.
    function _updateRequiredHealthFactor() private {
        uint256 kept = BPS - simulatedDropBps;
        _requiredHealthFactor = (minHealthFactor * BPS + kept - 1) / kept;
    }
}
