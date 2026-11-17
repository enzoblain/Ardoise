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
}
