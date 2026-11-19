// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IMessageTransmitterV2} from "../../src/cctp/IMessageTransmitterV2.sol";
import {DefenseAlarm} from "../../src/defense/DefenseAlarm.sol";
import {IDefenseAlarm} from "../../src/defense/interfaces/IDefenseAlarm.sol";
import {MarginGuard} from "../../src/guard/MarginGuard.sol";
import {IArdoiseFactory} from "../../src/interfaces/IArdoiseFactory.sol";
import {IGuard} from "../../src/interfaces/IGuard.sol";
import {IVenue} from "../../src/interfaces/IVenue.sol";
import {MockVenue} from "../guard/MockVenue.sol";
import {DefenseFactoryMock, MessageTransmitterMock} from "./DefenseMocks.sol";

/// @notice Unit tests of `DefenseAlarm` with the real `MarginGuard`, a mock venue and a mock
/// MessageTransmitter.
contract DefenseAlarmTest is Test {
    uint32 internal constant BASE = 6;
    uint64 internal constant COOLDOWN = 10 minutes;
    uint64 internal constant TTL = 1 hours;

    DefenseFactoryMock internal factory;
    MessageTransmitterMock internal transmitter;
    MarginGuard internal guard;
    MockVenue internal venue;
    DefenseAlarm internal alarm;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal account = makeAddr("account");
    address internal executor = makeAddr("executor");

    function setUp() public {
        vm.warp(1_795_000_000);
        factory = new DefenseFactoryMock();
        transmitter = new MessageTransmitterMock();
        guard = new MarginGuard(admin, 1.25e18, 1.5e18);
        venue = new MockVenue(0.78e18);
        IVenue[] memory list = new IVenue[](1);
        list[0] = venue;
        factory.setVenues(list);
        factory.setGuard(guard);
        factory.setAccount(owner, account);
        // $4 of collateral at 78%, $2 of debt: health factor 1.56.
        venue.setPosition(owner, 4e18, 2e6);
        vm.prank(admin);
        alarm = new DefenseAlarm(
            IArdoiseFactory(address(factory)), IMessageTransmitterV2(address(transmitter)), BASE, COOLDOWN, TTL
        );
        vm.prank(admin);
        alarm.setExecutor(executor);
    }

    function test_setExecutor_onlyOnceByDeployer() public {
        vm.expectRevert(IDefenseAlarm.ExecutorAlreadySet.selector);
        vm.prank(admin);
        alarm.setExecutor(makeAddr("other"));

        vm.prank(admin);
        DefenseAlarm fresh = new DefenseAlarm(
            IArdoiseFactory(address(factory)), IMessageTransmitterV2(address(transmitter)), BASE, COOLDOWN, TTL
        );
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.NotDeployer.selector, owner));
        vm.prank(owner);
        fresh.setExecutor(executor);
        vm.expectRevert(IDefenseAlarm.ExecutorNotSet.selector);
        fresh.raise(owner);
    }

    function test_raise_revertsWhilePositionIsHealthy() public {
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.PositionHealthy.selector, owner));
        alarm.raise(owner);
    }

    function test_raise_underSimulatedDropSendsAlarmToExecutor() public {
        // A 30% simulated drop takes the health factor from 1.56 to 1.092, under 1.25.
        vm.prank(admin);
        guard.setSimulatedDrop(3_000);
        (, uint256 expected) = alarm.shortfall(owner);
        // Repaying debt x (1.5 - 1.092) / 1.5 of $2 brings it back to 1.5: 0.544 USDC.
        assertEq(expected, 544_000);

        vm.expectEmit(address(alarm));
        emit IDefenseAlarm.AlarmRaised(owner, account, 544_000, 1, uint64(block.timestamp) + TTL);
        vm.prank(makeAddr("anyone"));
        uint64 nonce = alarm.raise(owner);

        assertEq(nonce, 1);
        (uint32 domain, bytes32 recipient, bytes32 caller, uint32 finality, bytes memory body) = transmitter.last();
        assertEq(domain, BASE);
        assertEq(recipient, bytes32(uint256(uint160(executor))));
        assertEq(caller, bytes32(0));
        assertEq(finality, 2000);
        assertEq(body, abi.encode(owner, account, uint256(544_000), uint64(1), uint64(block.timestamp) + TTL));
    }

    function test_raise_amountRestoresTargetHealth() public {
        vm.prank(admin);
        guard.setSimulatedDrop(3_000);
        (, uint256 amount) = alarm.shortfall(owner);
        venue.setPosition(owner, 4e18, 2e6 - amount);
        // Within rounding of the guard's scaling: the target is reached to the wei.
        assertApproxEqAbs(guard.simulatedHealth(venue, owner), 1.5e18, 10);
    }

    function test_raise_realPositionUnderMinimum() public {
        venue.setPosition(owner, 4e18, 3e6); // health factor 1.04, no simulation
        alarm.raise(owner);
        assertEq(transmitter.count(), 1);
    }

    function test_raise_cooldownPerOwner() public {
        venue.setPosition(owner, 4e18, 3e6);
        alarm.raise(owner);
        uint64 next = uint64(block.timestamp) + COOLDOWN;
        assertEq(alarm.cooldown(owner), next);
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.CoolingDown.selector, next));
        alarm.raise(owner);

        // Another owner is not affected.
        address other = makeAddr("other");
        factory.setAccount(other, makeAddr("otherAccount"));
        venue.setPosition(other, 4e18, 3e6);
        assertEq(alarm.raise(other), 2);

        vm.warp(next);
        assertEq(alarm.raise(owner), 3);
    }

    function test_raise_capsAmountAtVenueDebt() public {
        venue.setPosition(owner, 0, 3e6); // no collateral: health factor 0
        (, uint256 amount) = alarm.shortfall(owner);
        assertEq(amount, 3e6);
    }

    function test_raise_revertsWithoutAccountOrGuard() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.NoAccount.selector, stranger));
        alarm.raise(stranger);
        factory.setGuard(IGuard(address(0)));
        vm.expectRevert(IDefenseAlarm.GuardNotSet.selector);
        alarm.raise(owner);
    }

    function test_cooldown_isZeroBeforeFirstAlarm() public view {
        assertEq(alarm.cooldown(owner), 0);
    }
}
