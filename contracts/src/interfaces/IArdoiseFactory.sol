// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoise} from "./IArdoise.sol";

/// @title IArdoiseFactory
/// @notice Creates one `IArdoise` account per user and is the registry everything else trusts:
/// venue adapters only accept `borrow` calls from `accountOf(user)`, and the app and the keeper
/// find a user's account here and through `AccountCreated`.
/// @dev Adapters must check `accountOf(user) == msg.sender`, never `IArdoise(msg.sender).owner()`:
/// any contract can claim to be owned by a victim and spend the allowance the victim granted.
interface IArdoiseFactory {
    /// @notice Emitted when an account is created.
    /// @param owner Wallet that owns the account and the collateral position.
    /// @param account Address of the new account.
    event AccountCreated(address indexed owner, IArdoise indexed account);

    /// @notice Thrown when the caller already has an account.
    /// @param account The caller's existing account.
    error AccountExists(IArdoise account);

    /// @notice Creates the caller's account, owned by the caller.
    /// @dev Reverts with `AccountExists` if the caller already has one.
    /// @return account Address of the new account.
    function createAccount() external returns (IArdoise account);

    /// @notice Account of `owner`.
    /// @param owner Wallet to look up.
    /// @return account The account, or the zero address if `owner` has none.
    function accountOf(address owner) external view returns (IArdoise account);
}
