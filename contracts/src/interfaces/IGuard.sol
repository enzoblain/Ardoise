// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVenue} from "./IVenue.sol";

/// @title IGuard
/// @notice Position guard: decides how much a user may borrow for a payment without pushing
/// the position below the margin threshold. `IArdoise.pay()` calls `checkMargin` before
/// every borrow and refuses the payment when the answer is lower than the requested amount.
/// @dev Health factors are WAD (1e18 = 1.0). Repayments that restore the margin go through
/// `IArdoise.sweep()` and `IArdoise.repay()`, so the keeper never needs more than repay rights.
interface IGuard {
    /// @notice Emitted when the margin thresholds change.
    /// @param minHealthFactor New minimum health factor after a payment (WAD).
    /// @param targetHealthFactor New health factor the keeper repays back to (WAD).
    event ThresholdsUpdated(uint256 minHealthFactor, uint256 targetHealthFactor);

    /// @notice Largest part of `amount` that `user` can borrow on `venue` while keeping the
    /// health factor at or above `minHealthFactor()`.
    /// @param user Owner of the collateral position.
    /// @param venue Venue the payment would borrow from.
    /// @param amount Requested borrow amount, in the venue asset's decimals.
    /// @return allowed `amount` if the payment is safe, a smaller amount if only part of it is,
    /// 0 if nothing can be borrowed.
    function checkMargin(address user, IVenue venue, uint256 amount) external view returns (uint256 allowed);

    /// @notice Minimum health factor a payment may leave the position at (WAD).
    /// @return The minimum health factor.
    function minHealthFactor() external view returns (uint256);

    /// @notice Health factor the keeper repays the position back to when it falls below
    /// `minHealthFactor()` (WAD). Always greater than `minHealthFactor()`.
    /// @return The target health factor.
    function targetHealthFactor() external view returns (uint256);
}
