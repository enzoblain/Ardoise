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
contract MarginGuard is IGuard {
    /// @notice Health factor at which the venue liquidates (WAD). Thresholds must stay above it.
    uint256 public constant LIQUIDATION_HEALTH_FACTOR = 1e18;

    /// @notice Address allowed to change the thresholds.
    /// @dev Immutable on purpose: the factory can point accounts to a new guard, so replacing
    /// the admin means redeploying rather than carrying ownership-transfer logic here.
    address public immutable owner;

    /// @inheritdoc IGuard
    uint256 public minHealthFactor;

    /// @inheritdoc IGuard
    uint256 public targetHealthFactor;

    /// @notice Thrown when an address other than `owner` calls an admin function.
    /// @param caller The caller.
    error NotOwner(address caller);

    /// @notice Thrown when the thresholds do not satisfy
    /// `targetHealthFactor > minHealthFactor > LIQUIDATION_HEALTH_FACTOR`.
    /// @param minHealthFactor Rejected minimum health factor (WAD).
    /// @param targetHealthFactor Rejected target health factor (WAD).
    error InvalidThresholds(uint256 minHealthFactor, uint256 targetHealthFactor);

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
    /// There is no upper bound: the owner is trusted, and a minimum set too high refuses every
    /// payment of every account until it is corrected.
    /// @param minHealthFactor_ New minimum health factor after a payment (WAD).
    /// @param targetHealthFactor_ New health factor the keeper repays back to (WAD).
    function setThresholds(uint256 minHealthFactor_, uint256 targetHealthFactor_) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _setThresholds(minHealthFactor_, targetHealthFactor_);
    }

    /// @inheritdoc IGuard
    /// @dev A safe payment costs a single `healthAfter` call, which is the only path that
    /// matters for gas: `pay()` reverts whenever the answer is lower than `amount`, so the
    /// search below runs in practice in `eth_call`s from the app (to show how much can still be
    /// paid) or in transactions that revert anyway. Reverts if the venue's `healthAfter` reverts.
    function checkMargin(address user, IVenue venue, uint256 amount) external view returns (uint256 allowed) {
        if (amount == 0) return 0;

        uint256 minHf = minHealthFactor;
        if (venue.healthAfter(user, amount) >= minHf) return amount;

        // A position already under the threshold (or without collateral, where the venue
        // reports 0) cannot borrow anything; checking it first avoids a full search to reach 0.
        if (venue.healthAfter(user, 0) < minHf) return 0;

        // Invariant: borrowing `low` keeps the margin, borrowing `high` does not. The interval
        // halves at every step, so the search ends after at most 256 projections, and after
        // about 40 for any realistic USDC amount.
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
        emit ThresholdsUpdated(minHealthFactor_, targetHealthFactor_);
    }
}
