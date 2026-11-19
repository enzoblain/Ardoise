// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGuard} from "./IGuard.sol";
import {IVenue} from "./IVenue.sol";

/// @notice One debt line: the loan taken for one payment.
/// @dev Token amounts are in USDC decimals (6); lines are USDC only. `principal` is the amount
/// borrowed, CCTP fees included. `rateBps` is the venue's yearly borrow rate when the line was
/// opened. `payee` is a CCTP-style bytes32 address so that non-EVM destinations fit.
struct DebtLine {
    uint256 id;
    IVenue venue;
    uint256 principal;
    uint256 repaid;
    uint256 accruedInterest;
    uint32 rateBps;
    uint32 destinationDomain;
    uint64 openedAt;
    bytes32 payee;
    string memo;
}

/// @title IArdoise
/// @notice A user's payment account. Each `pay()` borrows exactly what the payment needs from
/// the cheapest venue, after the guard checks the margin, delivers it on the payee's chain
/// (directly on Arc, or through CCTP fast transfer with Circle's forwarder) and records one
/// `DebtLine`.
/// @dev One account per user. The collateral position stays in the owner's wallet; the account
/// only borrows within the allowances the owner granted to each venue adapter. USDC sent to the
/// account with a plain `transfer()` runs no code, so `sweep()` lets anyone apply that balance
/// to the debt; the keeper relies on it and never needs more than repay rights.
interface IArdoise {
    /// @notice Emitted for every payment. Carries everything the statement shows, so the app can
    /// build it from events alone.
    /// @param lineId Identifier of the debt line opened for this payment.
    /// @param venue Venue the amount was borrowed from.
    /// @param amount Amount the payee receives at least, in USDC.
    /// @param maxFee Maximum CCTP fee borrowed on top of `amount` (0 for a payment on Arc); the
    /// actual fee is only known on the destination chain, and the unused part reaches the payee.
    /// @param borrowed Amount actually borrowed (`amount + maxFee`, up to venue rounding).
    /// @param rateBps Venue's yearly borrow rate at payment time, in basis points.
    /// @param destinationDomain CCTP domain of the payee's chain (`ARC_DOMAIN` for Arc).
    /// @param payee Payee address as bytes32.
    /// @param memo Free text shown in the statement.
    event Paid(
        uint256 indexed lineId,
        IVenue indexed venue,
        uint256 amount,
        uint256 maxFee,
        uint256 borrowed,
        uint32 rateBps,
        uint32 destinationDomain,
        bytes32 payee,
        string memo
    );

    /// @notice Emitted when part or all of a debt line is repaid.
    /// @param lineId Debt line repaid.
    /// @param payer Address that provided the funds (the account itself for `sweep()`).
    /// @param amount Amount applied to the line, interest included.
    event LineRepaid(uint256 indexed lineId, address indexed payer, uint256 amount);

    /// @notice Emitted when the owner changes the spending caps.
    /// @param perPayment New maximum amount per payment, in USDC.
    /// @param daily New maximum total of payments per UTC day, in USDC.
    event CapsUpdated(uint256 perPayment, uint256 daily);

    /// @notice Thrown when the caller is not the account owner.
    /// @param caller The caller.
    error NotOwner(address caller);

    /// @notice Thrown when the guard allows less than the payment needs.
    /// @param requested Amount the payment needed to borrow, fees included.
    /// @param allowed Largest amount the guard allows (0 if none).
    error PaymentRefused(uint256 requested, uint256 allowed);

    /// @notice Thrown when a payment exceeds the per-payment or daily cap.
    /// @param amount Amount the payment would borrow (`amount + maxFee`).
    /// @param remaining Amount still available under the binding cap.
    error CapExceeded(uint256 amount, uint256 remaining);

    /// @notice Thrown when no venue has enough liquidity for the requested amount.
    /// @param amount Amount that could not be borrowed, fees included.
    error NoVenueAvailable(uint256 amount);

    /// @notice Thrown by `payVia` when the venue is not in the factory's venue list.
    /// @param venue The rejected venue.
    error UnknownVenue(IVenue venue);

    /// @notice Thrown when a debt line does not exist.
    /// @param lineId The unknown identifier.
    error UnknownLine(uint256 lineId);

    /// @notice Thrown by `repay` when the debt line is already fully repaid.
    /// @param lineId The repaid line.
    error LineAlreadyRepaid(uint256 lineId);

    /// @notice Thrown when a payee is zero, or is not a valid EVM address (upper 12 bytes zero) for
    /// a payment to an EVM chain such as Arc or Base.
    /// @param payee The rejected payee.
    error InvalidPayee(bytes32 payee);

    /// @notice CCTP domain of Arc. A payment to this domain is a plain USDC transfer on Arc.
    /// @return The Arc domain (26).
    function ARC_DOMAIN() external view returns (uint32);

    /// @notice Owner of the account and of the collateral position on every venue.
    /// @return The owner's wallet.
    function owner() external view returns (address);

    /// @notice Guard consulted before every payment, read from the factory.
    /// @return The guard.
    function guard() external view returns (IGuard);

    /// @notice Venues the account can borrow from, in no particular order, read from the factory.
    /// @return The venue adapters.
    function venues() external view returns (IVenue[] memory);

