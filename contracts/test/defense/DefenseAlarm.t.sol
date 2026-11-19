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
import {MockToken} from "../venues/mocks/MockAaveV4.sol";
import {
    DefenseFactoryMock,
    MessageTransmitterMock,
    GasHungryAccountMock,
    LooseGuardMock,
    LyingVenueMock,
    RevertingVenueMock,
    SweepingAccountMock
} from "./DefenseMocks.sol";

/// @notice Unit tests of `DefenseAlarm` with the real `MarginGuard`, a mock venue and a mock
/// MessageTransmitter. `alarm` is a production alarm (venues' real health factors); `demoAlarm`
/// honors the guard's simulated drop.
contract DefenseAlarmTest is Test {
    uint32 internal constant BASE = 6;
    uint64 internal constant COOLDOWN = 30 minutes;
    uint64 internal constant TTL = 10 minutes;

    DefenseFactoryMock internal factory;
    MessageTransmitterMock internal transmitter;
    MarginGuard internal guard;
    MockVenue internal venue;
    MockToken internal usdc;
    DefenseAlarm internal alarm;
    DefenseAlarm internal demoAlarm;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal account = makeAddr("account");
    address internal executor = makeAddr("executor");
    address internal demoExecutor = makeAddr("demoExecutor");

    function setUp() public {
        vm.warp(1_795_000_000);
        factory = new DefenseFactoryMock();
        transmitter = new MessageTransmitterMock();
        guard = new MarginGuard(admin, 1.25e18, 1.5e18);
        venue = new MockVenue(0.78e18);
        usdc = new MockToken(6);
        venue.setAsset(address(usdc));
        IVenue[] memory list = new IVenue[](1);
        list[0] = venue;
        factory.setVenues(list);
        factory.setGuard(guard);
        factory.setAccount(owner, account);
        // $4 of collateral at 78%, $2 of debt: health factor 1.56.
        venue.setPosition(owner, 4e18, 2e6);
        alarm = _deploy(false);
        demoAlarm = _deploy(true);
        vm.startPrank(admin);
        alarm.setExecutor(executor);
        demoAlarm.setExecutor(demoExecutor);
        vm.stopPrank();
    }

    /// @dev Deploys an alarm from `admin`, pinning the factory's venues and guard as they are now.
    function _deploy(bool honorsSimulation) internal returns (DefenseAlarm) {
        vm.prank(admin);
        return new DefenseAlarm(
            IArdoiseFactory(address(factory)),
            IMessageTransmitterV2(address(transmitter)),
            BASE,
            COOLDOWN,
            TTL,
            honorsSimulation
        );
    }

    function _expectHealthy(DefenseAlarm target) internal {
        (IVenue chosen, uint256 amount) = target.shortfall(owner);
        assertEq(address(chosen), address(0));
        assertEq(amount, 0);
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.PositionHealthy.selector, owner));
        target.raise(owner);
    }

    function _lastAmount() internal view returns (uint256 amount) {
        (,,,, bytes memory body) = transmitter.last();
        (,, amount,,) = abi.decode(body, (address, address, uint256, uint64, uint64));
    }

    // ----- What the constructor pins -----

    function test_constructor_pinsVenuesThresholdsAndHealthSource() public view {
        IVenue[] memory pinned = alarm.venues();
        assertEq(pinned.length, 1);
        assertEq(address(pinned[0]), address(venue));
        assertEq(alarm.minHealthFactor(), 1.25e18);
        assertEq(alarm.targetHealthFactor(), 1.5e18);
        assertFalse(alarm.honorsSimulation());
        // A production alarm keeps no guard to call.
        assertEq(alarm.simulationGuard(), address(0));

        assertTrue(demoAlarm.honorsSimulation());
        assertEq(demoAlarm.simulationGuard(), address(guard));
    }

    function test_constructor_revertsWithoutGuardOnTheFactory() public {
        factory.setGuard(IGuard(address(0)));
        vm.expectRevert(IDefenseAlarm.GuardNotSet.selector);
        _deploy(false);
    }

    function test_constructor_rejectsEmptyOversizedOrCodelessVenueList() public {
        factory.setVenues(new IVenue[](0));
        vm.expectRevert(IDefenseAlarm.InvalidVenues.selector);
        _deploy(false);

        IVenue[] memory tooMany = new IVenue[](alarm.MAX_VENUES() + 1);
        for (uint256 i = 0; i < tooMany.length; ++i) {
            tooMany[i] = venue;
        }
        factory.setVenues(tooMany);
        vm.expectRevert(IDefenseAlarm.InvalidVenues.selector);
        _deploy(false);

        // The zero address, then an address without code.
        IVenue[] memory codeless = new IVenue[](2);
        codeless[0] = venue;
        factory.setVenues(codeless);
        vm.expectRevert(IDefenseAlarm.InvalidVenues.selector);
        _deploy(false);
        codeless[1] = IVenue(makeAddr("notAContract"));
        factory.setVenues(codeless);
        vm.expectRevert(IDefenseAlarm.InvalidVenues.selector);
        _deploy(false);
    }

    function test_constructor_rejectsThresholdsOutOfOrder() public {
        // A minimum at the liquidation point.
        factory.setGuard(IGuard(address(new LooseGuardMock(1e18, 1.5e18))));
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.InvalidThresholds.selector, 1e18, 1.5e18));
        _deploy(false);
        // A target that is not above the minimum.
        factory.setGuard(IGuard(address(new LooseGuardMock(1.25e18, 1.25e18))));
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.InvalidThresholds.selector, 1.25e18, 1.25e18));
        _deploy(true);
    }

    function test_constructor_rejectsTtlLongerThanCooldown() public {
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.InvalidTiming.selector, uint64(600), uint64(601)));
        new DefenseAlarm(
            IArdoiseFactory(address(factory)), IMessageTransmitterV2(address(transmitter)), BASE, 600, 601, false
        );
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.InvalidTiming.selector, uint64(600), uint64(0)));
        new DefenseAlarm(
            IArdoiseFactory(address(factory)), IMessageTransmitterV2(address(transmitter)), BASE, 600, 0, false
        );
    }

    function test_setExecutor_onlyOnceByDeployer() public {
        vm.expectRevert(IDefenseAlarm.ExecutorAlreadySet.selector);
        vm.prank(admin);
        alarm.setExecutor(makeAddr("other"));

        DefenseAlarm fresh = _deploy(false);
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.NotDeployer.selector, owner));
        vm.prank(owner);
        fresh.setExecutor(executor);
        vm.expectRevert(IDefenseAlarm.ExecutorNotSet.selector);
        fresh.raise(owner);
    }

    // ----- Changes on the factory and the guard after deployment do not reach the alarm -----

    function test_raise_ignoresVenueListedAfterDeployment() public {
        // The factory admin lists a venue that reports health 0 and a huge debt for everyone,
        // ahead of the honest one. The owner's real position is healthy (1.56).
        IVenue[] memory list = new IVenue[](2);
        list[0] = IVenue(address(new LyingVenueMock()));
        list[1] = venue;
        factory.setVenues(list);

        _expectHealthy(alarm);
        _expectHealthy(demoAlarm);
        assertEq(alarm.venues().length, 1);
        assertEq(address(alarm.venues()[0]), address(venue));
        assertEq(transmitter.count(), 0);
    }

    function test_raise_ignoresGuardReplacedOnTheFactory() public {
        // A new guard under which the position (1.56) would be far below the minimum, with the
        // largest simulated drop on top.
        MarginGuard strict = new MarginGuard(admin, 2e18, 3e18);
        vm.prank(admin);
        strict.setSimulatedDrop(9_000);
        factory.setGuard(strict);

        _expectHealthy(alarm);
        // The demo alarm keeps reading the guard it pinned, whose simulation is off.
        _expectHealthy(demoAlarm);
        assertEq(alarm.minHealthFactor(), 1.25e18);
        assertEq(demoAlarm.simulationGuard(), address(guard));
    }

    function test_raise_ignoresGuardRemovedFromTheFactory() public {
        factory.setGuard(IGuard(address(0)));
        venue.setPosition(owner, 4e18, 3e6); // health factor 1.04
        alarm.raise(owner);
        assertEq(_lastAmount(), 920_000);
    }

    function test_raise_ignoresThresholdsRaisedOnTheGuard() public {
        vm.prank(admin);
        guard.setThresholds(2e18, 3e18);
        // 1.56 is under the guard's new minimum of 2, not under the pinned 1.25.
        _expectHealthy(alarm);
        _expectHealthy(demoAlarm);

        // Really under the pinned minimum: the amount restores the pinned target of 1.5, not 3.
        venue.setPosition(owner, 4e18, 3e6); // health factor 1.04
        alarm.raise(owner);
        // $3 of debt at 1.04 needs 3 x (1.5 - 1.04) / 1.5 = 0.92 USDC.
        assertEq(_lastAmount(), 920_000);
    }

    // ----- Production alarm: the venues' real health factors -----

    function test_raise_revertsWhilePositionIsHealthy() public {
        _expectHealthy(alarm);
        _expectHealthy(demoAlarm);
    }

    function test_raise_productionAlarmIgnoresSimulatedDrop() public {
        // The largest simulated drop takes the guard's view of the position from 1.56 to 0.156.
        vm.prank(admin);
        guard.setSimulatedDrop(9_000);
        assertLt(guard.simulatedHealth(venue, owner), 1.25e18);
        _expectHealthy(alarm);
        assertEq(transmitter.count(), 0);
    }

    function test_raise_productionAlarmMeasuresRealHealthUnderSimulatedDrop() public {
        venue.setPosition(owner, 4e18, 3e6); // health factor 1.04
        vm.prank(admin);
        guard.setSimulatedDrop(3_000);
        // The simulated health factor (0.728) would ask for more: the real one decides.
        (IVenue chosen, uint256 amount) = alarm.shortfall(owner);
        assertEq(address(chosen), address(venue));
        assertEq(amount, 920_000);
    }

    function test_raise_realPositionUnderMinimumSendsAlarmToExecutor() public {
        venue.setPosition(owner, 4e18, 3e6); // health factor 1.04, no simulation
        (, uint256 expected) = alarm.shortfall(owner);
        // Repaying debt x (1.5 - 1.04) / 1.5 of $3 brings it back to 1.5: 0.92 USDC.
        assertEq(expected, 920_000);

        vm.expectEmit(address(alarm));
        emit IDefenseAlarm.AlarmRaised(owner, account, 920_000, 1, uint64(block.timestamp) + TTL);
        vm.prank(makeAddr("anyone"));
        uint64 nonce = alarm.raise(owner);

        assertEq(nonce, 1);
        (uint32 domain, bytes32 recipient, bytes32 caller, uint32 finality, bytes memory body) = transmitter.last();
        assertEq(domain, BASE);
        assertEq(recipient, bytes32(uint256(uint160(executor))));
        assertEq(caller, bytes32(0));
        assertEq(finality, 2000);
        assertEq(body, abi.encode(owner, account, uint256(920_000), uint64(1), uint64(block.timestamp) + TTL));
    }

    function test_raise_amountRestoresTargetHealth() public {
        venue.setPosition(owner, 4e18, 3e6);
        (, uint256 amount) = alarm.shortfall(owner);
        venue.setPosition(owner, 4e18, 3e6 - amount);
        (uint256 healthFactor,,) = venue.health(owner);
        assertApproxEqAbs(healthFactor, 1.5e18, 10);
    }

    // ----- Demo alarm: the pinned guard's simulated health factor -----

    function test_raise_demoAlarmUnderSimulatedDropSendsAlarmToItsExecutor() public {
        // A 30% simulated drop takes the health factor from 1.56 to 1.092, under 1.25.
        vm.prank(admin);
        guard.setSimulatedDrop(3_000);
        (, uint256 expected) = demoAlarm.shortfall(owner);
        // Repaying debt x (1.5 - 1.092) / 1.5 of $2 brings it back to 1.5: 0.544 USDC.
        assertEq(expected, 544_000);

        vm.expectEmit(address(demoAlarm));
        emit IDefenseAlarm.AlarmRaised(owner, account, 544_000, 1, uint64(block.timestamp) + TTL);
        vm.prank(makeAddr("anyone"));
        uint64 nonce = demoAlarm.raise(owner);

        assertEq(nonce, 1);
        (uint32 domain, bytes32 recipient, bytes32 caller, uint32 finality, bytes memory body) = transmitter.last();
        assertEq(domain, BASE);
        assertEq(recipient, bytes32(uint256(uint160(demoExecutor))));
        assertEq(caller, bytes32(0));
        assertEq(finality, 2000);
        assertEq(body, abi.encode(owner, account, uint256(544_000), uint64(1), uint64(block.timestamp) + TTL));
    }

    function test_raise_demoAlarmAmountRestoresSimulatedTargetHealth() public {
        vm.prank(admin);
        guard.setSimulatedDrop(3_000);
        (, uint256 amount) = demoAlarm.shortfall(owner);
        venue.setPosition(owner, 4e18, 2e6 - amount);
        // Within rounding of the guard's scaling: the target is reached to the wei.
        assertApproxEqAbs(guard.simulatedHealth(venue, owner), 1.5e18, 10);
    }

    function test_raise_demoAlarmMeasuresRealHealthWithoutSimulation() public {
        venue.setPosition(owner, 4e18, 3e6);
        demoAlarm.raise(owner);
        assertEq(_lastAmount(), 920_000);
    }

    // ----- Behavior shared by both alarms -----

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

    function test_raise_revertsWithoutAccount() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.NoAccount.selector, stranger));
        alarm.raise(stranger);
    }

    function test_raise_sweepsAccountBeforeMeasuring() public {
        SweepingAccountMock swept = new SweepingAccountMock();
        factory.setAccount(owner, address(swept));
        venue.setPosition(owner, 4e18, 3e6); // health factor 1.04
        // USDC already on the account brings the debt to $2.2: health factor 1.418 >= 1.25, so the
        // position is healthy once swept and no alarm is sent.
        swept.setSweepEffect(address(venue), owner, 4e18, 2.2e6);
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.PositionHealthy.selector, owner));
        alarm.raise(owner);

        // With less on the account, only what is still missing is requested.
        swept.setSweepEffect(address(venue), owner, 4e18, 2.6e6);
        alarm.raise(owner);
        assertEq(swept.sweeps(), 1);
        // $2.6 of debt at health factor 1.2 needs 2.6 x (1.5 - 1.2) / 1.5 = 0.52 USDC.
        assertEq(_lastAmount(), 520_000);
    }

    function test_raise_proceedsWhenSweepReverts() public {
        SweepingAccountMock swept = new SweepingAccountMock();
        swept.setBroken(true);
        factory.setAccount(owner, address(swept));
        venue.setPosition(owner, 4e18, 3e6);
        alarm.raise(owner);
        assertEq(transmitter.count(), 1);
    }

    function test_raise_deductsUsdcLeftOnTheAccount() public {
        // A sweep that did not repay (skipped, starved of gas or refused by the venue) leaves the
        // USDC on the account: the alarm must not ask Base for it again.
        SweepingAccountMock swept = new SweepingAccountMock();
        swept.setBroken(true);
        factory.setAccount(owner, address(swept));
        venue.setPosition(owner, 4e18, 3e6);
        (, uint256 full) = alarm.shortfall(owner);
        usdc.mint(address(swept), 0.2e6);
        (, uint256 reduced) = alarm.shortfall(owner);
        assertEq(reduced, full - 0.2e6);

        alarm.raise(owner);
        assertEq(_lastAmount(), full - 0.2e6);
    }

    function test_raise_revertsWhenUsdcOnTheAccountCoversTheShortfall() public {
        SweepingAccountMock swept = new SweepingAccountMock();
        swept.setBroken(true);
        factory.setAccount(owner, address(swept));
        venue.setPosition(owner, 4e18, 3e6);
        (, uint256 full) = alarm.shortfall(owner);
        usdc.mint(address(swept), full);
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.PositionHealthy.selector, owner));
        alarm.raise(owner);
    }

    function test_raise_revertsWhenSweepIsStarvedOfGas() public {
        GasHungryAccountMock hungry = new GasHungryAccountMock();
        factory.setAccount(owner, address(hungry));
        venue.setPosition(owner, 4e18, 3e6);
        // Enough gas for the rest of raise, not for the sweep's loop.
        vm.expectRevert(IDefenseAlarm.SweepOutOfGas.selector);
        alarm.raise{gas: 300_000}(owner);
    }

    function test_shortfall_skipsVenueThatReverts() public {
        IVenue[] memory list = new IVenue[](2);
        list[0] = IVenue(address(new RevertingVenueMock()));
        list[1] = venue;
        factory.setVenues(list);
        DefenseAlarm twoVenues = _deploy(false);
        venue.setPosition(owner, 4e18, 3e6);
        (IVenue chosen, uint256 amount) = twoVenues.shortfall(owner);
        assertEq(address(chosen), address(venue));
        assertGt(amount, 0);
    }

    function test_cooldown_isZeroBeforeFirstAlarm() public view {
        assertEq(alarm.cooldown(owner), 0);
    }
}
