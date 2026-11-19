// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVenue} from "../../interfaces/IVenue.sol";

/// @title IDefenseAlarm
/// @notice Arc side of the CCTP-attested defense, and the ABI the keeper relays from (task D2).
/// Anyone may call `raise(owner)`: the alarm checks on chain that the owner's Ardoise position is
/// under the minimum health factor on one of its venues, then sends a `DefenseMessage` to the
/// `DefenseExecutor` on Base through CCTP V2 generic messaging. Circle attests the message; only
/// that attested message lets the executor spend the owner's pre-authorized funds on Base.
/// @dev The venues, the minimum and target health factors and the health source are pinned when
/// the alarm is deployed (`venues`, `minHealthFactor`, `targetHealthFactor`, `honorsSimulation`)
/// and cannot change: later changes to the factory's venue list or guard do not reach the alarm.
interface IDefenseAlarm {
    /// @notice Emitted when an alarm is sent to the executor.
    /// @param owner Owner of the position.
    /// @param account The owner's Ardoise account, which receives the repayment funds on Arc.
    /// @param amountNeeded USDC (6 decimals) that brings the position back to the target health factor.
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
    /// @notice Thrown by the constructor while the factory has no guard to read thresholds from.
    error GuardNotSet();
    /// @notice Thrown by the constructor unless the guard's thresholds satisfy
    /// `targetHealthFactor > minHealthFactor > 1e18`.
    /// @param minHealthFactor Rejected minimum health factor (WAD).
    /// @param targetHealthFactor Rejected target health factor (WAD).
    error InvalidThresholds(uint256 minHealthFactor, uint256 targetHealthFactor);
    /// @notice Thrown by the constructor when the factory's venue list is empty, longer than the
    /// alarm's bound, or contains an address without code.
    error InvalidVenues();
    /// @notice Thrown by `raise` when no venue shows the position under the minimum, or when the
    /// USDC already on the account covers the need.
    error PositionHealthy(address owner);
    /// @notice Thrown by `raise` during the owner's cooldown.
    /// @param nextAllowed Timestamp from which an alarm can be raised again.
    error CoolingDown(uint64 nextAllowed);
    /// @notice Thrown by the constructor when the alarm TTL is zero or longer than the cooldown:
    /// two alarms for the same owner could then both be executed for one shortfall.
    error InvalidTiming(uint64 cooldownPeriod, uint64 alarmTtl);
    /// @notice Thrown by `raise` when the account's sweep ran out of gas: retry with more gas.
    error SweepOutOfGas();
    /// @notice Thrown by the constructor when an address is zero.
    error ZeroAddress();

    /// @notice Raises an alarm for `owner` if their position is under the pinned minimum.
    /// @dev Permissionless. Calls the account's public `sweep()` first, so USDC already on the
    /// account is applied before the shortfall is measured; whatever is still on the account after
    /// it is deducted from the amount requested. If that sweep alone restores the
    /// position, `raise` reverts with `PositionHealthy` and the sweep is rolled back with it: a
    /// relayer should then call `sweep()` on the account directly. Reverts with `ExecutorNotSet`,
    /// `NoAccount`, `CoolingDown`, `PositionHealthy` or `SweepOutOfGas`. Emits `AlarmRaised`.
    /// @param owner Owner of the position.
    /// @return nonce Identifier of the alarm.
    function raise(address owner) external returns (uint64 nonce);

    /// @notice Timestamp from which `raise(owner)` is allowed again; 0 or a past time means now.
    /// @param owner Owner of the position.
    /// @return nextAllowed The timestamp.
    function cooldown(address owner) external view returns (uint64 nextAllowed);

    /// @notice USDC that `raise(owner)` would request now, and the venue it is measured on.
    /// @dev `(0, 0)` when no venue shows the position under the pinned minimum; `(venue, 0)`
    /// when one does but the USDC already on the owner's account covers the need (a `sweep()`
    /// restores it), so an amount of 0 does not mean healthy. The idle USDC is credited to the
    /// first venue under the minimum, while `sweep()` repays lines oldest first across venues:
    /// with several venues that venue may get less until the next alarm.
    /// @param owner Owner of the position.
    /// @return venue The first venue under the minimum, or zero.
    /// @return amountNeeded USDC (6 decimals), rounded up.
    function shortfall(address owner) external view returns (IVenue venue, uint256 amountNeeded);

    /// @notice The venues the alarm measures positions on, in order: a copy of the factory's list
    /// taken when the alarm was deployed. A venue listed on the factory later is not in it.
    /// @return The pinned venues.
    function venues() external view returns (IVenue[] memory);

    /// @notice Health factor (WAD) under which an alarm can be raised: the guard's minimum when
    /// the alarm was deployed. Later changes to the guard do not reach it.
    /// @return The pinned minimum.
    function minHealthFactor() external view returns (uint256);

    /// @notice Health factor (WAD) the requested amount restores: the guard's target when the
    /// alarm was deployed. Later changes to the guard do not reach it.
    /// @return The pinned target.
    function targetHealthFactor() external view returns (uint256);

    /// @notice Whether the alarm decides on the guard's simulated health factor (`true`, demo
    /// pair only) or on the venues' own health factors (`false`, production).
    /// @dev When `true`, the guard owner's simulated price drop raises alarms for every owner, so
    /// the executor paired with this alarm must be reserved for demos.
    /// @return True for a simulation-honoring alarm.
    function honorsSimulation() external view returns (bool);

    /// @notice The guard whose `simulatedHealth` a simulation-honoring alarm reads, pinned at
    /// deployment; the zero address on a production alarm, which never calls a guard.
    /// @return The pinned guard, or zero.
    function simulationGuard() external view returns (address);

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
