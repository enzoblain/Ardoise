// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {MarginGuard} from "../../src/guard/MarginGuard.sol";
import {IGuard} from "../../src/interfaces/IGuard.sol";
import {IVenue} from "../../src/interfaces/IVenue.sol";
import {MockVenue} from "./MockVenue.sol";

/// @notice Tests of the margin check and of the threshold administration.
/// @dev Reference position: 10,000 USD of collateral with a 78% liquidation threshold (the
/// cirBTC collateral factor on the Aave V4 Main Spoke), so 7,800 USD of risk-adjusted
/// collateral. With a 1.25 minimum health factor the debt may reach 7,800 / 1.25 = 6,240 USDC.
contract MarginGuardTest is Test {
    uint256 private constant MIN_HF = 1.25e18;
    uint256 private constant TARGET_HF = 1.5e18;
    uint256 private constant USDC = 1e6;
    uint256 private constant COLLATERAL_USD = 10_000e18;
    uint256 private constant MAX_DEBT = 6_240 * USDC;

    address private owner = makeAddr("owner");
    address private user = makeAddr("user");

    MarginGuard private guard;
    MockVenue private venue;

    function setUp() public {
        guard = new MarginGuard(owner, MIN_HF, TARGET_HF);
        venue = new MockVenue(0.78e18);
        venue.setPosition(user, COLLATERAL_USD, 0);
    }

    // --- checkMargin ---

    function test_checkMargin_returnsFullAmountWhenSafe() public view {
        assertEq(guard.checkMargin(user, venue, 100 * USDC), 100 * USDC);
    }

    function test_checkMargin_returnsFullAmountExactlyAtThreshold() public view {
        assertEq(venue.healthAfter(user, MAX_DEBT), MIN_HF);
        assertEq(guard.checkMargin(user, venue, MAX_DEBT), MAX_DEBT);
    }

    function test_checkMargin_safePaymentCostsOneProjection() public {
        // pay() calls the guard on-chain: the safe path must not start the search.
        vm.expectCall(address(venue), abi.encodeCall(IVenue.healthAfter, (user, 100 * USDC)), 1);
        vm.expectCall(address(venue), abi.encodeCall(IVenue.healthAfter, (user, 0)), 0);
        guard.checkMargin(user, venue, 100 * USDC);
    }

    function test_checkMargin_refusesPaymentOverThreshold() public view {
        uint256 requested = MAX_DEBT + 1;
        uint256 allowed = guard.checkMargin(user, venue, requested);
        // pay() refuses whenever the answer is lower than the requested amount.
        assertLt(allowed, requested);
        assertEq(allowed, MAX_DEBT);
    }

    function test_checkMargin_reducesToLargestBorrowablePart() public {
        venue.setPosition(user, COLLATERAL_USD, 6_000 * USDC);
        uint256 allowed = guard.checkMargin(user, venue, 1_000 * USDC);
        assertEq(allowed, 240 * USDC);
        assertGe(venue.healthAfter(user, allowed), MIN_HF);
        assertLt(venue.healthAfter(user, allowed + 1), MIN_HF);
    }

    function test_checkMargin_returnsZeroWithoutCollateral() public {
        address stranger = makeAddr("stranger");
        assertEq(guard.checkMargin(stranger, venue, 1 * USDC), 0);
    }

    function test_checkMargin_returnsZeroWhenAlreadyUnderThreshold() public {
        venue.setPosition(user, COLLATERAL_USD, 6_500 * USDC);
        assertLt(venue.healthAfter(user, 0), MIN_HF);
        assertEq(guard.checkMargin(user, venue, 1 * USDC), 0);
    }

    function test_checkMargin_returnsZeroForZeroAmount() public view {
        assertEq(guard.checkMargin(user, venue, 0), 0);
    }

    function test_checkMargin_noDebtIsLimitedByCollateralOnly() public view {
        (uint256 healthFactor,, uint256 debtUsd) = venue.health(user);
        assertEq(debtUsd, 0);
        assertEq(healthFactor, type(uint256).max);
        assertEq(guard.checkMargin(user, venue, 1_000_000 * USDC), MAX_DEBT);
    }

    function test_checkMargin_refusesAfterPriceDrop() public {
        venue.setPosition(user, COLLATERAL_USD, 5_000 * USDC);
        assertEq(guard.checkMargin(user, venue, 1_000 * USDC), 1_000 * USDC);

        // -30%: 7,000 USD of collateral allows 4,368 USDC of debt, less than the 5,000 owed.
        venue.movePrice(user, 0.7e18);
        assertEq(guard.checkMargin(user, venue, 1_000 * USDC), 0);
    }

    function test_checkMargin_followsThresholdChange() public {
        venue.setPosition(user, COLLATERAL_USD, 6_000 * USDC);
        assertEq(guard.checkMargin(user, venue, 100 * USDC), 100 * USDC);

        // At 1.5 the debt may only reach 5,200 USDC, so the same payment is now refused.
        vm.prank(owner);
        guard.setThresholds(1.5e18, 2e18);
        assertEq(guard.checkMargin(user, venue, 100 * USDC), 0);
    }

    function test_checkMargin_hugeAmountStillFindsTheExactMaximum() public view {
        // An app may pass a very large amount to ask how much can still be paid. The amount
        // stays within what the venue mock can project without overflowing.
        assertEq(guard.checkMargin(user, venue, type(uint128).max), MAX_DEBT);
    }

    function test_checkMargin_revertsWhenVenueRevertsDuringSearch() public {
        // The request is over the threshold, so the guard projects the current position next.
        vm.mockCallRevert(address(venue), abi.encodeCall(IVenue.healthAfter, (user, 0)), "oracle down");
        vm.expectRevert("oracle down");
        guard.checkMargin(user, venue, MAX_DEBT + 1);
    }

    function test_checkMargin_revertsWhenVenueReverts() public {
        // pay() must fail closed when the venue cannot project the health factor.
        vm.mockCallRevert(
            address(venue), abi.encodeCall(IVenue.healthAfter, (user, 100 * USDC)), "oracle down"
        );
        vm.expectRevert("oracle down");
        guard.checkMargin(user, venue, 100 * USDC);
    }

    function testFuzz_checkMargin_allowedIsSafeAndMaximal(uint256 collateralUsd, uint256 debt, uint256 amount)
        public
    {
        collateralUsd = bound(collateralUsd, 0, 1_000_000_000e18);
        debt = bound(debt, 0, 1_000_000_000 * USDC);
        amount = bound(amount, 1, 1_000_000_000 * USDC);
        venue.setPosition(user, collateralUsd, debt);

        uint256 allowed = guard.checkMargin(user, venue, amount);

        assertLe(allowed, amount);
        if (allowed > 0) assertGe(venue.healthAfter(user, allowed), MIN_HF);
        if (allowed < amount) assertLt(venue.healthAfter(user, allowed + 1), MIN_HF);
    }

    // --- thresholds ---

    function test_constructor_setsThresholdsAndOwner() public view {
        assertEq(guard.owner(), owner);
        assertEq(guard.minHealthFactor(), MIN_HF);
        assertEq(guard.targetHealthFactor(), TARGET_HF);
    }

    function test_constructor_emitsThresholdsUpdated() public {
        vm.expectEmit();
        emit IGuard.ThresholdsUpdated(MIN_HF, TARGET_HF);
        new MarginGuard(owner, MIN_HF, TARGET_HF);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(MarginGuard.ZeroOwner.selector);
        new MarginGuard(address(0), MIN_HF, TARGET_HF);
    }

    function test_constructor_revertsOnInvalidThresholds() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidThresholds.selector, 1e18, TARGET_HF));
        new MarginGuard(owner, 1e18, TARGET_HF);
    }

    function test_constructor_revertsWhenTargetNotAboveMin() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidThresholds.selector, MIN_HF, MIN_HF));
        new MarginGuard(owner, MIN_HF, MIN_HF);
    }

    function test_setThresholds_updatesAndEmits() public {
        vm.expectEmit();
        emit IGuard.ThresholdsUpdated(1.3e18, 1.6e18);
        vm.prank(owner);
        guard.setThresholds(1.3e18, 1.6e18);

        assertEq(guard.minHealthFactor(), 1.3e18);
        assertEq(guard.targetHealthFactor(), 1.6e18);
    }

    function test_setThresholds_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.NotOwner.selector, user));
        vm.prank(user);
        guard.setThresholds(1.3e18, 1.6e18);
    }

    function test_setThresholds_revertsWhenMinNotAboveLiquidation() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidThresholds.selector, 1e18, 1.5e18));
        vm.prank(owner);
        guard.setThresholds(1e18, 1.5e18);
    }

    function test_setThresholds_revertsWhenMinBelowLiquidation() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidThresholds.selector, 0.9e18, 1.5e18));
        vm.prank(owner);
        guard.setThresholds(0.9e18, 1.5e18);
    }

    function test_setThresholds_revertsWhenTargetBelowMin() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidThresholds.selector, 1.5e18, 1.3e18));
        vm.prank(owner);
        guard.setThresholds(1.5e18, 1.3e18);
    }

    function test_setThresholds_revertsWhenTargetNotAboveMin() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidThresholds.selector, 1.3e18, 1.3e18));
        vm.prank(owner);
        guard.setThresholds(1.3e18, 1.3e18);
    }

    // --- simulation ---

    function test_simulation_isOffByDefault() public {
        venue.setPosition(user, COLLATERAL_USD, 4_000 * USDC);
        assertEq(guard.simulatedDropBps(), 0);
        assertEq(guard.simulatedHealth(venue, user), venue.healthAfter(user, 0));
    }

    function test_simulation_refusesPreviouslySafePayment() public {
        venue.setPosition(user, COLLATERAL_USD, 5_000 * USDC);
        assertEq(guard.checkMargin(user, venue, 1_000 * USDC), 1_000 * USDC);

        // -30%: the guard reasons on 7,000 USD of collateral, which allows 4,368 USDC of debt.
        vm.prank(owner);
        guard.setSimulatedDrop(3_000);
        assertEq(guard.checkMargin(user, venue, 1_000 * USDC), 0);
    }

    function test_simulation_reducesPaymentLikeARealDrop() public {
        venue.setPosition(user, COLLATERAL_USD, 4_000 * USDC);
        vm.prank(owner);
        guard.setSimulatedDrop(2_000);
        uint256 simulated = guard.checkMargin(user, venue, 2_000 * USDC);

        // The same drop applied to the venue itself must give the same answer.
        vm.prank(owner);
        guard.setSimulatedDrop(0);
        venue.movePrice(user, 0.8e18);
        assertEq(simulated, guard.checkMargin(user, venue, 2_000 * USDC));
        // 8,000 * 0.78 / 1.25 = 4,992 USDC of debt allowed, 4,000 already owed.
        assertEq(simulated, 992 * USDC);
    }

    function test_simulation_turningItOffRestoresTheRealAnswer() public {
        venue.setPosition(user, COLLATERAL_USD, 5_000 * USDC);
        vm.prank(owner);
        guard.setSimulatedDrop(3_000);
        assertEq(guard.checkMargin(user, venue, 1_000 * USDC), 0);

        vm.prank(owner);
        guard.setSimulatedDrop(0);
        assertEq(guard.checkMargin(user, venue, 1_000 * USDC), 1_000 * USDC);
    }

    function test_simulation_survivesAThresholdChange() public {
        venue.setPosition(user, COLLATERAL_USD, 4_000 * USDC);
        vm.startPrank(owner);
        guard.setSimulatedDrop(2_000);
        guard.setThresholds(1.3e18, 1.6e18);
        vm.stopPrank();
        // 8,000 * 0.78 / 1.3 = 4,800 USDC of debt allowed, 4,000 already owed.
        assertEq(guard.checkMargin(user, venue, 2_000 * USDC), 800 * USDC);
    }

    function test_simulation_appliesToThresholdsSetBeforeIt() public {
        venue.setPosition(user, COLLATERAL_USD, 4_000 * USDC);
        vm.startPrank(owner);
        guard.setThresholds(1.3e18, 1.6e18);
        guard.setSimulatedDrop(2_000);
        vm.stopPrank();
        assertEq(guard.checkMargin(user, venue, 2_000 * USDC), 800 * USDC);
    }

    function test_simulation_boundaryIsExact() public {
        // -20% allows 4,992 USDC of debt: the last base unit passes, one more does not.
        vm.prank(owner);
        guard.setSimulatedDrop(2_000);
        assertEq(guard.checkMargin(user, venue, 4_992 * USDC), 4_992 * USDC);
        assertEq(guard.checkMargin(user, venue, 4_992 * USDC + 1), 4_992 * USDC);

        venue.setPosition(user, COLLATERAL_USD, 4_992 * USDC);
        assertEq(guard.simulatedHealth(venue, user), MIN_HF);
        assertEq(guard.checkMargin(user, venue, 1), 0);
    }

    function test_simulation_atTheMaximumDrop() public {
        // -90%: 1,000 USD of collateral allows 780 / 1.25 = 624 USDC of debt.
        vm.prank(owner);
        guard.setSimulatedDrop(9_000);
        assertEq(guard.checkMargin(user, venue, 1_000 * USDC), 624 * USDC);
    }

    function test_simulation_safePaymentStillCostsOneProjection() public {
        vm.prank(owner);
        guard.setSimulatedDrop(2_000);
        vm.expectCall(address(venue), abi.encodeCall(IVenue.healthAfter, (user, 100 * USDC)), 1);
        vm.expectCall(address(venue), abi.encodeCall(IVenue.healthAfter, (user, 0)), 0);
        guard.checkMargin(user, venue, 100 * USDC);
    }

    function test_simulatedHealth_scalesTheVenueHealth() public {
        venue.setPosition(user, COLLATERAL_USD, 4_000 * USDC);
        assertEq(guard.simulatedHealth(venue, user), 1.95e18);

        vm.prank(owner);
        guard.setSimulatedDrop(2_000);
        assertEq(guard.simulatedHealth(venue, user), 1.56e18);
    }

    function test_simulatedHealth_keepsNoDebtAsNoDebt() public {
        vm.prank(owner);
        guard.setSimulatedDrop(9_000);
        assertEq(guard.simulatedHealth(venue, user), type(uint256).max);
    }

    function test_simulatedHealth_doesNotOverflowOnTinyDebt() public {
        // One base unit of debt against a huge collateral: a health factor near 1e70, which
        // would overflow if it were multiplied before being divided.
        venue.setPosition(user, 1e58, 1);
        vm.prank(owner);
        guard.setSimulatedDrop(5_000);
        (uint256 real,,) = venue.health(user);
        assertEq(guard.simulatedHealth(venue, user), real / 2);
    }

    function test_setSimulatedDrop_emits() public {
        vm.expectEmit();
        emit MarginGuard.SimulationUpdated(2_000);
        vm.prank(owner);
        guard.setSimulatedDrop(2_000);
        assertEq(guard.simulatedDropBps(), 2_000);
    }

    function test_setSimulatedDrop_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.NotOwner.selector, user));
        vm.prank(user);
        guard.setSimulatedDrop(2_000);
    }

    function test_setSimulatedDrop_acceptsTheMaximumAndRejectsAbove() public {
        vm.startPrank(owner);
        guard.setSimulatedDrop(9_000);
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidSimulatedDrop.selector, 9_001));
        guard.setSimulatedDrop(9_001);
        vm.stopPrank();
    }

    function testFuzz_simulation_matchesARealDropWithinOneUnit(uint256 debt, uint256 amount, uint256 dropBps) public {
        debt = bound(debt, 0, 20_000 * USDC);
        amount = bound(amount, 1, 20_000 * USDC);
        // Whole percents keep the mock's own price move exact.
        dropBps = bound(dropBps, 0, 90) * 100;
        venue.setPosition(user, COLLATERAL_USD, debt);

        vm.prank(owner);
        guard.setSimulatedDrop(dropBps);
        uint256 simulated = guard.checkMargin(user, venue, amount);
        uint256 simulatedHf = guard.simulatedHealth(venue, user);

        vm.prank(owner);
        guard.setSimulatedDrop(0);
        venue.movePrice(user, (10_000 - dropBps) * 1e14);
        uint256 real = guard.checkMargin(user, venue, amount);
        // The simulation rounds the health factor down once more than the venue does, so it
        // may allow one base unit less than a real drop, and never more.
        assertLe(simulated, real);
        assertApproxEqAbs(simulated, real, 1);
        // The two health factors round at different steps: allow the last few wei.
        if (debt > 0) assertApproxEqAbs(simulatedHf, venue.healthAfter(user, 0), 10_000);
    }
}
