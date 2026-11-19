// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMessageTransmitterV2} from "../cctp/IMessageTransmitterV2.sol";
import {IArdoise} from "../interfaces/IArdoise.sol";
import {IArdoiseFactory} from "../interfaces/IArdoiseFactory.sol";
import {IGuard} from "../interfaces/IGuard.sol";
import {IVenue} from "../interfaces/IVenue.sol";
import {DefenseMessage} from "./DefenseMessage.sol";
import {IDefenseAlarm} from "./interfaces/IDefenseAlarm.sol";

/// @notice The guard view the alarm reads, implemented by `MarginGuard` (not part of `IGuard`).
interface ISimulatedHealth {
    /// @notice Health factor of `user` on `venue` as the guard sees it, simulated drop included.
    function simulatedHealth(IVenue venue, address user) external view returns (uint256 healthFactor);
}

/// @title DefenseAlarm
/// @notice Proves on Arc that an Ardoise position is under the guard's minimum health factor and
/// sends that proof, through CCTP V2 generic messaging attested by Circle, to the
/// `DefenseExecutor` on Base, which may then spend the owner's pre-authorized funds there to
/// repay the debt. Anyone may raise an alarm: the condition is checked here, on chain, so the
/// relayer decides nothing.
/// @dev Holds no funds. The factory, and through it the guard and the venues, is read on every
/// call, so a new guard or venue list is picked up without redeploying; a new factory needs a new
/// alarm and a new executor. The executor address is set once by the deployer after the executor
/// is deployed on Base, since each contract needs the other's address.
contract DefenseAlarm is IDefenseAlarm {
    /// @dev USD values are WAD; USDC has 6 decimals and is valued at 1 USD by the venues.
    uint256 private constant WAD_PER_USDC_UNIT = 1e12;
    /// @dev Standard finality: Arc is final at once and Circle attests in about 0.5 s.
    uint32 private constant FINALITY = 2000;
    /// @notice Gas that must be left before the sweep: several times what `sweep()` costs with no
    /// balance (about 67k on Arc mainnet), enough to repay a few lines, so a caller cannot pick a
    /// gas limit at which the sweep runs out of gas in a nested call and is skipped.
    uint256 public constant MIN_SWEEP_GAS = 500_000;

    /// @notice Registry of Ardoise accounts, venues and guard.
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
    bytes32 public executor;
    /// @inheritdoc IDefenseAlarm
    uint64 public lastNonce;
    /// @dev Timestamp of each owner's last alarm.
    mapping(address owner => uint64) private _lastRaised;

    /// @param factory_ Ardoise factory on Arc.
    /// @param messageTransmitter_ CCTP V2 MessageTransmitter on Arc.
    /// @param executorDomain_ CCTP domain of the executor's chain (6 for Base).
    /// @param cooldownPeriod_ Minimum time between two alarms for the same owner, in seconds; at
    /// least `alarmTtl_`. Funds in flight are covered by the executor's `minDefenseInterval`.
    /// @param alarmTtl_ Validity of an alarm on the executor's chain, in seconds.
    constructor(
        IArdoiseFactory factory_,
        IMessageTransmitterV2 messageTransmitter_,
        uint32 executorDomain_,
        uint64 cooldownPeriod_,
        uint64 alarmTtl_
    ) {
        if (address(factory_) == address(0) || address(messageTransmitter_) == address(0)) {
            revert ZeroAddress();
        }
        // A second alarm must not exist while the first can still be executed.
        if (alarmTtl_ == 0 || cooldownPeriod_ < alarmTtl_) revert InvalidTiming(cooldownPeriod_, alarmTtl_);
        factory = factory_;
        messageTransmitter = messageTransmitter_;
        executorDomain = executorDomain_;
        cooldownPeriod = cooldownPeriod_;
        alarmTtl = alarmTtl_;
        deployer = msg.sender;
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

    // The venue list is admin-set and short.
    // forge-lint: disable-next-item(calls-loop)
    /// @inheritdoc IDefenseAlarm
    /// @dev The first venue in the factory's list whose (simulated) health factor is under the
    /// minimum is used. Health factors scale with 1 / debt at constant collateral, so repaying
    /// `debt x (target - health) / target` restores the target; the result is capped at the
    /// owner's debt on that venue.
    function shortfall(address owner) public view returns (IVenue venue, uint256 amountNeeded) {
        IGuard guard = factory.guard();
        if (address(guard) == address(0)) revert GuardNotSet();
        uint256 minHf = guard.minHealthFactor();
        uint256 targetHf = guard.targetHealthFactor();
        IVenue[] memory list = factory.venues();
        for (uint256 i = 0; i < list.length; ++i) {
            (bool ok, uint256 hf, uint256 debtUsd, uint256 debt) = _measure(guard, list[i], owner);
            if (!ok || hf >= minHf) continue;
            uint256 usdWad = _ceilDiv(debtUsd * (targetHf - hf), targetHf);
            uint256 usdc = _ceilDiv(usdWad, WAD_PER_USDC_UNIT);
            return (list[i], usdc < debt ? usdc : debt);
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
            // A caller must not skip the sweep by starving it of gas: the floor covers a sweep and
            // the calls inside it, and the 63/64 check catches a sweep that ran out of gas in its
            // own frame (it gets 63/64 of what is left, so under 1/64 remains).
            if (gasBefore < MIN_SWEEP_GAS) revert SweepOutOfGas();
            try IArdoise(account).sweep() {}
            catch {
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

    // Called once per venue of the short, admin-set list.
    // forge-lint: disable-next-item(calls-loop, unused-return)
    /// @dev The owner's position on `venue`: the guard's simulated health factor (the venue's own
    /// when the guard has no simulation), the debt in USD (WAD) and in the venue's asset. `ok` is
    /// false when the venue reverts, so one failing venue does not block the others (a venue
    /// returning malformed data still reverts the call; venues are admin-set).
    function _measure(IGuard guard, IVenue venue, address owner)
        private
        view
        returns (bool ok, uint256 hf, uint256 debtUsd, uint256 debt)
    {
        uint256 venueHf = 0;
        try venue.health(owner) returns (uint256 h, uint256, uint256 d) {
            (venueHf, debtUsd) = (h, d);
        } catch {
            return (ok, hf, debtUsd, debt);
        }
        try venue.debtOf(owner) returns (uint256 d) {
            debt = d;
        } catch {
            return (ok, hf, debtUsd, debt);
        }
        try ISimulatedHealth(address(guard)).simulatedHealth(venue, owner) returns (uint256 simulated) {
            hf = simulated;
        } catch {
            hf = venueHf;
        }
        ok = true;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
