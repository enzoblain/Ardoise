// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseAccount} from "./ArdoiseAccount.sol";
import {ITokenMessengerV2} from "./cctp/ITokenMessengerV2.sol";
import {IArdoise} from "./interfaces/IArdoise.sol";
import {IArdoiseFactory} from "./interfaces/IArdoiseFactory.sol";
import {IGuard} from "./interfaces/IGuard.sol";
import {IVenue} from "./interfaces/IVenue.sol";

/// @title ArdoiseFactory
/// @notice Deploys one `ArdoiseAccount` per user and is the registry venue adapters trust; also
/// holds the venue list and the guard every account reads.
/// @dev Only this contract deploys accounts, `accountOf(owner)` never changes once set, and each
/// account's `owner()` is the wallet that created it: the guarantees `IArdoiseFactory` promises
/// to venue adapters. The admin is immutable, like the guard's: replacing it means redeploying.
contract ArdoiseFactory is IArdoiseFactory {
    /// @notice Address allowed to change the venue list and the guard.
    address public immutable admin;
    /// @notice USDC, the asset every venue must lend.
    IERC20 public immutable usdc;
    /// @notice Circle CCTP V2 TokenMessenger given to new accounts.
    ITokenMessengerV2 public immutable tokenMessenger;
    /// @notice CCTP finality threshold given to new accounts.
    uint32 public immutable minFinalityThreshold;
    /// @notice Per-payment cap of new accounts, in USDC.
    uint256 public immutable defaultPerPaymentCap;
    /// @notice Daily cap of new accounts, in USDC.
    uint256 public immutable defaultDailyCap;

    mapping(address owner => IArdoise) private _accounts;
    IVenue[] private _venues;
    IGuard private _guard;

    /// @notice Thrown when an address other than `admin` calls an admin function.
    /// @param caller The caller.
    error NotAdmin(address caller);
    /// @notice Thrown by `setVenues` for a venue that does not lend `usdc` or does not trust this
    /// factory.
    /// @param venue The rejected venue.
    error InvalidVenue(IVenue venue);
    /// @notice Thrown by the constructor when an address is zero.
    error ZeroAddress();

    /// @notice Deploys the factory; venues and guard are set afterwards with `setVenues` and
    /// `setGuard`, once they are deployed pointing to this factory.
    /// @param admin_ Address allowed to change the venue list and the guard.
    /// @param usdc_ USDC token.
    /// @param tokenMessenger_ CCTP V2 TokenMessenger.
    /// @param minFinalityThreshold_ CCTP finality threshold (2000 on Arc).
    /// @param defaultPerPaymentCap_ Per-payment cap of new accounts, in USDC.
    /// @param defaultDailyCap_ Daily cap of new accounts, in USDC.
    constructor(
        address admin_,
        IERC20 usdc_,
        ITokenMessengerV2 tokenMessenger_,
        uint32 minFinalityThreshold_,
        uint256 defaultPerPaymentCap_,
        uint256 defaultDailyCap_
    ) {
        if (admin_ == address(0) || address(usdc_) == address(0) || address(tokenMessenger_) == address(0)) {
            revert ZeroAddress();
        }
        admin = admin_;
        usdc = usdc_;
        tokenMessenger = tokenMessenger_;
        minFinalityThreshold = minFinalityThreshold_;
        defaultPerPaymentCap = defaultPerPaymentCap_;
        defaultDailyCap = defaultDailyCap_;
    }

    /// @inheritdoc IArdoiseFactory
    function createAccount() external returns (IArdoise account) {
        IArdoise existing = _accounts[msg.sender];
        if (address(existing) != address(0)) revert AccountExists(existing);
        account = new ArdoiseAccount(
            msg.sender, usdc, tokenMessenger, minFinalityThreshold, defaultPerPaymentCap, defaultDailyCap
        );
        _accounts[msg.sender] = account;
        // The only external call is the deployment of the account itself.
        // forge-lint: disable-next-line(reentrancy-events)
        emit AccountCreated(msg.sender, account);
    }

    /// @inheritdoc IArdoiseFactory
    function accountOf(address owner) external view returns (IArdoise account) {
        return _accounts[owner];
    }

    /// @inheritdoc IArdoiseFactory
    function venues() external view returns (IVenue[] memory) {
        return _venues;
    }

    /// @inheritdoc IArdoiseFactory
    function guard() external view returns (IGuard) {
        return _guard;
    }

    /// @inheritdoc IArdoiseFactory
    /// @dev Reverts with `NotAdmin`, or with `InvalidVenue` for a venue whose `asset()` is not
    /// `usdc` or whose `factory()` is not this contract (it would refuse every borrow).
    function setVenues(IVenue[] calldata newVenues) external {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        for (uint256 i = 0; i < newVenues.length; ++i) {
            IVenue venue = newVenues[i];
            // forge-lint: disable-next-line(calls-loop)
            if (venue.asset() != address(usdc) || address(venue.factory()) != address(this)) {
                // forge-lint: disable-next-line(require-revert-in-loop)
                revert InvalidVenue(venue);
            }
        }
        _venues = newVenues;
        emit VenuesUpdated(newVenues);
    }

    /// @inheritdoc IArdoiseFactory
    /// @dev Reverts with `NotAdmin`. Setting the zero address stops every payment (accounts
    /// cannot ask a guard) but not repayments or `sweep()`.
    function setGuard(IGuard newGuard) external {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _guard = newGuard;
        emit GuardUpdated(newGuard);
    }
}
