// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoiseFactory} from "./IArdoiseFactory.sol";

/// @title IVenue
/// @notice Adapter around one lending venue on Arc (Aave V4 Main Spoke, Morpho market).
/// @dev The collateral position belongs to the user's wallet, not to Ardoise: the adapter only
/// borrows and repays on the user's behalf, within the allowances the user granted to the venue
/// (on Aave V4: `Spoke.setUserPositionManager` for the Taker and Giver position managers, then
/// `TakerPositionManager.approveBorrow` with this adapter as spender).
///
/// Units used by every implementation:
/// - token amounts are in the borrowed asset's decimals (USDC: 6);
/// - rates are yearly borrow rates in basis points (1 bps = 0.01%);
/// - health factors are WAD (1e18 = 1.0, liquidation below 1.0); `type(uint256).max` means no debt;
/// - USD values are WAD (1e18 = 1 USD).
interface IVenue {
    /// @notice Emitted when the adapter borrows on behalf of a user.
    /// @param user Owner of the position the debt is recorded against.
    /// @param account Ardoise account that called and received the tokens.
    /// @param amount Amount actually borrowed.
    event Borrowed(address indexed user, address indexed account, uint256 amount);

    /// @notice Emitted when the adapter repays debt on behalf of a user.
    /// @param user Owner of the position whose debt was repaid.
    /// @param payer Address the repaid tokens were pulled from.
    /// @param amount Amount actually repaid.
    event Repaid(address indexed user, address indexed payer, uint256 amount);

    /// @notice Thrown when `borrow` is called by an address that is not
    /// `factory().accountOf(user)`.
    /// @param caller The caller.
    /// @param user Owner of the position the caller tried to borrow against.
    error UnauthorizedCaller(address caller, address user);

    /// @notice Registry of Ardoise accounts this adapter trusts.
    /// @return The factory.
    function factory() external view returns (IArdoiseFactory);

    /// @notice Human-readable venue name shown in the app, for example "Aave V4".
    /// @return The venue name.
    function name() external view returns (string memory);

    /// @notice The token this adapter borrows and repays (USDC on Arc).
    /// @return The token address.
    function asset() external view returns (address);

    /// @notice Current yearly borrow rate of `asset()` on this venue.
    /// @return rateBps Borrow rate in basis points.
    function rate() external view returns (uint256 rateBps);

    /// @notice Liquidity of `asset()` that can be borrowed from the venue right now.
    /// @return amount Borrowable amount, in `asset()` decimals.
    function available() external view returns (uint256 amount);

    /// @notice Current state of a user's position on this venue.
    /// @param user Owner of the position.
    /// @return healthFactor Health factor (WAD), `type(uint256).max` without debt.
    /// @return collateralUsd Collateral value in USD (WAD).
    /// @return debtUsd Debt value in USD (WAD).
    function health(address user)
        external
        view
        returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd);

    /// @notice Health factor the user's position would have after borrowing `extraDebt` more.
    /// @param user Owner of the position.
    /// @param extraDebt Additional amount of `asset()` to borrow.
    /// @return healthFactor Projected health factor (WAD), 0 if the position has no collateral.
    function healthAfter(address user, uint256 extraDebt) external view returns (uint256 healthFactor);

    /// @notice Current debt of the user in `asset()` on this venue, interest included.
    /// @param user Owner of the position.
    /// @return amount Debt in `asset()` decimals.
    function debtOf(address user) external view returns (uint256 amount);

    /// @notice Borrows `amount` of `asset()` against `user`'s position and sends it to the caller.
    /// @dev Only callable by `factory().accountOf(user)`, otherwise reverts with
    /// `UnauthorizedCaller`: the user's borrow allowance is granted to this shared adapter, so
    /// this check is what keeps other callers from spending it. Also reverts if the venue
    /// refuses the borrow (allowance, caps, health factor).
    /// @param user Owner of the position the debt is recorded against.
    /// @param amount Amount to borrow.
    /// @return borrowed Amount actually borrowed and sent to the caller.
    function borrow(address user, uint256 amount) external returns (uint256 borrowed);

    /// @notice Repays up to `amount` of `user`'s debt, pulling `asset()` from the caller.
    /// @dev The caller must have approved this adapter for `amount`. Repays at most the current
    /// debt; the unused part of `amount` is not pulled.
    /// @param user Owner of the position whose debt is repaid.
    /// @param amount Maximum amount to repay.
    /// @return repaid Amount actually repaid.
    function repay(address user, uint256 amount) external returns (uint256 repaid);
}