    /// @notice Venue `pay()` would use for `amount`: the lowest `rate()` among the venues whose
    /// `available()` covers `amount` and where the guard allows the owner to borrow all of it,
    /// so a venue where the owner has no position is passed over. If the guard allows the full
    /// amount nowhere, the venue allowing the most is returned and `pay()` reverts with
    /// `PaymentRefused`, not `NoVenueAvailable`.
    /// @param amount Amount to borrow, fees included.
    /// @return venue Chosen venue; reverts with `NoVenueAvailable` if none qualifies.
    function bestVenue(uint256 amount) external view returns (IVenue venue);

    /// @notice Pays `amount` USDC to `payee` on `destinationDomain`, borrowing it on the best venue
    /// (`bestVenue(amount + maxFee)`); same as `payVia` on that venue.
    /// @dev Owner only, non-reentrant. Borrows `amount + maxFee`; with CCTP the payee receives at
    /// least `amount` (the unused part of `maxFee` reaches the payee too). Caps apply to
    /// `amount + maxFee`. Reverts with `NotOwner`, `InvalidPayee` (zero, or upper 12 bytes not
    /// zero on an EVM chain), `CapExceeded`, `NoVenueAvailable` or `PaymentRefused`.
    /// @param amount Amount the payee must receive, in USDC.
    /// @param destinationDomain CCTP domain of the payee's chain, `ARC_DOMAIN()` for Arc.
    /// @param payee Payee address as bytes32 (left-padded EVM address).
    /// @param maxFee Maximum CCTP fee (protocol + forwarder), in USDC; 0 for Arc.
    /// @param memo Free text stored on the debt line.
    /// @return lineId Identifier of the new debt line.
    function pay(uint256 amount, uint32 destinationDomain, bytes32 payee, uint256 maxFee, string calldata memo)
        external
        returns (uint256 lineId);

    /// @notice Pays `amount` USDC to `payee` on `destinationDomain`, borrowing it on `venue`, the
    /// venue the owner chose (the app recommends the cheapest, `bestVenue`).
    /// @dev Same as `pay` with the venue fixed: the same caps, guard check on `venue`, debt line
    /// and `Paid` event. Owner only, non-reentrant. Reverts with `UnknownVenue` if `venue` is not
    /// in the factory's list, `NoVenueAvailable` if its `available()` is below `amount + maxFee`,
    /// `PaymentRefused` if the guard allows less there, and with the other errors of `pay`.
    /// @param venue Venue to borrow from, one of `venues()`.
    /// @param amount Amount the payee must receive, in USDC.
    /// @param destinationDomain CCTP domain of the payee's chain, `ARC_DOMAIN()` for Arc.
    /// @param payee Payee address as bytes32 (left-padded EVM address).
    /// @param maxFee Maximum CCTP fee (protocol + forwarder), in USDC; 0 for Arc.
    /// @param memo Free text stored on the debt line.
    /// @return lineId Identifier of the new debt line.
    function payVia(
        IVenue venue,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 payee,
        uint256 maxFee,
        string calldata memo
    ) external returns (uint256 lineId);

    /// @notice Repays up to `amount` of a debt line, pulling USDC from the caller.
    /// @dev Anyone may repay. The caller must have approved the account for `amount`. Reverts
    /// with `UnknownLine` or `LineAlreadyRepaid`. The line is closed when the venue debt it
    /// stands for is repaid, even if the interest estimate differs.
    /// @param lineId Debt line to repay.
    /// @param amount Maximum amount to repay; only what the line still owes is pulled.
    /// @return repaid Amount applied to the line.
    function repay(uint256 lineId, uint256 amount) external returns (uint256 repaid);

    /// @notice Applies the account's own USDC balance to its debt, starting with the venue whose
    /// position has the lowest health factor; on each venue, oldest line first.
    /// @dev Public and non-reentrant: it can only reduce debt, so the keeper and anyone else may
    /// call it.
    /// @return repaid Total amount repaid.
    function sweep() external returns (uint256 repaid);

    /// @notice All debt lines of the account, oldest first, repaid ones included, with interest
    /// accrued so far.
    /// @dev `accruedInterest` is an estimate (simple interest at `rateBps` since `openedAt`):
    /// venues compound a variable rate on one debt per position, not per payment. The venue's
    /// `debtOf` is the amount actually owed.
    /// @return The debt lines.
    function lines() external view returns (DebtLine[] memory);

    /// @notice One debt line, repaid or not, with interest accrued so far.
    /// @dev Reverts with `UnknownLine` if it does not exist.
    /// @param lineId Debt line identifier.
    /// @return The debt line.
    function line(uint256 lineId) external view returns (DebtLine memory);

    /// @notice Owner's position on one venue.
    /// @param venue Venue to read.
    /// @return healthFactor Health factor (WAD), `type(uint256).max` without debt.
    /// @return collateralUsd Collateral value in USD (WAD).
    /// @return debtUsd Debt value in USD (WAD).
    function health(IVenue venue) external view returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd);

    /// @notice Current spending caps, in USDC.
    /// @return perPayment Maximum amount per payment.
    /// @return daily Maximum total of payments per UTC day.
    /// @return spentToday Total paid since the start of the current UTC day.
    function caps() external view returns (uint256 perPayment, uint256 daily, uint256 spentToday);

    /// @notice Sets the spending caps. Owner only.
    /// @param perPayment Maximum amount per payment, in USDC.
    /// @param daily Maximum total of payments per UTC day, in USDC.
    function setCaps(uint256 perPayment, uint256 daily) external;
}
