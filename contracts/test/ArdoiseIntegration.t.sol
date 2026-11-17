// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseAccount} from "../src/ArdoiseAccount.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {MarginGuard} from "../src/guard/MarginGuard.sol";
import {IArdoise} from "../src/interfaces/IArdoise.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {AaveV4Adapter} from "../src/venues/AaveV4Adapter.sol";
import {IAaveV4GiverPositionManager, IAaveV4Spoke, IAaveV4TakerPositionManager} from "../src/venues/aave/IAaveV4.sol";
import {MockTokenMessenger} from "./mocks/ArdoiseMocks.sol";
import {MockAaveV4, MockToken} from "./venues/mocks/MockAaveV4.sol";

/// @notice The real factory, account, Aave V4 adapter and margin guard wired together, in the
/// deployment order of docs/api.md, against the mock Aave V4.
contract ArdoiseIntegrationTest is Test {
    uint256 internal constant USDC = 1e6;
    uint256 internal constant RAY = 1e27;

    MockToken internal usdc;
    MockAaveV4 internal aave;
    MockTokenMessenger internal messenger;
    ArdoiseFactory internal factory;
    AaveV4Adapter internal adapter;
    MarginGuard internal guard;
    IArdoise internal account;

    address internal admin = makeAddr("admin");
    address internal user = makeAddr("user");
    address internal payee = makeAddr("payee");

    function setUp() public {
        usdc = new MockToken(6);
        aave = new MockAaveV4(usdc);
        aave.setHub(0.031e27, 26_000_000 * USDC, type(uint40).max, 0);
        messenger = new MockTokenMessenger();

        factory = new ArdoiseFactory(
            admin, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), 2000, 100 * USDC, 500 * USDC
        );
        adapter = new AaveV4Adapter(
            factory,
            IAaveV4Spoke(address(aave)),
            IAaveV4TakerPositionManager(address(aave)),
            IAaveV4GiverPositionManager(address(aave)),
            0
        );
        guard = new MarginGuard(admin, 1.25e18, 1.5e18);
        IVenue[] memory list = new IVenue[](1);
        list[0] = adapter;
        vm.startPrank(admin);
        factory.setVenues(list);
        factory.setGuard(guard);
        vm.stopPrank();

        vm.prank(user);
        account = factory.createAccount();
        // One-time user setup: borrow allowance for the adapter on the Taker.
        aave.approveBorrow(user, address(adapter), 50 * USDC);
        // $100 of collateral at 78%, no debt yet.
        _setPosition(100, 0);
    }

    function test_pay_borrowsOnAaveAndPaysOnArc() public {
        vm.prank(user);
        uint256 lineId = account.pay(2 * USDC, 26, bytes32(uint256(uint160(payee))), 0, "lunch");

        assertEq(usdc.balanceOf(payee), 2 * USDC);
        assertEq(aave.debt(user), 2 * USDC);
        assertEq(aave.lastBorrowFor(), user);
        assertEq(aave.borrowAllowance(user, address(adapter)), 48 * USDC);
        assertEq(account.line(lineId).rateBps, 310);
    }

    function test_pay_toBaseBurnsBorrowedUsdc() public {
        vm.prank(user);
        account.pay(1 * USDC, 6, bytes32(uint256(uint160(payee))), 0.06e6, "");
        assertEq(usdc.balanceOf(address(messenger)), 1.06e6);
        assertEq(aave.debt(user), 1.06e6);
    }

    function test_pay_refusedByGuardBelowMinimumHealth() public {
        // $60 of debt on $100 at 78% would leave a health factor of 1.3; $70 would leave 1.11.
        uint256 allowed = guard.checkMargin(user, adapter, 70 * USDC);
        assertLt(allowed, 70 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.PaymentRefused.selector, 70 * USDC, allowed));
        vm.prank(user);
        account.pay(70 * USDC, 26, bytes32(uint256(uint160(payee))), 0, "");
    }

    function test_repayAndSweep_goThroughTheGiver() public {
        vm.prank(user);
        account.pay(3 * USDC, 26, bytes32(uint256(uint160(payee))), 0, "");

        usdc.mint(user, 1 * USDC);
        vm.startPrank(user);
        usdc.approve(address(account), 1 * USDC);
        assertEq(account.repay(1, 1 * USDC), 1 * USDC);
        vm.stopPrank();
        assertEq(aave.debt(user), 2 * USDC);

        usdc.mint(address(account), 5 * USDC);
        assertEq(account.sweep(), 2 * USDC);
        assertEq(aave.debt(user), 0);
        assertEq(usdc.balanceOf(address(account)), 3 * USDC);
    }

    function test_adapter_refusesAnotherUsersAccount() public {
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        IArdoise malloryAccount = factory.createAccount();
        vm.expectRevert(abi.encodeWithSelector(IVenue.UnauthorizedCaller.selector, address(malloryAccount), user));
        vm.prank(address(malloryAccount));
        adapter.borrow(user, 1 * USDC);
    }

    function _setPosition(uint256 collateralUsd, uint256 debtUsd) internal {
        IAaveV4Spoke.UserAccountData memory data;
        data.avgCollateralFactor = 0.78e18;
        data.totalCollateralValue = collateralUsd * 1e26;
        data.totalDebtValueRay = debtUsd * 1e26 * RAY;
        data.healthFactor = debtUsd == 0 ? type(uint256).max : 0.78e18 * collateralUsd / debtUsd;
        aave.setAccountData(user, data);
    }
}
