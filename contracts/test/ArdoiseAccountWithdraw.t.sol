// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseAccount} from "../src/ArdoiseAccount.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {IArdoise} from "../src/interfaces/IArdoise.sol";
import {IGuard} from "../src/interfaces/IGuard.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {MockGuard, MockTokenMessenger, TokenVenue} from "./mocks/ArdoiseMocks.sol";
import {MockToken} from "./venues/mocks/MockAaveV4.sol";

/// @notice Token double that calls a contract recipient back on every transfer, as a token with
/// transfer hooks would, so a test can try to reenter the sender.
contract HookToken {
    /// @notice Balance of each holder.
    mapping(address => uint256) public balanceOf;

    /// @notice Creates `amount` tokens for `to`.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    /// @notice ERC-20 `transfer` that then calls `onTransfer()` on a contract recipient and
    /// bubbles its revert.
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (to.code.length > 0) ReentrantOwner(to).onTransfer();
        return true;
    }
}

/// @notice Account owner that withdraws again from inside the token's transfer hook.
contract ReentrantOwner {
    /// @notice The owner's account.
    ArdoiseAccount public account;
    /// @notice Amount asked by the nested withdrawal; 0 disables it.
    uint256 public nested;

    /// @notice Creates this contract's account on `factory`.
    function open(ArdoiseFactory factory) external {
        account = ArdoiseAccount(address(factory.createAccount()));
    }

    /// @notice Withdraws `amount`, and `nested_` more from inside the transfer hook.
    function withdraw(uint256 amount, uint256 nested_) external {
        nested = nested_;
        account.withdraw(amount);
    }

    /// @notice Transfer hook called by `HookToken`.
    function onTransfer() external {
        if (nested > 0) account.withdraw(nested);
    }
}

