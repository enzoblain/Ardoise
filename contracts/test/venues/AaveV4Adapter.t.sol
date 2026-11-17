// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IVenue} from "../../src/interfaces/IVenue.sol";
import {AaveV4Adapter} from "../../src/venues/AaveV4Adapter.sol";
import {
    IAaveV4GiverPositionManager,
    IAaveV4Spoke,
    IAaveV4TakerPositionManager
} from "../../src/venues/aave/IAaveV4.sol";
import {MockAaveV4, MockFactory, MockToken} from "./mocks/MockAaveV4.sol";

/// @notice Unit tests of `AaveV4Adapter` against a mock Aave V4 (no Arc fork: native USDC does
/// not work on forks).
contract AaveV4AdapterTest is Test {
    uint256 internal constant RAY = 1e27;
    uint256 internal constant WAD = 1e18;
    /// @dev Aave V4 units of Value per USD.
    uint256 internal constant VALUE_PER_USD = 1e26;
    uint256 internal constant USDC = 1e6;

    MockToken internal token;
    MockAaveV4 internal aave;
    MockFactory internal factory;
    AaveV4Adapter internal adapter;

    address internal user = makeAddr("user");
    address internal account = makeAddr("account");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        token = new MockToken(6);
        aave = new MockAaveV4(token);
        factory = new MockFactory();
        factory.setAccount(user, account);
        adapter = new AaveV4Adapter(
            factory,
            IAaveV4Spoke(address(aave)),
            IAaveV4TakerPositionManager(address(aave)),
            IAaveV4GiverPositionManager(address(aave)),
            0
        );
    }

    // ----- Configuration -----

    function test_constructor_readsReserveFromSpoke() public view {
        assertEq(address(adapter.factory()), address(factory));
        assertEq(address(adapter.hub()), address(aave));
        assertEq(address(adapter.oracle()), address(aave));
        assertEq(adapter.asset(), address(token));
        assertEq(adapter.assetId(), aave.ASSET_ID());
        assertEq(adapter.assetDecimals(), 6);
        assertEq(adapter.reserveId(), 0);
        assertEq(adapter.name(), "Aave V4");
    }

    // ----- rate -----

    function test_rate_convertsRayToBps() public {
        // Drawn rate read on the Arc mainnet Hub (about 3.10% APR).
        aave.setHub(31028888610054940201009040, 0, type(uint40).max, 0);
        assertEq(adapter.rate(), 310);
    }

    function testFuzz_rate_floorsToWholeBps(uint256 rateRay) public {
        rateRay = bound(rateRay, 0, 10 * RAY);
        aave.setHub(rateRay, 0, type(uint40).max, 0);
        assertEq(adapter.rate(), rateRay / 1e23);
    }

    // ----- available -----

    function test_available_isLiquidityWithoutDrawCap() public {
        aave.setHub(0, 43_752_830 * USDC, type(uint40).max, 43_379_855 * USDC);
        assertEq(adapter.available(), 43_752_830 * USDC);
    }

    function test_available_isLiquidityWhenDrawCapRoomIsLarger() public {
        aave.setHub(0, 43_752_830 * USDC, 69_700_000, 1_000_000 * USDC);
        assertEq(adapter.available(), 43_752_830 * USDC);
    }

    function test_available_isCappedByDrawCapRoom() public {
        // Arc mainnet values: draw cap 69.7M whole USDC with 43.38M owed leaves 26.32M, less than
        // the Hub's 43.75M of liquidity.
        aave.setHub(0, 43_752_830 * USDC, 69_700_000, 43_379_855 * USDC);
        assertEq(adapter.available(), 26_320_145 * USDC);
    }

    function test_available_isZeroWhenOwedExceedsDrawCap() public {
        aave.setHub(0, 43_752_830 * USDC, 69_700_000, 69_800_000 * USDC);
        assertEq(adapter.available(), 0);
    }

    // ----- health -----

    function test_health_convertsValueUnitsToWad() public {
        // Account data of the project test wallet on the Arc mainnet Main Spoke.
        aave.setAccountData(user, _mainnetAccountData());
        (uint256 hf, uint256 collateralUsd, uint256 debtUsd) = adapter.health(user);
        assertEq(hf, 3122303146351591315);
        assertEq(collateralUsd, 4001912145000000000); // $4.0019
        assertEq(debtUsd, 999740040215973341); // $0.9997
    }

    function test_health_withoutDebtIsMax() public {
        IAaveV4Spoke.UserAccountData memory data;
        data.avgCollateralFactor = 0.78e18;
        data.totalCollateralValue = 100 * VALUE_PER_USD;
        data.healthFactor = type(uint256).max;
        aave.setAccountData(user, data);
        (uint256 hf, uint256 collateralUsd, uint256 debtUsd) = adapter.health(user);
        assertEq(hf, type(uint256).max);
        assertEq(collateralUsd, 100 * WAD);
        assertEq(debtUsd, 0);
    }

    // ----- healthAfter -----

    function test_healthAfter_matchesSpokeFormula() public {
        // $100 of collateral at a 78% collateral factor, $10 of debt: HF 7.8.
        aave.setAccountData(user, _accountData(100, 10));
        assertEq(adapter.healthAfter(user, 0), 7.8e18);
        // Borrowing $10 more halves it.
        assertEq(adapter.healthAfter(user, 10 * USDC), 3.9e18);
    }

    function test_healthAfter_usesOraclePriceOfBorrowedAsset() public {
        aave.setAccountData(user, _accountData(100, 10));
        aave.setPrice(0.5e8); // the borrowed asset is worth $0.50
        assertEq(adapter.healthAfter(user, 20 * USDC), 3.9e18);
    }

    function test_healthAfter_matchesSpokeOnMainnetData() public {
        aave.setAccountData(user, _mainnetAccountData());
        aave.setPrice(99974004); // USDC price behind the mainnet debt value
        // The Spoke only exposes the floored average collateral factor: a few wei lower at most.
        uint256 hf = adapter.healthAfter(user, 0);
        assertLe(hf, 3122303146351591315);
        assertApproxEqAbs(hf, 3122303146351591315, 10);
    }

    function testFuzz_healthAfter_matchesSpokeFormula(
        uint256 collateralUsd,
        uint256 debtUsd,
        uint256 extraDebt,
        uint256 collateralFactor
    ) public {
        // Bounded so that the Spoke's own `x RAY` formula, used as the reference, does not overflow.
        collateralUsd = bound(collateralUsd, 1, 1e6);
        debtUsd = bound(debtUsd, 0, 1e9);
        extraDebt = bound(extraDebt, 0, 1e9 * USDC);
        collateralFactor = bound(collateralFactor, 0.01e18, 0.95e18);
        vm.assume(debtUsd > 0 || extraDebt > 0);

        IAaveV4Spoke.UserAccountData memory data = _accountData(collateralUsd, debtUsd);
        data.avgCollateralFactor = collateralFactor;
        aave.setAccountData(user, data);

        uint256 debtValueRay = data.totalDebtValueRay + extraDebt * 1e8 * 1e12 * RAY;
        uint256 expected = (collateralFactor * data.totalCollateralValue * RAY) / debtValueRay;
        assertEq(adapter.healthAfter(user, extraDebt), expected);
    }

    function test_healthAfter_withoutCollateralIsZero() public {
        aave.setAccountData(user, _accountData(0, 10));
        assertEq(adapter.healthAfter(user, 1 * USDC), 0);
        aave.setAccountData(user, _accountData(0, 0));
        assertEq(adapter.healthAfter(user, 0), 0);
    }

    function test_healthAfter_withoutDebtOrExtraDebtIsMax() public {
        aave.setAccountData(user, _accountData(100, 0));
        assertEq(adapter.healthAfter(user, 0), type(uint256).max);
    }

    function test_healthAfter_doesNotOverflowOnLargePositions() public {
        // $10 billion of collateral would overflow `avgCollateralFactor x collateral x RAY`.
        aave.setAccountData(user, _accountData(10_000_000_000, 1_000_000_000));
        assertEq(adapter.healthAfter(user, 0), 7.8e18);
    }

    // ----- borrow -----

    function test_borrow_sendsTokensToCallingAccount() public {
        aave.approveBorrow(user, address(adapter), 5 * USDC);

        vm.expectEmit(address(adapter));
        emit IVenue.Borrowed(user, account, 1 * USDC);
        vm.prank(account);
        uint256 borrowed = adapter.borrow(user, 1 * USDC);

        assertEq(borrowed, 1 * USDC);
        assertEq(token.balanceOf(account), 1 * USDC);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(aave.debt(user), 1 * USDC);
        assertEq(aave.lastBorrowFor(), user);
        assertEq(aave.borrowAllowance(user, address(adapter)), 4 * USDC);
    }

    function test_borrow_revertsForStranger() public {
        aave.approveBorrow(user, address(adapter), 5 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IVenue.UnauthorizedCaller.selector, stranger, user));
        vm.prank(stranger);
        adapter.borrow(user, 1 * USDC);
    }

    function test_borrow_revertsForUserItself() public {
        // Only the account registered in the factory may spend the allowance, not even the user.
        aave.approveBorrow(user, address(adapter), 5 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IVenue.UnauthorizedCaller.selector, user, user));
        vm.prank(user);
        adapter.borrow(user, 1 * USDC);
    }

    function test_borrow_revertsForAnotherUsersAccount() public {
        address victim = makeAddr("victim");
        aave.approveBorrow(victim, address(adapter), 5 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IVenue.UnauthorizedCaller.selector, account, victim));
        vm.prank(account);
        adapter.borrow(victim, 1 * USDC);
    }

    function test_borrow_revertsAboveAllowance() public {
        aave.approveBorrow(user, address(adapter), 1 * USDC);
        vm.expectRevert(abi.encodeWithSelector(MockAaveV4.InsufficientBorrowAllowance.selector, 1 * USDC, 2 * USDC));
        vm.prank(account);
        adapter.borrow(user, 2 * USDC);
    }

    // ----- repay -----

    function test_repay_capsAtDebtAndLeavesTheRestWithPayer() public {
        aave.setDebt(user, 1 * USDC);
        _fund(stranger, 5 * USDC);

        vm.expectEmit(address(adapter));
        emit IVenue.Repaid(user, stranger, 1 * USDC);
        vm.prank(stranger);
        uint256 repaid = adapter.repay(user, 5 * USDC);

        assertEq(repaid, 1 * USDC);
        assertEq(aave.debt(user), 0);
        assertEq(token.balanceOf(stranger), 4 * USDC);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(token.allowance(address(adapter), address(aave)), 0);
    }

    function test_repay_partial() public {
        aave.setDebt(user, 3 * USDC);
        _fund(account, 1 * USDC);
        vm.prank(account);
        assertEq(adapter.repay(user, 1 * USDC), 1 * USDC);
        assertEq(aave.debt(user), 2 * USDC);
        assertEq(token.balanceOf(account), 0);
    }

    function test_repay_withoutDebtPullsNothing() public {
        _fund(stranger, 5 * USDC);
        vm.prank(stranger);
        assertEq(adapter.repay(user, 5 * USDC), 0);
        assertEq(token.balanceOf(stranger), 5 * USDC);
    }

    function test_repay_refundsWhatGiverDidNotPull() public {
        aave.setDebt(user, 1 * USDC);
        aave.setRepayQuirks(0, 10);
        _fund(stranger, 5 * USDC);
        vm.prank(stranger);
        uint256 repaid = adapter.repay(user, 5 * USDC);

        assertEq(repaid, 1 * USDC - 10);
        assertEq(token.balanceOf(stranger), 4 * USDC + 10);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(token.allowance(address(adapter), address(aave)), 0);
    }

    function test_repay_toleratesSpokeRoundingDust() public {
        // The Spoke may restore slightly less than the Giver pulled; the dust stays in the Giver
        // and the adapter must not try to refund it from its own balance.
        aave.setDebt(user, 1 * USDC);
        aave.setRepayQuirks(1, 0);
        _fund(stranger, 1 * USDC);
        vm.prank(stranger);
        assertEq(adapter.repay(user, 1 * USDC), 1 * USDC - 1);
        assertEq(token.balanceOf(stranger), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
    }

    // ----- helpers -----

    /// @dev Account data consistent with the Spoke formula, 78% collateral factor, USDC at $1.
    function _accountData(uint256 collateralUsd, uint256 debtUsd)
        internal
        pure
        returns (IAaveV4Spoke.UserAccountData memory data)
    {
        data.avgCollateralFactor = collateralUsd == 0 ? 0 : 0.78e18;
        data.totalCollateralValue = collateralUsd * VALUE_PER_USD;
        data.totalDebtValueRay = debtUsd * VALUE_PER_USD * RAY;
        // The Spoke's `x RAY / totalDebtValueRay`, simplified since the debt is whole Value units.
        data.healthFactor = debtUsd == 0
            ? type(uint256).max
            : (data.avgCollateralFactor * data.totalCollateralValue) / (debtUsd * VALUE_PER_USD);
    }

    /// @dev `getUserAccountData` of the project test wallet, read on Arc mainnet on 2026-11-17.
    function _mainnetAccountData() internal pure returns (IAaveV4Spoke.UserAccountData memory data) {
        data.avgCollateralFactor = 780000000000000000;
        data.healthFactor = 3122303146351591315;
        data.totalCollateralValue = 400191214500000000000000000;
        data.totalDebtValueRay = 99974004021597334160806651409977922237592000000000000;
        data.activeCollateralCount = 1;
        data.borrowCount = 1;
    }

    function _fund(address payer, uint256 amount) internal {
        token.mint(payer, amount);
        vm.prank(payer);
        token.approve(address(adapter), amount);
    }
}
