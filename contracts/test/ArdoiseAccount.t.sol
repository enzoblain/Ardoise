// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseAccount} from "../src/ArdoiseAccount.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {DebtLine, IArdoise} from "../src/interfaces/IArdoise.sol";
import {IGuard} from "../src/interfaces/IGuard.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {MockGuard, MockTokenMessenger, TokenVenue} from "./mocks/ArdoiseMocks.sol";
import {MockToken} from "./venues/mocks/MockAaveV4.sol";

/// @notice Unit tests of `ArdoiseAccount` with mock venues, guard and CCTP.
contract ArdoiseAccountTest is Test {
    uint256 internal constant USDC = 1e6;
    uint32 internal constant ARC = 26;
    uint32 internal constant BASE = 6;
    uint32 internal constant SOLANA = 5;

    MockToken internal usdc;
    MockTokenMessenger internal messenger;
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
        messenger = new MockTokenMessenger();
        factory = new ArdoiseFactory(
            admin, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), 2000, 100 * USDC, 500 * USDC
        );
        aave = new TokenVenue(factory, usdc, 310, 1_000_000 * USDC);
        morpho = new TokenVenue(factory, usdc, 450, 1_000_000 * USDC);
        guard = new MockGuard();
        _setVenues(aave, morpho);
        vm.startPrank(admin);
        factory.setGuard(guard);
        vm.stopPrank();
        vm.prank(owner);
        account = ArdoiseAccount(address(factory.createAccount()));
    }

    // ----- Configuration -----

    function test_readsVenuesAndGuardFromFactory() public {
        assertEq(account.ARC_DOMAIN(), 26);
        assertEq(address(account.guard()), address(guard));
        assertEq(account.venues().length, 2);
        _setVenues(morpho, morpho);
        assertEq(address(account.venues()[0]), address(morpho));
    }

    function test_setCaps_ownerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NotOwner.selector, stranger));
        vm.prank(stranger);
        account.setCaps(1, 1);

        vm.expectEmit(address(account));
        emit IArdoise.CapsUpdated(10 * USDC, 20 * USDC);
        vm.prank(owner);
        account.setCaps(10 * USDC, 20 * USDC);
        (uint256 perPayment, uint256 daily,) = account.caps();
        assertEq(perPayment, 10 * USDC);
        assertEq(daily, 20 * USDC);
    }

    function test_health_readsOwnersPositionOnVenue() public view {
        (uint256 hf, uint256 collateral, uint256 debt) = account.health(aave);
        assertEq(hf, 2e18);
        assertEq(collateral, 100e18);
        assertEq(debt, 50e18);
    }

    // ----- pay: checks -----

    function test_pay_ownerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NotOwner.selector, stranger));
        vm.prank(stranger);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");
    }

    function test_pay_rejectsZeroAmountAndFeeOnArc() public {
        vm.startPrank(owner);
        vm.expectRevert(ArdoiseAccount.ZeroAmount.selector);
        account.pay(0, ARC, _b(payee), 0, "");
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.FeeOnArc.selector, 1));
        account.pay(1 * USDC, ARC, _b(payee), 1, "");
        vm.stopPrank();
    }

    function test_pay_rejectsInvalidPayees() public {
        bytes32 dirty = bytes32(uint256(1) << 160 | uint256(uint160(payee)));
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.InvalidPayee.selector, bytes32(0)));
        account.pay(1 * USDC, ARC, bytes32(0), 0, "");
        vm.expectRevert(abi.encodeWithSelector(IArdoise.InvalidPayee.selector, dirty));
        account.pay(1 * USDC, ARC, dirty, 0, "");
        vm.expectRevert(abi.encodeWithSelector(IArdoise.InvalidPayee.selector, dirty));
        account.pay(1 * USDC, BASE, dirty, 0.06e6, "");
        vm.expectRevert(abi.encodeWithSelector(IArdoise.InvalidPayee.selector, bytes32(0)));
        account.pay(1 * USDC, SOLANA, bytes32(0), 0.06e6, "");
        vm.stopPrank();
    }

    function test_pay_acceptsFull32BytePayeeOnSolana() public {
        bytes32 solanaPayee = keccak256("solana account");
        vm.prank(owner);
        account.pay(1 * USDC, SOLANA, solanaPayee, 0.01e6, "");
        (, uint32 domain, bytes32 recipient,,,,,) = messenger.last();
        assertEq(domain, SOLANA);
        assertEq(recipient, solanaPayee);
    }

    function test_pay_enforcesPerPaymentCapOnAmountPlusFee() public {
        vm.expectRevert(abi.encodeWithSelector(IArdoise.CapExceeded.selector, 100 * USDC + 1, 100 * USDC));
        vm.prank(owner);
        account.pay(100 * USDC, BASE, _b(payee), 1, "");
    }

    function test_pay_enforcesDailyCapAndResetsNextUtcDay() public {
        vm.startPrank(owner);
        for (uint256 i = 0; i < 4; ++i) {
            account.pay(100 * USDC, ARC, _b(payee), 0, "");
        }
        account.pay(60 * USDC, ARC, _b(payee), 0, "");
        (,, uint256 spent) = account.caps();
        assertEq(spent, 460 * USDC);

        vm.expectRevert(abi.encodeWithSelector(IArdoise.CapExceeded.selector, 41 * USDC, 40 * USDC));
        account.pay(41 * USDC, ARC, _b(payee), 0, "");

        vm.warp((block.timestamp / 1 days + 1) * 1 days); // next UTC midnight
        (,, spent) = account.caps();
        assertEq(spent, 0);
        account.pay(100 * USDC, ARC, _b(payee), 0, "");
        vm.stopPrank();
    }

    // ----- pay: venue choice and guard -----

    function test_bestVenue_picksLowestRateWithEnoughLiquidity() public {
        assertEq(address(account.bestVenue(10 * USDC)), address(aave));
        aave.setMarket(310, 5 * USDC); // cheaper but too small
        assertEq(address(account.bestVenue(10 * USDC)), address(morpho));
        assertEq(address(account.bestVenue(5 * USDC)), address(aave));
    }

    function test_bestVenue_skipsVenueThatReverts() public {
        aave.setQuirks(true, 0, 0);
        assertEq(address(account.bestVenue(10 * USDC)), address(morpho));
    }

    function test_bestVenue_tieGoesToFirstVenue() public {
        morpho.setMarket(310, 1_000_000 * USDC);
        assertEq(address(account.bestVenue(10 * USDC)), address(aave));
    }

    function test_pay_revertsWhenNoVenueHasLiquidity() public {
        aave.setMarket(310, 1 * USDC);
        morpho.setMarket(450, 1 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NoVenueAvailable.selector, 2 * USDC));
        vm.prank(owner);
        account.pay(2 * USDC, ARC, _b(payee), 0, "");
    }

    function test_pay_revertsWhenGuardAllowsLess() public {
        guard.setCap(0.5e6);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.PaymentRefused.selector, 1.06e6, 0.5e6));
        vm.prank(owner);
        account.pay(1 * USDC, BASE, _b(payee), 0.06e6, "");
        assertEq(aave.borrowCount(), 0);
    }

    function test_pay_revertsWithoutGuard() public {
        vm.prank(admin);
        factory.setGuard(IGuard(address(0)));
        vm.expectRevert();
        vm.prank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");
    }

    // ----- pay: delivery and ledger -----

    function test_pay_onArcTransfersToPayeeAndRecordsLine() public {
        vm.expectEmit(address(account));
        emit IArdoise.Paid(1, aave, 2.5e6, 0, 2.5e6, 310, ARC, _b(payee), "coffee");
        vm.prank(owner);
        uint256 lineId = account.pay(2.5e6, ARC, _b(payee), 0, "coffee");

        assertEq(lineId, 1);
        assertEq(usdc.balanceOf(payee), 2.5e6);
        assertEq(usdc.balanceOf(address(account)), 0);
        assertEq(aave.debtOf(owner), 2.5e6);
        assertEq(messenger.burnCount(), 0);

        DebtLine memory l = account.line(1);
        assertEq(l.id, 1);
        assertEq(address(l.venue), address(aave));
        assertEq(l.principal, 2.5e6);
        assertEq(l.repaid, 0);
        assertEq(l.accruedInterest, 0);
        assertEq(l.rateBps, 310);
        assertEq(l.destinationDomain, ARC);
        assertEq(l.openedAt, block.timestamp);
        assertEq(l.payee, _b(payee));
        assertEq(l.memo, "coffee");
    }

    function test_pay_toBaseBurnsThroughCctpWithForwarder() public {
        vm.expectEmit(address(account));
        emit IArdoise.Paid(1, aave, 1 * USDC, 0.06e6, 1.06e6, 310, BASE, _b(payee), "rent");
        vm.prank(owner);
        account.pay(1 * USDC, BASE, _b(payee), 0.06e6, "rent");

        (
            uint256 amount,
            uint32 domain,
            bytes32 recipient,
            address burnToken,
            bytes32 destinationCaller,
            uint256 maxFee,
            uint32 finality,
            bytes memory hookData
        ) = messenger.last();
        assertEq(amount, 1.06e6);
        assertEq(domain, BASE);
        assertEq(recipient, _b(payee));
        assertEq(burnToken, address(usdc));
        assertEq(destinationCaller, bytes32(0));
        assertEq(maxFee, 0.06e6);
        assertEq(finality, 2000);
        assertEq(hookData, hex"636374702d666f72776172640000000000000000000000000000000000000000");
        assertEq(usdc.balanceOf(address(messenger)), 1.06e6);
        assertEq(usdc.balanceOf(address(account)), 0);
        assertEq(usdc.allowance(address(account), address(messenger)), 0);
        assertEq(account.line(1).principal, 1.06e6);
    }

    function test_pay_revertsWhenVenueSendsShort() public {
        aave.setQuirks(false, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.BorrowShortfall.selector, 1 * USDC, 1 * USDC - 1));
        vm.prank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");
    }

    function test_pay_keepsVenueSurplusForSweep() public {
        aave.setQuirks(false, 0, 1);
        vm.prank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");
        assertEq(usdc.balanceOf(payee), 1 * USDC);
        assertEq(usdc.balanceOf(address(account)), 1);
        assertEq(account.line(1).principal, 1 * USDC + 1);
    }

    function test_lines_listsEveryLineOldestFirst() public {
        vm.startPrank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "a");
        morpho.setMarket(100, 1_000_000 * USDC);
        account.pay(2 * USDC, BASE, _b(payee), 0.05e6, "b");
        vm.stopPrank();

        DebtLine[] memory all = account.lines();
        assertEq(all.length, 2);
        assertEq(all[0].id, 1);
        assertEq(all[0].memo, "a");
        assertEq(address(all[0].venue), address(aave));
        assertEq(all[1].id, 2);
        assertEq(all[1].principal, 2.05e6);
        assertEq(address(all[1].venue), address(morpho));
        assertEq(all[1].rateBps, 100);
    }

    function test_line_revertsForUnknownId() public {
        vm.expectRevert(abi.encodeWithSelector(IArdoise.UnknownLine.selector, 0));
        account.line(0);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.UnknownLine.selector, 1));
        account.line(1);
    }

    function test_line_accruesSimpleInterest() public {
        vm.prank(owner);
        account.pay(100 * USDC, ARC, _b(payee), 0, "");
        skip(365 days);
        // 3.10% of 100 USDC over a year.
        assertEq(account.line(1).accruedInterest, 3.1e6);
        skip(73 days);
        assertEq(account.line(1).accruedInterest, 3.72e6);
    }

    // ----- repay -----

    function test_repay_byAnyoneCapsAtLineAndRefundsTheRest() public {
        _payArc(1 * USDC);
        _fund(stranger, 5 * USDC);

        vm.expectEmit(address(account));
        emit IArdoise.LineRepaid(1, stranger, 1 * USDC);
        vm.prank(stranger);
        uint256 repaid = account.repay(1, 5 * USDC);

        assertEq(repaid, 1 * USDC);
        assertEq(usdc.balanceOf(stranger), 4 * USDC);
        assertEq(aave.debtOf(owner), 0);
        assertEq(usdc.balanceOf(address(account)), 0);
        DebtLine memory l = account.line(1);
        assertEq(l.repaid, 1 * USDC);
        assertEq(l.accruedInterest, 0);

        vm.expectRevert(abi.encodeWithSelector(IArdoise.LineAlreadyRepaid.selector, 1));
        vm.prank(stranger);
        account.repay(1, 1);
    }

    function test_repay_partialKeepsLineOpen() public {
        _payArc(3 * USDC);
        _fund(owner, 1 * USDC);
        vm.prank(owner);
        assertEq(account.repay(1, 1 * USDC), 1 * USDC);
        assertEq(account.line(1).repaid, 1 * USDC);
        assertEq(aave.debtOf(owner), 2 * USDC);
        _fund(owner, 2 * USDC);
        vm.prank(owner);
        account.repay(1, 2 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.LineAlreadyRepaid.selector, 1));
        account.repay(1, 1);
    }

    function test_repay_ofPrincipalSecondsLaterClosesLine() public {
        // Mainnet case: 0.50 USDC repaid 7 seconds after the payment must not leave 1 wei open.
        _payArc(0.5e6);
        skip(7);
        _fund(owner, 0.5e6);
        vm.prank(owner);
        account.repay(1, 0.5e6);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.LineAlreadyRepaid.selector, 1));
        account.repay(1, 1);
    }

    function test_repay_includesEstimatedInterest() public {
        _payArc(100 * USDC);
        skip(365 days);
        aave.setDebt(owner, 103.1e6); // the venue charged the same as the estimate
        _fund(stranger, 200 * USDC);
        vm.prank(stranger);
        assertEq(account.repay(1, 200 * USDC), 103.1e6);
        DebtLine memory l = account.line(1);
        assertEq(l.repaid, 103.1e6);
        assertEq(l.accruedInterest, 3.1e6);
    }

    function test_repay_closesLineWhenVenueDebtIsGone() public {
        _payArc(1 * USDC);
        skip(365 days);
        // The owner repaid directly on the venue, interest included, minus a little.
        aave.setDebt(owner, 0.5e6);
        _fund(stranger, 5 * USDC);
        vm.prank(stranger);
        assertEq(account.repay(1, 5 * USDC), 0.5e6);
        assertEq(usdc.balanceOf(stranger), 4.5e6);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.LineAlreadyRepaid.selector, 1));
        account.repay(1, 1);
    }

    function test_repay_revertsForUnknownLine() public {
        vm.expectRevert(abi.encodeWithSelector(IArdoise.UnknownLine.selector, 1));
        account.repay(1, 1);
    }

    // ----- sweep -----

    function test_sweep_repaysOldestOpenLinesFirst() public {
        _payArc(1 * USDC);
        _payArc(2 * USDC);
        _payArc(3 * USDC);
        // Line 2 is repaid separately; the sweep must skip it.
        _fund(owner, 2 * USDC);
        vm.prank(owner);
        account.repay(2, 2 * USDC);

        usdc.mint(address(account), 2.5e6); // a plain transfer to the account
        vm.prank(stranger);
        uint256 repaid = account.sweep();

        assertEq(repaid, 2.5e6);
        assertEq(account.line(1).repaid, 1 * USDC);
        assertEq(account.line(3).repaid, 1.5e6);
        assertEq(usdc.balanceOf(address(account)), 0);
        assertEq(aave.debtOf(owner), 1.5e6);
    }

    function test_sweep_leavesBalanceWhenEverythingIsRepaid() public {
        _payArc(1 * USDC);
        usdc.mint(address(account), 3 * USDC);
        assertEq(account.sweep(), 1 * USDC);
        assertEq(usdc.balanceOf(address(account)), 2 * USDC);
        assertEq(account.sweep(), 0);
        assertEq(usdc.balanceOf(address(account)), 2 * USDC);
    }

    function test_sweep_worksWithoutGuardOrLines() public {
        assertEq(account.sweep(), 0);
        _payArc(1 * USDC);
        vm.prank(admin);
        factory.setGuard(IGuard(address(0)));
        usdc.mint(address(account), 1 * USDC);
        assertEq(account.sweep(), 1 * USDC);
    }

    function test_sweep_emitsLineRepaidWithAccountAsPayer() public {
        _payArc(1 * USDC);
        usdc.mint(address(account), 1 * USDC);
        vm.expectEmit(address(account));
        emit IArdoise.LineRepaid(1, address(account), 1 * USDC);
        account.sweep();
    }

    // ----- reentrancy -----

    function test_reentrancy_venueCannotReenterDuringBorrow() public {
        aave.setReentry(abi.encodeCall(IArdoise.sweep, ()));
        vm.expectRevert(ArdoiseAccount.Reentrancy.selector);
        vm.prank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");

        aave.setReentry(abi.encodeCall(IArdoise.repay, (1, 1)));
        vm.expectRevert(ArdoiseAccount.Reentrancy.selector);
        vm.prank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");
    }

    // ----- helpers -----

    function _setVenues(IVenue a, IVenue b) internal {
        IVenue[] memory list = new IVenue[](2);
        list[0] = a;
        list[1] = b;
        vm.prank(admin);
        factory.setVenues(list);
    }

    function _payArc(uint256 amount) internal {
        vm.prank(owner);
        account.pay(amount, ARC, _b(payee), 0, "");
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(account), amount);
    }

    function _b(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
