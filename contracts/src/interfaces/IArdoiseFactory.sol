// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoise} from "./IArdoise.sol";
import {IGuard} from "./IGuard.sol";
import {IVenue} from "./IVenue.sol";

/// @title IArdoiseFactory
/// @notice Creates one `IArdoise` account per user and is the registry everything else trusts:
/// venue adapters only accept `borrow` calls from `accountOf(user)`, and the app and the keeper
/// find a user's account here and through `AccountCreated`.
/// @dev Guarantees adapters rely on: only the factory deploys accounts; once set, `accountOf(owner)`
/// never changes; the account's `owner()` is `owner`. Adapters store the factory as `immutable` and
/// check `accountOf(user) == msg.sender`, never `IArdoise(msg.sender).owner()`: any contract can
/// claim to be owned by a victim and spend the allowance the victim granted.
///
/// The factory also holds the venue list and the guard that every account reads, so adapters and
/// the guard can be redeployed without new accounts (a new adapter still needs a new borrow
/// allowance from each user, since allowances are granted to the adapter's address).
/// Deployment order: factory, then adapters and guard (pointing to the factory), then
/// `setVenues` and `setGuard` by the factory admin.
interface IArdoiseFactory {
    /// @notice Emitted when an account is created.
    /// @param owner Wallet that owns the account and the collateral position.
    /// @param account Address of the new account.
    event AccountCreated(address indexed owner, IArdoise indexed account);

    /// @notice Emitted when the admin replaces the venue list.
    /// @param venues New venue adapters.
    event VenuesUpdated(IVenue[] venues);

    /// @notice Emitted when the admin replaces the guard.
    /// @param guard New guard.
    event GuardUpdated(IGuard guard);

    /// @notice Thrown when the caller already has an account.
    /// @param account The caller's existing account.
    error AccountExists(IArdoise account);

    /// @notice Creates the caller's account, owned by the caller, with the factory's default caps.
    /// @dev Reverts with `AccountExists` if the caller already has one. The owner can change the
    /// caps afterwards with `IArdoise.setCaps`.
    /// @return account Address of the new account.
    function createAccount() external returns (IArdoise account);

    /// @notice Account of `owner`.
    /// @param owner Wallet to look up.
    /// @return account The account, or the zero address if `owner` has none.
    function accountOf(address owner) external view returns (IArdoise account);

    /// @notice Venue adapters every account can borrow from.
    /// @return The venue adapters.
    function venues() external view returns (IVenue[] memory);

    /// @notice Guard every account consults before a payment.
    /// @return The guard.
    function guard() external view returns (IGuard);

    /// @notice Replaces the venue list. Admin only.
    /// @param newVenues New venue adapters.
    function setVenues(IVenue[] calldata newVenues) external;

    /// @notice Replaces the guard. Admin only.
    /// @param newGuard New guard.
    function setGuard(IGuard newGuard) external;
}
