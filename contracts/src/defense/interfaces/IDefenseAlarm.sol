// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVenue} from "../../interfaces/IVenue.sol";

/// @title IDefenseAlarm
/// @notice Arc side of the CCTP-attested defense, and the ABI the keeper relays from (task D2).
/// Anyone may call `raise(owner)`: the alarm checks on chain that the owner's Ardoise position is
/// under the guard's minimum health factor on one of the factory's venues, then sends a
/// `DefenseMessage` to the `DefenseExecutor` on Base through CCTP V2 generic messaging. Circle
/// attests the message; only that attested message lets the executor spend the owner's
/// pre-authorized funds on Base.
interface IDefenseAlarm {
    /// @notice Emitted when an alarm is sent to the executor.
    /// @param owner Owner of the position.
    /// @param account The owner's Ardoise account, which receives the repayment funds on Arc.
    /// @param amountNeeded USDC (6 decimals) that brings the position back to the guard's target.
    /// @param nonce Alarm identifier, numbered from 1 across all owners, consumed once on Base.
    /// @param expiry Timestamp after which the executor ignores the alarm.
    event AlarmRaised(
        address indexed owner, address indexed account, uint256 amountNeeded, uint64 nonce, uint64 expiry
    );

    /// @notice Emitted once, when the deployer sets the executor.
    /// @param executor The `DefenseExecutor` on the executor's chain, as bytes32.
    event ExecutorSet(bytes32 executor);

    /// @notice Thrown by `setExecutor` for a caller other than the deployer.
    error NotDeployer(address caller);
    /// @notice Thrown by `setExecutor` once the executor is set, or for a zero executor.
    error ExecutorAlreadySet();
    /// @notice Thrown by `raise` before the executor is set.
    error ExecutorNotSet();
    /// @notice Thrown by `raise` when the owner has no Ardoise account.
    error NoAccount(address owner);
    /// @notice Thrown by `raise` and `shortfall` while the factory has no guard.
    error GuardNotSet();
    /// @notice Thrown by `raise` when no venue shows the position under the guard's minimum.
    error PositionHealthy(address owner);
    /// @notice Thrown by `raise` during the owner's cooldown.
    /// @param nextAllowed Timestamp from which an alarm can be raised again.
    error CoolingDown(uint64 nextAllowed);
    /// @notice Thrown by the constructor when the alarm TTL is zero or longer than the cooldown:
    /// two alarms for the same owner could then both be executed for one shortfall.
    error InvalidTiming(uint64 cooldownPeriod, uint64 alarmTtl);
    /// @notice Thrown by the constructor when an address is zero.
    error ZeroAddress();

    /// @notice Raises an alarm for `owner` if their position is under the guard's minimum.
    /// @dev Permissionless. Calls the account's public `sweep()` first, so USDC already on the
    /// account is applied before the shortfall is measured. Reverts with `ExecutorNotSet`, `NoAccount`, `GuardNotSet`,
    /// `CoolingDown` or `PositionHealthy`. Emits `AlarmRaised`.
    /// @param owner Owner of the position.
    /// @return nonce Identifier of the alarm.
    function raise(address owner) external returns (uint64 nonce);

    /// @notice Timestamp from which `raise(owner)` is allowed again; 0 or a past time means now.
    /// @param owner Owner of the position.
    /// @return nextAllowed The timestamp.
    function cooldown(address owner) external view returns (uint64 nextAllowed);

    /// @notice USDC that `raise(owner)` would request now, and the venue it is measured on.
    /// @dev `(0, 0)` when no venue shows the position under the guard's minimum. Reverts with
    /// `GuardNotSet` while the factory has no guard.
    /// @param owner Owner of the position.
    /// @return venue The first venue under the minimum, or zero.
    /// @return amountNeeded USDC (6 decimals), rounded up.
    function shortfall(address owner) external view returns (IVenue venue, uint256 amountNeeded);

    /// @notice Identifier of the last alarm raised for any owner (0 before the first).
    /// @return The nonce.
    function lastNonce() external view returns (uint64);

    /// @notice The `DefenseExecutor` on the executor's chain, as bytes32; zero until set.
    /// @return The executor.
    function executor() external view returns (bytes32);

    /// @notice Sets the executor, once. The alarm is deployed first on Arc; the executor, which
    /// needs the alarm's address, is then deployed on Base and recorded here.
    /// @dev Reverts with `NotDeployer` or `ExecutorAlreadySet`. Emits `ExecutorSet`.
    /// @param executor_ `DefenseExecutor` address on the executor's chain.
    function setExecutor(address executor_) external;
}