/// @notice Unit tests of `ArdoiseAccount.withdraw` with mock venues, guard and CCTP.
contract ArdoiseAccountWithdrawTest is Test {
    uint256 internal constant USDC = 1e6;
    uint32 internal constant ARC = 26;

    MockToken internal usdc;
    ArdoiseFactory internal factory;
    MockGuard internal guard;
    TokenVenue internal aave;
    TokenVenue internal morpho;
    ArdoiseAccount internal account;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_763_400_000); // 2025-11-17, a realistic timestamp for the UTC-day logic
        usdc = new MockToken(6);
        factory = _factory(address(usdc));
        aave = new TokenVenue(factory, usdc, 310, 1_000_000 * USDC);
        morpho = new TokenVenue(factory, usdc, 450, 1_000_000 * USDC);
        guard = new MockGuard();
        IVenue[] memory list = new IVenue[](2);
        list[0] = aave;
        list[1] = morpho;
        vm.startPrank(admin);
        factory.setVenues(list);
        factory.setGuard(guard);
        vm.stopPrank();
        vm.prank(owner);
        account = ArdoiseAccount(address(factory.createAccount()));
    }

    // ----- surplus the sweep cannot apply -----

    function test_withdraw_sendsSurplusToOwnerWhenThereIsNoDebt() public {
        usdc.mint(address(account), 50 * USDC);
        assertEq(account.sweep(), 0);

        vm.expectEmit(address(account));
        emit ArdoiseAccount.Withdrawn(owner, 50 * USDC);
        vm.prank(owner);
        account.withdraw(50 * USDC);

        assertEq(usdc.balanceOf(owner), 50 * USDC);
        assertEq(usdc.balanceOf(address(account)), 0);
    }

    function test_withdraw_returnsWhatADeliveryLargerThanTheDebtLeaves() public {
        _payArc(20 * USDC);
        usdc.mint(address(account), 100 * USDC); // a 100 USDC standing order against 20 of debt
        assertEq(account.sweep(), 20 * USDC);

        vm.prank(owner);
        account.withdraw(80 * USDC);

        assertEq(usdc.balanceOf(owner), 80 * USDC);
        assertEq(usdc.balanceOf(address(account)), 0);
        assertEq(aave.debtOf(owner), 0);
    }

    function test_withdraw_partialAmountsAddUpExactly() public {
        usdc.mint(address(account), 10 * USDC);
        vm.startPrank(owner);
        account.withdraw(3 * USDC);
        assertEq(usdc.balanceOf(owner), 3 * USDC);
        assertEq(usdc.balanceOf(address(account)), 7 * USDC);
        account.withdraw(1);
        assertEq(usdc.balanceOf(owner), 3 * USDC + 1);
        assertEq(usdc.balanceOf(address(account)), 7 * USDC - 1);
        account.withdraw(7 * USDC - 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 10 * USDC);
        assertEq(usdc.balanceOf(address(account)), 0);
    }

    function testFuzz_withdraw_movesExactlyTheAmount(uint128 balance, uint128 amount) public {
        balance = uint128(bound(balance, 1, type(uint128).max));
        amount = uint128(bound(amount, 1, balance));
        usdc.mint(address(account), balance);
        vm.prank(owner);
        account.withdraw(amount);
        assertEq(usdc.balanceOf(owner), amount);
        assertEq(usdc.balanceOf(address(account)), balance - amount);
    }

    function test_withdraw_worksWithoutGuard() public {
        usdc.mint(address(account), 5 * USDC);
        vm.prank(admin);
        factory.setGuard(IGuard(address(0)));

        vm.prank(owner);
        account.withdraw(5 * USDC);
        assertEq(usdc.balanceOf(owner), 5 * USDC);
    }

    function test_withdraw_worksWhenTheGuardAllowsNothing() public {
        // An owner with no borrowing power could not take the balance out through a payment.
        usdc.mint(address(account), 5 * USDC);
        guard.setCap(0);

        vm.prank(owner);
        account.withdraw(5 * USDC);
        assertEq(usdc.balanceOf(owner), 5 * USDC);
    }

    function test_withdraw_worksWhileAVenueRefusesRepayment() public {
        _payArc(20 * USDC);
        usdc.mint(address(account), 20 * USDC);
        aave.setRepayBroken(true);
        assertEq(account.sweep(), 0);
        assertEq(usdc.balanceOf(address(account)), 20 * USDC);

        vm.prank(owner);
        account.withdraw(20 * USDC);

        assertEq(usdc.balanceOf(owner), 20 * USDC);
        assertEq(usdc.balanceOf(address(account)), 0);
        // The debt and its line are untouched: withdrawing repays nothing.
        assertEq(aave.debtOf(owner), 20 * USDC);
        assertFalse(account.closed(1));
        assertEq(account.line(1).repaid, 0);
    }

    function test_withdraw_worksWithNoVenueListed() public {
        usdc.mint(address(account), 5 * USDC);
        vm.prank(admin);
        factory.setVenues(new IVenue[](0));

        vm.prank(owner);
        account.withdraw(5 * USDC);
        assertEq(usdc.balanceOf(owner), 5 * USDC);
    }

    // ----- what it leaves alone -----

    function test_withdraw_leavesCapsAndLinesUntouched() public {
        _payArc(10 * USDC);
        usdc.mint(address(account), 4 * USDC);
        (,, uint256 spentBefore) = account.caps();

        vm.prank(owner);
        account.withdraw(4 * USDC);

        (,, uint256 spentAfter) = account.caps();
        assertEq(spentAfter, spentBefore);
        assertEq(account.lines().length, 1);
        assertEq(account.line(1).principal, 10 * USDC);
        assertEq(aave.debtOf(owner), 10 * USDC);
    }

    function test_withdraw_findsNothingAfterAPayment() public {
        // The borrowed USDC leaves inside `pay`: a payment gives the owner nothing to withdraw.
        _payArc(10 * USDC);
        assertEq(usdc.balanceOf(address(account)), 0);
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.InsufficientBalance.selector, 1, 0));
        vm.prank(owner);
        account.withdraw(1);
    }

    function test_withdraw_canTakeWhatAVenueSendsBeyondTheAmountAsked() public {
        // The documented exception: the excess is owed by the owner and was counted by neither
        // the guard nor the caps, and its size is the venue's doing.
        aave.setQuirks(false, 0, 3);
        _payArc(10 * USDC);
        assertEq(usdc.balanceOf(payee), 10 * USDC);
        assertEq(usdc.balanceOf(address(account)), 3);
        (,, uint256 spent) = account.caps();
        assertEq(spent, 10 * USDC);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.InsufficientBalance.selector, 4, 3));
        account.withdraw(4);
        account.withdraw(3);
        vm.stopPrank();

        assertEq(usdc.balanceOf(owner), 3);
        assertEq(usdc.balanceOf(address(account)), 0);
        assertEq(account.line(1).principal, 10 * USDC + 3);
        assertEq(aave.debtOf(owner), 10 * USDC + 3);
    }

    // ----- reverts -----

    function test_withdraw_ownerOnly() public {
        usdc.mint(address(account), 5 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NotOwner.selector, stranger));
        vm.prank(stranger);
        account.withdraw(5 * USDC);

        vm.expectRevert(abi.encodeWithSelector(IArdoise.NotOwner.selector, admin));
        vm.prank(admin);
        account.withdraw(5 * USDC);
        assertEq(usdc.balanceOf(address(account)), 5 * USDC);
    }

    function test_withdraw_rejectsZeroAmount() public {
        usdc.mint(address(account), 5 * USDC);
        vm.expectRevert(ArdoiseAccount.ZeroAmount.selector);
        vm.prank(owner);
        account.withdraw(0);
    }

    function test_withdraw_rejectsMoreThanTheBalance() public {
        usdc.mint(address(account), 5 * USDC);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.InsufficientBalance.selector, 5 * USDC + 1, 5 * USDC));
        account.withdraw(5 * USDC + 1);
        // No "everything" value: the maximum is an amount like any other.
        vm.expectRevert(
            abi.encodeWithSelector(ArdoiseAccount.InsufficientBalance.selector, type(uint256).max, 5 * USDC)
        );
        account.withdraw(type(uint256).max);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(account)), 5 * USDC);
    }

    function test_withdraw_revertsWhenTheTokenReturnsFalse() public {
        usdc.mint(address(account), 5 * USDC);
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (owner, 5 * USDC)), abi.encode(false));
        vm.expectRevert(ArdoiseAccount.TokenCallFailed.selector);
        vm.prank(owner);
        account.withdraw(5 * USDC);
    }

    // ----- reentrancy -----

    function test_reentrancy_venueCannotWithdrawDuringBorrow() public {
        usdc.mint(address(account), 5 * USDC);
        aave.setReentry(abi.encodeCall(ArdoiseAccount.withdraw, (5 * USDC)));
        vm.expectRevert(ArdoiseAccount.Reentrancy.selector);
        vm.prank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");
        assertEq(usdc.balanceOf(address(account)), 5 * USDC);
    }

    function test_reentrancy_ownerCannotWithdrawAgainFromATokenHook() public {
        HookToken token = new HookToken();
        ArdoiseFactory hookFactory = _factory(address(token));
        ReentrantOwner contractOwner = new ReentrantOwner();
        contractOwner.open(hookFactory);
        ArdoiseAccount hooked = contractOwner.account();
        token.mint(address(hooked), 10 * USDC);

        vm.expectRevert(ArdoiseAccount.Reentrancy.selector);
        contractOwner.withdraw(6 * USDC, 4 * USDC);
        assertEq(token.balanceOf(address(hooked)), 10 * USDC);

        // The same owner withdraws normally when the hook does not reenter.
        contractOwner.withdraw(6 * USDC, 0);
        assertEq(token.balanceOf(address(contractOwner)), 6 * USDC);
        assertEq(token.balanceOf(address(hooked)), 4 * USDC);
    }

    // ----- helpers -----

    function _factory(address token) internal returns (ArdoiseFactory) {
        return new ArdoiseFactory(
            admin, IERC20(token), ITokenMessengerV2(address(new MockTokenMessenger())), 2000, 100 * USDC, 500 * USDC
        );
    }

    function _payArc(uint256 amount) internal {
        vm.prank(owner);
        account.pay(amount, ARC, _b(payee), 0, "");
    }

    function _b(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
