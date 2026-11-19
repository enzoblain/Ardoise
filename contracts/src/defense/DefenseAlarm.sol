// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {IMessageTransmitterV2} from "../cctp/IMessageTransmitterV2.sol";
import {IArdoise} from "../interfaces/IArdoise.sol";
import {IArdoiseFactory} from "../interfaces/IArdoiseFactory.sol";
import {IGuard} from "../interfaces/IGuard.sol";
import {IVenue} from "../interfaces/IVenue.sol";
import {DefenseMessage} from "./DefenseMessage.sol";
import {IDefenseAlarm} from "./interfaces/IDefenseAlarm.sol";

/// @notice The guard view a simulation-honoring alarm reads, implemented by `MarginGuard` (not
/// part of `IGuard`).
interface ISimulatedHealth {
    /// @notice Health factor of `user` on `venue` as the guard sees it, simulated drop included.
    function simulatedHealth(IVenue venue, address user) external view returns (uint256 healthFactor);
}

/// @title DefenseAlarm
/// @notice Proves on Arc that an Ardoise position is under the minimum health factor and sends
/// that proof, through CCTP V2 generic messaging attested by Circle, to the `DefenseExecutor` on
/// Base, which may then spend the owner's pre-authorized funds there to repay the debt. Anyone
/// may raise an alarm: the condition is checked here, on chain, so the relayer decides nothing.
/// @dev Holds no funds. Everything the trigger depends on is pinned at construction and has no
/// setter: the venue list, the minimum and target health factors, and the health source. The
/// factory admin can later list another venue or replace the guard, and the guard owner can
/// change its thresholds, without moving this alarm's trigger. The price of that is that a new
/// venue or new thresholds need a new alarm and a new executor (the executor trusts one alarm
/// address), and every owner then sets a policy on the new executor. The factory is still read
/// for `accountOf(owner)`, which only the owner's own `createAccount` writes. The pinned venues
/// are trusted as they are: what they report decides the alarm.
///
/// Health source, chosen by `honorsSimulation` at construction:
/// - `false` (production): the venue's own `health(owner)`. The guard is never called, so its
///   simulated price drop cannot raise an alarm.
/// - `true` (demo pair only): the pinned guard's `simulatedHealth`, which scales the venue's
///   health factor down by the guard's simulated drop. WARNING: the simulated drop is global and
///   set by the guard owner alone, so such an alarm lets the guard owner (and, while a drop is
///   on, anyone calling `raise`) trigger real spending on Base for every owner holding a policy
///   on this alarm's executor, up to their caps. A simulation-honoring alarm must only be paired
///   with an executor reserved for demos, on which only demo wallets set a policy.
///
/// The executor address is set once by the deployer after the executor is deployed on Base, since
/// each contract needs the other's address.
contract DefenseAlarm is IDefenseAlarm {
    /// @notice Largest venue list the constructor accepts.
    /// @dev `raise` and `shortfall` read every pinned venue, so the list must stay short enough
    /// for `raise` to fit in a block whatever the factory lists at deployment.
    uint256 public constant MAX_VENUES = 8;

    /// @dev USD values are WAD; USDC has 6 decimals and is valued at 1 USD by the venues.
    uint256 private constant WAD_PER_USDC_UNIT = 1e12;
    /// @dev Standard finality: Arc is final at once and Circle attests in about 0.5 s.
    uint32 private constant FINALITY = 2000;
    /// @dev Health factor at which a venue liquidates (WAD); the pinned minimum must be above it.
    uint256 private constant LIQUIDATION_HEALTH_FACTOR = 1e18;

    /// @notice Registry of Ardoise accounts, read for `accountOf(owner)` only after construction.
    IArdoiseFactory public immutable factory;
    /// @notice CCTP V2 MessageTransmitter on Arc.
    IMessageTransmitterV2 public immutable messageTransmitter;
    /// @notice CCTP domain of the executor's chain (Base: 6).
    uint32 public immutable executorDomain;
    /// @notice Minimum time between two alarms for the same owner, in seconds.
    uint64 public immutable cooldownPeriod;
    /// @notice Validity of an alarm on the executor's chain, in seconds.
    uint64 public immutable alarmTtl;
    /// @notice Address allowed to call `setExecutor`, once.
    address public immutable deployer;
    /// @inheritdoc IDefenseAlarm
    uint256 public immutable minHealthFactor;
    /// @inheritdoc IDefenseAlarm
    uint256 public immutable targetHealthFactor;
    /// @inheritdoc IDefenseAlarm
    bool public immutable honorsSimulation;
    /// @inheritdoc IDefenseAlarm
    address public immutable simulationGuard;

    /// @inheritdoc IDefenseAlarm
    bytes32 public executor;
    /// @inheritdoc IDefenseAlarm
    uint64 public lastNonce;
    /// @dev Timestamp of each owner's last alarm.
    mapping(address owner => uint64) private _lastRaised;
    /// @dev Venues pinned by the constructor. Nothing writes this array afterwards.
    IVenue[] private _venues;

    /// @notice Pins the factory's current venue list and its guard's current thresholds.
    /// @dev Reverts with `ZeroAddress`, `InvalidTiming`, `GuardNotSet` (the factory has no guard),
    /// `InvalidThresholds` (unless `target > min > 1e18`) or `InvalidVenues` (empty list, more
    /// than `MAX_VENUES`, or a venue without code). Check the pinned values with `venues()`,
    /// `minHealthFactor()` and `targetHealthFactor()` after deployment: they never change.
    /// @param factory_ Ardoise factory on Arc.
    /// @param messageTransmitter_ CCTP V2 MessageTransmitter on Arc.
    /// @param executorDomain_ CCTP domain of the executor's chain (6 for Base).
    /// @param cooldownPeriod_ Minimum time between two alarms for the same owner, in seconds; at
    /// least `alarmTtl_`. Funds in flight are covered by the executor's `minDefenseInterval`.
    /// @param alarmTtl_ Validity of an alarm on the executor's chain, in seconds.
    /// @param honorsSimulation_ `false` for production: the alarm decides on the venues' own
    /// health factors. `true` only for an alarm paired with a demo-only executor: the alarm then
    /// decides on the guard's simulated health factor (see the contract's notes).
    constructor(
        IArdoiseFactory factory_,
        IMessageTransmitterV2 messageTransmitter_,
        uint32 executorDomain_,
        uint64 cooldownPeriod_,
        uint64 alarmTtl_,
        bool honorsSimulation_
    ) {
        if (address(factory_) == address(0) || address(messageTransmitter_) == address(0)) {
            revert ZeroAddress();
        }
        // A second alarm must not exist while the first can still be executed.
        if (alarmTtl_ == 0 || cooldownPeriod_ < alarmTtl_) revert InvalidTiming(cooldownPeriod_, alarmTtl_);

        IGuard guard = factory_.guard();
        if (address(guard) == address(0)) revert GuardNotSet();
        uint256 minHf = guard.minHealthFactor();
        uint256 targetHf = guard.targetHealthFactor();
        // Same rule as `MarginGuard`, checked again because the factory accepts any guard: a
        // minimum at or under 1 would only fire once the venue can liquidate, and a target at or
        // under the minimum would make `shortfall` underflow or ask for nothing.
        if (minHf <= LIQUIDATION_HEALTH_FACTOR || targetHf <= minHf) revert InvalidThresholds(minHf, targetHf);

        IVenue[] memory list = factory_.venues();
        if (list.length == 0 || list.length > MAX_VENUES) revert InvalidVenues();
        for (uint256 i = 0; i < list.length; ++i) {
            // A venue without code cannot be skipped by the try/catch in `_measure`: decoding its
            // empty answer would revert `raise` for every owner, with no way to remove it.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (address(list[i]).code.length == 0) revert InvalidVenues();
            _venues.push(list[i]);
        }

        factory = factory_;
        messageTransmitter = messageTransmitter_;
        executorDomain = executorDomain_;
        cooldownPeriod = cooldownPeriod_;
        alarmTtl = alarmTtl_;
        deployer = msg.sender;
        minHealthFactor = minHf;
        targetHealthFactor = targetHf;
        honorsSimulation = honorsSimulation_;
        // A production alarm keeps no guard address at all, so nothing in it can call the guard.
        simulationGuard = honorsSimulation_ ? address(guard) : address(0);
    }

    /// @inheritdoc IDefenseAlarm
    function venues() external view returns (IVenue[] memory) {
        return _venues;
    }

    /// @inheritdoc IDefenseAlarm
    function setExecutor(address executor_) external {
        if (msg.sender != deployer) revert NotDeployer(msg.sender);
        if (executor != bytes32(0) || executor_ == address(0)) revert ExecutorAlreadySet();
        executor = bytes32(uint256(uint160(executor_)));
        emit ExecutorSet(executor);
    }

    /// @inheritdoc IDefenseAlarm
    function cooldown(address owner) public view returns (uint64 nextAllowed) {
        uint64 last = _lastRaised[owner];
        return last == 0 ? 0 : last + cooldownPeriod;
    }

    // The venue list is pinned at construction and at most `MAX_VENUES` long.
    // forge-lint: disable-next-item(calls-loop)
    /// @inheritdoc IDefenseAlarm
    /// @dev The first pinned venue whose health factor (see `honorsSimulation`) is under the
    /// pinned minimum is used. Health factors scale with 1 / debt at constant collateral, so
    /// repaying `debt x (target - health) / target` restores the target; the result is capped at
    /// the owner's debt on that venue, then reduced by the venue's asset already on the owner's
    /// account. That balance repays the debt on the next `sweep()`, so the executor is never asked
    /// for it, whether or not the sweep in `raise` ran (a caller can starve a repayment nested in
    /// the sweep of gas without the sweep reverting).
    function shortfall(address owner) public view returns (IVenue venue, uint256 amountNeeded) {
        uint256 minHf = minHealthFactor;
        uint256 targetHf = targetHealthFactor;
        uint256 count = _venues.length;
        for (uint256 i = 0; i < count; ++i) {
            IVenue candidate = _venues[i];
            (bool ok, uint256 hf, uint256 debtUsd, uint256 debt) = _measure(candidate, owner);
            if (!ok || hf >= minHf) continue;
            uint256 usdWad = _ceilDiv(debtUsd * (targetHf - hf), targetHf);
            uint256 usdc = _ceilDiv(usdWad, WAD_PER_USDC_UNIT);
            if (usdc > debt) usdc = debt;
            address account = address(factory.accountOf(owner));
            uint256 idle = account == address(0) ? 0 : IERC20(candidate.asset()).balanceOf(account);
            return (candidate, usdc > idle ? usdc - idle : 0);
        }
    }

    // The account and the transmitter come from the factory and CCTP; the cooldown is written
    // before the sweep, and what follows is the nonce and the message.
    // forge-lint: disable-next-item(block-timestamp, reentrancy-events, reentrancy-no-eth)
    /// @inheritdoc IDefenseAlarm
    /// @dev Sends `DefenseMessage.encode(owner, account, amountNeeded, nonce, expiry)` to the
    /// executor at finality 2000, with no destination caller, so anyone can relay it.
    function raise(address owner) external returns (uint64 nonce) {
        bytes32 executor_ = executor;
        if (executor_ == bytes32(0)) revert ExecutorNotSet();
        address account = address(factory.accountOf(owner));
        if (account == address(0)) revert NoAccount(owner);
        uint64 nextAllowed = cooldown(owner);
        if (nextAllowed != 0 && block.timestamp < nextAllowed) revert CoolingDown(nextAllowed);
        // Start the cooldown before any external call, so nothing reached from the sweep can raise
        // a second alarm in the same transaction; a revert below rolls it back.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp); // fits until the year 584 billion
        _lastRaised[owner] = nowTs;
        // USDC already on the account (an earlier defense, a Gateway repayment) is applied first,
        // so the alarm asks Base only for what is still missing. `sweep()` is public and can only
        // reduce debt; a failing sweep must not block the alarm.
        if (account.code.length > 0) {
            uint256 gasBefore = gasleft();
            try IArdoise(account).sweep() {}
            catch {
                // A caller must not skip the sweep by starving it of gas: the call gets 63/64 of
                // what is left, so an out-of-gas failure leaves less than 1/64 behind.
                if (gasleft() <= gasBefore / 63) revert SweepOutOfGas();
            }
        }
        (, uint256 amountNeeded) = shortfall(owner);
        if (amountNeeded == 0) revert PositionHealthy(owner);

        nonce = ++lastNonce;
        uint64 expiry = nowTs + alarmTtl;
        messageTransmitter.sendMessage(
            executorDomain,
            executor_,
            bytes32(0),
            FINALITY,
            DefenseMessage.encode(DefenseMessage.Alarm(owner, account, amountNeeded, nonce, expiry))
        );
        emit AlarmRaised(owner, account, amountNeeded, nonce, expiry);
    }

    // Called once per pinned venue.
    // forge-lint: disable-next-item(calls-loop, unused-return)
    /// @dev The owner's position on `venue`: its health factor, the debt in USD (WAD) and in the
    /// venue's asset. The health factor is the venue's own, except on a simulation-honoring alarm,
    /// where it is the pinned guard's simulated one (the venue's own if that guard read reverts).
    /// `ok` is false when the venue reverts, so one failing venue does not block the others (a
    /// venue returning malformed data still reverts the call; venues are pinned at construction).
    function _measure(IVenue venue, address owner)
        private
        view
        returns (bool ok, uint256 hf, uint256 debtUsd, uint256 debt)
    {
        try venue.health(owner) returns (uint256 h, uint256, uint256 d) {
            (hf, debtUsd) = (h, d);
        } catch {
            return (ok, hf, debtUsd, debt);
        }
        try venue.debtOf(owner) returns (uint256 d) {
            debt = d;
        } catch {
            return (ok, hf, debtUsd, debt);
        }
        if (honorsSimulation) {
            try ISimulatedHealth(simulationGuard).simulatedHealth(venue, owner) returns (uint256 simulated) {
                hf = simulated;
            } catch {
                // Keep the venue's own health factor: a broken guard must not silence real alarms.
            }
        }
        ok = true;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
