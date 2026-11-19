// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseAccount} from "../src/ArdoiseAccount.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {IArdoise} from "../src/interfaces/IArdoise.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {GreedyVenue, MockGuard, MockTokenMessenger, TokenVenue} from "./mocks/ArdoiseMocks.sol";
import {MockToken} from "./venues/mocks/MockAaveV4.sol";

/// @notice Tests of the account's accepted venues: the account borrows from, approves and pays
/// only venues its owner accepted, whatever the factory admin lists afterwards.
contract ArdoiseAccountVenuesTest is Test {
    uint256 internal constant USDC = 1e6;
    uint32 internal constant ARC = 26;
    /// @dev Timestamp of `setUp`. Later times are written from it rather than from
    /// `block.timestamp`, which the IR pipeline may read only once per test.
    uint256 internal constant START = 1_763_400_000;

    MockToken internal usdc;
    ArdoiseFactory internal factory;
    MockGuard internal guard;
    TokenVenue internal aave;
    TokenVenue internal morpho;
    GreedyVenue internal greedy;
    ArdoiseAccount internal account;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    address internal thief = makeAddr("thief");

    function setUp() public {
        vm.warp(START);
        usdc = new MockToken(6);
        MockTokenMessenger messenger = new MockTokenMessenger();
        factory = new ArdoiseFactory(
            admin, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), 2000, 100 * USDC, 500 * USDC
        );
        aave = new TokenVenue(factory, usdc, 310, 1_000_000 * USDC);
        morpho = new TokenVenue(factory, usdc, 450, 1_000_000 * USDC);
        greedy = new GreedyVenue(factory, usdc, thief);
        guard = new MockGuard();
        vm.prank(admin);
        factory.setGuard(guard);
        _list(_two(aave, morpho));
        vm.prank(owner);
        account = ArdoiseAccount(address(factory.createAccount()));
    }

    // ----- creation -----

    function test_creation_acceptsTheFactoryListOfThatMoment() public {
        vm.expectEmit();
        emit ArdoiseAccount.VenueAccepted(aave);
        vm.expectEmit();
        emit ArdoiseAccount.VenueAccepted(morpho);
        vm.prank(stranger);
        ArdoiseAccount other = ArdoiseAccount(address(factory.createAccount()));

        IVenue[] memory accepted = other.acceptedVenues();
        assertEq(accepted.length, 2);
        assertEq(address(accepted[0]), address(aave));
        assertEq(address(accepted[1]), address(morpho));
        assertEq(other.venues().length, 2);
    }

    function test_creation_acceptsADuplicateOnceAndAtMostTheMaximum() public {
        uint256 max = account.MAX_ACCEPTED_VENUES();
        IVenue[] memory list = new IVenue[](max + 2);
        list[0] = aave;
        list[1] = aave;
        for (uint256 i = 2; i < list.length; ++i) {
            list[i] = new TokenVenue(factory, usdc, 500, 1_000_000 * USDC);
        }
        _list(list);
        vm.prank(stranger);
        ArdoiseAccount other = ArdoiseAccount(address(factory.createAccount()));

        IVenue[] memory accepted = other.acceptedVenues();
        assertEq(accepted.length, max);
        assertEq(address(accepted[0]), address(aave));
        assertEq(address(accepted[1]), address(list[2]));
        assertEq(other.venues().length, max);

        // The venue left out can only replace one the owner revokes.
        IVenue last = list[list.length - 1];
        vm.startPrank(stranger);
        vm.expectRevert(ArdoiseAccount.TooManyVenues.selector);
        other.acceptVenue(last);
        other.revokeVenue(aave);
        other.acceptVenue(last);
        vm.stopPrank();
        assertEq(other.acceptedVenues().length, max);
    }

    // ----- a venue listed after creation -----

    function test_venues_leavesOutAVenueListedAfterCreation() public {
        _list(_two(greedy, aave));
        IVenue[] memory usable = account.venues();
        assertEq(usable.length, 1);
        assertEq(address(usable[0]), address(aave));
        assertEq(account.acceptedVenues().length, 2);
    }

    /// The scenario of the security review: an honest 100 USDC line, 300 USDC waiting on the
    /// account, then the admin lists a venue that claims an unlimited debt and the worst health.
    function test_sweep_neverPaysAVenueListedAfterCreation() public {
        _payArc(100 * USDC);
        aave.setHealth(1.05e18);
        usdc.mint(address(account), 300 * USDC);
        _list(_two(greedy, aave));

        // Not even read: a venue the owner never accepted cannot spend the sweep's gas either.
        vm.expectCall(address(greedy), abi.encodeWithSelector(IVenue.health.selector), 0);
        vm.expectCall(address(greedy), abi.encodeWithSelector(IVenue.debtOf.selector), 0);
        vm.expectCall(address(greedy), abi.encodeWithSelector(IVenue.repay.selector), 0);
        vm.prank(stranger);
        assertEq(account.sweep(), 100 * USDC);

        assertEq(usdc.balanceOf(thief), 0);
        assertEq(usdc.allowance(address(account), address(greedy)), 0);
        assertEq(aave.debtOf(owner), 0);
        assertTrue(account.closed(1));
        assertEq(usdc.balanceOf(address(account)), 200 * USDC);
    }

    function test_sweep_withoutLinesLeavesTheBalanceWhenOnlyANonAcceptedVenueClaimsDebt() public {
        usdc.mint(address(account), 300 * USDC);
        _list(_two(aave, greedy));
        vm.prank(stranger);
        assertEq(account.sweep(), 0);
        assertEq(usdc.balanceOf(thief), 0);
        assertEq(usdc.balanceOf(address(account)), 300 * USDC);
    }

    function test_pay_neverSelectsANonAcceptedVenueEvenAtRateZero() public {
        usdc.mint(address(greedy), 100 * USDC); // it could front the payment to own a line
        _list(_two(greedy, aave));
        assertEq(address(account.bestVenue(100 * USDC)), address(aave));

        // Not even asked for its rate or liquidity: only `venues()` are considered.
        vm.expectCall(address(greedy), abi.encodeWithSelector(IVenue.rate.selector), 0);
        vm.expectCall(address(greedy), abi.encodeWithSelector(IVenue.available.selector), 0);
        vm.expectCall(address(greedy), abi.encodeWithSelector(IVenue.borrow.selector), 0);
        _payArc(100 * USDC);
        assertEq(address(account.line(1).venue), address(aave));
        assertEq(usdc.balanceOf(address(greedy)), 100 * USDC);

        // With no line on it, the later sweep has nothing to give it.
        usdc.mint(address(account), 300 * USDC);
        account.sweep();
        assertEq(usdc.balanceOf(thief), 0);
        assertEq(usdc.balanceOf(address(account)), 200 * USDC);
    }

    function test_pay_revertsWhenOnlyNonAcceptedVenuesAreListed() public {
        _list(_two(greedy, greedy));
        assertEq(account.venues().length, 0);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NoVenueAvailable.selector, 1 * USDC));
        vm.prank(owner);
        account.pay(1 * USDC, ARC, _b(payee), 0, "");
    }

    function test_payVia_revertsForAListedVenueTheOwnerDidNotAccept() public {
        usdc.mint(address(greedy), 100 * USDC);
        _list(_two(aave, greedy));
        vm.expectRevert(abi.encodeWithSelector(IArdoise.UnknownVenue.selector, greedy));
        vm.prank(owner);
        account.payVia(greedy, 1 * USDC, ARC, _b(payee), 0, "");
    }

    // ----- acceptVenue -----

    function test_acceptVenue_ownerOnly() public {
        TokenVenue added = _listThird();
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NotOwner.selector, admin));
        vm.prank(admin);
        account.acceptVenue(added);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NotOwner.selector, stranger));
        vm.prank(stranger);
        account.acceptVenue(added);
        assertEq(account.acceptedVenues().length, 2);
    }

    function test_acceptVenue_makesAListedVenueUsable() public {
        TokenVenue added = _listThird(); // the cheapest of the three, at 1 bps
        assertEq(address(account.bestVenue(1 * USDC)), address(aave));

        vm.expectEmit(address(account));
        emit ArdoiseAccount.VenueAccepted(added);
        vm.prank(owner);
        account.acceptVenue(added);

        assertEq(account.acceptedVenues().length, 3);
        assertEq(account.venues().length, 3);
        assertEq(address(account.bestVenue(1 * USDC)), address(added));
        vm.prank(owner);
        account.payVia(added, 1 * USDC, ARC, _b(payee), 0, "");
        assertEq(added.debtOf(owner), 1 * USDC);

        usdc.mint(address(account), 1 * USDC);
        assertEq(account.sweep(), 1 * USDC);
        assertEq(added.debtOf(owner), 0);
    }

    function test_acceptVenue_revertsForAVenueTheFactoryDoesNotList() public {
        TokenVenue rogue = new TokenVenue(factory, usdc, 1, 1_000_000 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IArdoise.UnknownVenue.selector, rogue));
        vm.prank(owner);
        account.acceptVenue(rogue);
    }

    function test_acceptVenue_revertsForAnAcceptedVenue() public {
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.VenueAlreadyAccepted.selector, aave));
        vm.prank(owner);
        account.acceptVenue(aave);
    }

    // ----- revokeVenue -----

    function test_revokeVenue_ownerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(IArdoise.NotOwner.selector, stranger));
        vm.prank(stranger);
        account.revokeVenue(aave);
        assertEq(account.acceptedVenues().length, 2);
    }

    function test_revokeVenue_stopsBorrowingThere() public {
        vm.expectEmit(address(account));
        emit ArdoiseAccount.VenueRevoked(aave);
        vm.prank(owner);
        account.revokeVenue(aave);

        IVenue[] memory usable = account.venues();
        assertEq(usable.length, 1);
        assertEq(address(usable[0]), address(morpho));
        assertEq(address(account.bestVenue(1 * USDC)), address(morpho)); // Aave is cheaper, but revoked
        vm.expectRevert(abi.encodeWithSelector(IArdoise.UnknownVenue.selector, aave));
        vm.prank(owner);
        account.payVia(aave, 1 * USDC, ARC, _b(payee), 0, "");

        // The owner may change their mind while the factory still lists it.
        vm.prank(owner);
        account.acceptVenue(aave);
        assertEq(address(account.bestVenue(1 * USDC)), address(aave));
    }

    function test_revokeVenue_revertsForAVenueThatIsNotAccepted() public {
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.VenueNotAccepted.selector, greedy));
        vm.prank(owner);
        account.revokeVenue(greedy);
    }

    function test_sweep_repaysALineOnARevokedVenueLast() public {
        vm.startPrank(owner);
        account.pay(2 * USDC, ARC, _b(payee), 0, ""); // line 1, Aave
        account.payVia(morpho, 3 * USDC, ARC, _b(payee), 0, ""); // line 2, Morpho
        account.revokeVenue(aave);
        vm.stopPrank();
        // Aave is closest to liquidation, but revoked: its health is not read and Morpho, still
        // accepted, is served first.
        aave.setHealth(1.01e18);
        vm.expectCall(address(aave), abi.encodeWithSelector(IVenue.health.selector), 0);
        usdc.mint(address(account), 4 * USDC);
        assertEq(account.sweep(), 4 * USDC);
        assertTrue(account.closed(2));
        assertFalse(account.closed(1));
        assertEq(morpho.debtOf(owner), 0);
        assertEq(aave.debtOf(owner), 1 * USDC);

        usdc.mint(address(account), 5 * USDC);
        assertEq(account.sweep(), 1 * USDC);
        assertTrue(account.closed(1));
        assertEq(aave.debtOf(owner), 0);
        assertEq(usdc.balanceOf(address(account)), 4 * USDC);
    }

    function test_sweep_paysARevokedVenueNoMoreThanItsLines() public {
        _payArc(2 * USDC); // line 1, Aave
        vm.prank(owner);
        account.revokeVenue(aave);
        aave.setDebt(owner, 50 * USDC); // whatever the revoked venue now claims
        usdc.mint(address(account), 10 * USDC);
        assertEq(account.sweep(), 2 * USDC);
        assertEq(aave.debtOf(owner), 48 * USDC);
        assertEq(usdc.balanceOf(address(account)), 8 * USDC);
        assertEq(usdc.allowance(address(account), address(aave)), 0);
        assertTrue(account.closed(1));

        // With the line closed, later sweeps give the revoked venue nothing more.
        assertEq(account.sweep(), 0);
        assertEq(usdc.balanceOf(address(account)), 8 * USDC);
    }

    function test_repay_stillWorksOnALineOfARevokedVenue() public {
        _payArc(2 * USDC); // line 1, Aave
        vm.prank(owner);
        account.revokeVenue(aave);
        usdc.mint(stranger, 2 * USDC);
        vm.startPrank(stranger);
        usdc.approve(address(account), 2 * USDC);
        assertEq(account.repay(1, 2 * USDC), 2 * USDC);
        vm.stopPrank();
        assertTrue(account.closed(1));
        assertEq(aave.debtOf(owner), 0);
    }

    /// A revoked venue that takes the tokens and reports nothing repaid: without crediting the
    /// line with what left, its line would stay open and every sweep would pay it again.
    function test_sweep_neverPaysAnUnderReportingRevokedVenueMoreThanItsLines() public {
        _payArc(1 * USDC); // line 1, Aave
        vm.prank(owner);
        account.payVia(morpho, 2 * USDC, ARC, _b(payee), 0, ""); // line 2, Morpho, stays honest
        vm.prank(owner);
        account.revokeVenue(aave);
        aave.setRepayQuirk(TokenVenue.RepayQuirk.TakesAllReportsNothing);
        usdc.mint(address(account), 300 * USDC);

        uint256 owed = 1 * USDC; // no time has passed: the line's estimate is its principal
        for (uint256 i = 0; i < 50; ++i) {
            vm.prank(stranger);
            account.sweep();
        }
        assertEq(usdc.balanceOf(address(aave)), owed);
        assertTrue(account.closed(1));
        assertEq(account.line(1).repaid, owed);
        assertEq(morpho.debtOf(owner), 0);
        assertEq(usdc.balanceOf(address(account)), 300 * USDC - owed - 2 * USDC);
        assertEq(usdc.allowance(address(account), address(aave)), 0);
    }

    function test_sweep_boundsAnUnderReportingRevokedVenueByTheInterestEstimateToo() public {
        _payArc(100 * USDC); // line 1, Aave, at 310 bps
        vm.prank(owner);
        account.revokeVenue(aave);
        aave.setRepayQuirk(TokenVenue.RepayQuirk.TakesAllReportsNothing);
        // USDC arrives in three transfers, a day apart, each followed by several sweeps.
        vm.warp(START + 365 days);
        usdc.mint(address(account), 40 * USDC);
        _sweepTimes(5);
        assertEq(usdc.balanceOf(address(aave)), 40 * USDC);
        vm.warp(START + 366 days);
        usdc.mint(address(account), 40 * USDC);
        _sweepTimes(5);
        assertEq(usdc.balanceOf(address(aave)), 80 * USDC);
        assertFalse(account.closed(1));
        vm.warp(START + 367 days);
        usdc.mint(address(account), 220 * USDC);
        _sweepTimes(5);

        // Principal plus 367 days of simple interest at the recorded 3.10%, rounded down.
        uint256 owed = 100 * USDC + (100 * USDC * 310 * 367 days) / (10_000 * 365 days);
        assertEq(usdc.balanceOf(address(aave)), owed);
        assertTrue(account.closed(1));
        assertEq(usdc.balanceOf(address(account)), 300 * USDC - owed);

        vm.warp(START + 400 days);
        _sweepTimes(5);
        assertEq(usdc.balanceOf(address(aave)), owed);
    }

    /// A venue that takes 1 wei less than approved and reports nothing keeps its line open, so
    /// interest keeps running; what it receives still follows the line's estimate.
    function test_sweep_boundsAVenueThatKeepsItsLineOpen() public {
        _payArc(1 * USDC); // line 1, Aave
        vm.prank(owner);
        account.payVia(morpho, 50 * USDC, ARC, _b(payee), 0, ""); // line 2, Morpho, stays honest
        vm.prank(owner);
        account.revokeVenue(aave);
        aave.setRepayQuirk(TokenVenue.RepayQuirk.TakesLessReportsNothing);
        usdc.mint(address(account), 300 * USDC);

        _sweepTimes(50);
        assertEq(usdc.balanceOf(address(aave)), 1 * USDC - 1);
        assertFalse(account.closed(1));
        assertEq(account.line(1).repaid, 1 * USDC - 1);
        assertEq(usdc.allowance(address(account), address(aave)), 0);
        assertEq(morpho.debtOf(owner), 0);
        assertEq(usdc.balanceOf(address(account)), 249 * USDC + 1);
    }

    // ----- the rate recorded on a line -----

    function test_pay_capsTheRateRecordedOnTheLine() public {
        aave.setMarket(type(uint32).max, 1_000_000 * USDC);
        morpho.setMarket(type(uint256).max, 1_000_000 * USDC);
        vm.expectEmit(address(account));
        emit IArdoise.Paid(1, aave, 1 * USDC, 0, 1 * USDC, 10_000, ARC, _b(payee), "");
        _payArc(1 * USDC);
        assertEq(account.MAX_LINE_RATE_BPS(), 10_000);
        assertEq(account.line(1).rateBps, 10_000);

        vm.warp(START + 365 days);
        assertEq(account.line(1).accruedInterest, 1 * USDC); // 100% a year, not 429,496,729%
    }

    /// The second review's scenario: a venue records the highest rate it can, is revoked, then
    /// keeps its line open by taking 1 wei less than approved on every sweep.
    function test_sweep_rateCapBoundsWhatAHostileVenueCollectsOverTime() public {
        aave.setMarket(type(uint32).max, 1_000_000 * USDC);
        vm.prank(owner);
        account.payVia(aave, 1 * USDC, ARC, _b(payee), 0, "");
        vm.prank(owner);
        account.revokeVenue(aave);
        aave.setRepayQuirk(TokenVenue.RepayQuirk.TakesLessReportsNothing);
        usdc.mint(address(account), 300 * USDC);

        for (uint256 hour = 1; hour <= 6; ++hour) {
            vm.warp(START + hour * 1 hours);
            _sweepTimes(3);
        }
        // Six hours at 100% a year add under 0.07% of the principal.
        uint256 estimate = 1 * USDC + (1 * USDC * 10_000 * 6 hours) / (10_000 * 365 days);
        assertEq(estimate, 1_000_684);
        assertLt(usdc.balanceOf(address(aave)), estimate);
        assertGt(usdc.balanceOf(address(account)), 298.999e6);

        // A whole year of hourly sweeps: at most the principal again.
        vm.warp(START + 365 days);
        _sweepTimes(3);
        assertLt(usdc.balanceOf(address(aave)), 2 * USDC);
    }

    // ----- a venue cannot block the sweep -----

    function test_sweep_survivesAVenueSendingTokensDuringRepay() public {
        _openHonestAndRevokedLines();
        aave.setRepayQuirk(TokenVenue.RepayQuirk.SendsDust);
        assertEq(account.sweep(), 50 * USDC);
        assertEq(morpho.debtOf(owner), 0);
        assertEq(usdc.balanceOf(address(aave)), 0);
        assertFalse(account.closed(1));
        assertEq(usdc.allowance(address(account), address(aave)), 0);
        assertEq(usdc.balanceOf(address(account)), 250 * USDC + 1);
    }

    function test_sweep_survivesAVenueReturningNoData() public {
        _openHonestAndRevokedLines();
        aave.setRepayQuirk(TokenVenue.RepayQuirk.ReturnsNothing);
        assertEq(account.sweep(), 51 * USDC);
        assertEq(morpho.debtOf(owner), 0);
        // The tokens it took are what the line is credited with.
        assertEq(usdc.balanceOf(address(aave)), 1 * USDC);
        assertTrue(account.closed(1));
        assertEq(usdc.balanceOf(address(account)), 249 * USDC);
    }

    function test_sweep_survivesAVenueReportingMaxOnAPartlyRepaidLine() public {
        _openHonestAndRevokedLines();
        usdc.mint(stranger, 0.4e6);
        vm.startPrank(stranger);
        usdc.approve(address(account), 0.4e6);
        account.repay(1, 0.4e6);
        vm.stopPrank();
        aave.setRepayQuirk(TokenVenue.RepayQuirk.ReportsMax);

        // The report is capped at what the venue was approved for, here and in the total.
        assertEq(account.sweep(), 50 * USDC + 0.6e6);
        assertEq(morpho.debtOf(owner), 0);
        assertEq(account.line(1).repaid, 1 * USDC);
        assertTrue(account.closed(1));
        assertEq(usdc.balanceOf(address(aave)), 1 * USDC);
    }

    function test_sweep_survivesAnAcceptedVenueReportingMax() public {
        _payArc(1 * USDC); // line 1, Aave
        vm.prank(owner);
        account.payVia(morpho, 50 * USDC, ARC, _b(payee), 0, ""); // line 2, Morpho
        aave.setDebt(owner, 3 * USDC); // 2 USDC beyond the line
        aave.setHealth(1.1e18); // served first, so its reports come before Morpho's in the total
        aave.setRepayQuirk(TokenVenue.RepayQuirk.ReportsMax);
        usdc.mint(address(account), 300 * USDC);
        assertEq(account.sweep(), 53 * USDC);
        assertEq(aave.debtOf(owner), 0);
        assertEq(morpho.debtOf(owner), 0);
        assertEq(usdc.balanceOf(address(account)), 247 * USDC);
    }

    function test_sweep_survivesMalformedDebtAndHealthAnswers() public {
        _openHonestAndRevokedLines();
        vm.mockCall(address(aave), abi.encodeWithSelector(IVenue.debtOf.selector), "");
        vm.mockCall(address(morpho), abi.encodeWithSelector(IVenue.health.selector), hex"01");
        assertEq(account.sweep(), 51 * USDC);
        assertEq(morpho.debtOf(owner), 0);
        assertTrue(account.closed(1)); // by its estimate: the venue's debt could not be read
        assertEq(usdc.balanceOf(address(account)), 249 * USDC);
    }

    function test_repay_stillBubblesARevertOfARevokedVenue() public {
        _openHonestAndRevokedLines();
        aave.setRepayBroken(true);
        usdc.mint(stranger, 1 * USDC);
        vm.startPrank(stranger);
        usdc.approve(address(account), 1 * USDC);
        vm.expectRevert(bytes("repay refused"));
        account.repay(1, 1 * USDC);
        vm.stopPrank();
    }

    function test_sweep_boundsAnUnderReportingDelistedVenueToo() public {
        _payArc(1 * USDC); // line 1, Aave
        _list(_two(morpho, morpho));
        aave.setRepayQuirk(TokenVenue.RepayQuirk.TakesAllReportsNothing);
        usdc.mint(address(account), 300 * USDC);
        for (uint256 i = 0; i < 20; ++i) {
            account.sweep();
        }
        assertEq(usdc.balanceOf(address(aave)), 1 * USDC);
        assertEq(usdc.balanceOf(address(account)), 299 * USDC);
    }

    function test_repay_creditsTheLineWithWhatTheVenueTook() public {
        _payArc(2 * USDC); // line 1, Aave
        aave.setRepayQuirk(TokenVenue.RepayQuirk.TakesAllReportsNothing);
        usdc.mint(stranger, 5 * USDC);
        vm.startPrank(stranger);
        usdc.approve(address(account), 5 * USDC);
        vm.expectEmit(address(account));
        emit IArdoise.LineRepaid(1, stranger, 2 * USDC);
        assertEq(account.repay(1, 5 * USDC), 2 * USDC);
        vm.stopPrank();
        assertTrue(account.closed(1));
        assertEq(usdc.balanceOf(stranger), 3 * USDC); // only what the line owed was taken
    }

    // ----- delisting -----

    function test_delistedVenue_staysAcceptedAndIsUsableAgainOnceRelisted() public {
        _list(_two(morpho, morpho));
        assertEq(account.venues().length, 1);
        assertEq(account.acceptedVenues().length, 2); // Aave keeps its place
        vm.expectRevert(abi.encodeWithSelector(IArdoise.UnknownVenue.selector, aave));
        vm.prank(owner);
        account.payVia(aave, 1 * USDC, ARC, _b(payee), 0, "");

        // Relisting needs no new consent from the owner.
        _list(_two(aave, morpho));
        assertEq(account.venues().length, 2);
        assertEq(address(account.bestVenue(1 * USDC)), address(aave));
        vm.prank(owner);
        account.payVia(aave, 1 * USDC, ARC, _b(payee), 0, "");
        assertEq(aave.debtOf(owner), 1 * USDC);
    }

    function test_delistedVenue_revokedByTheOwnerStaysOutWhenRelisted() public {
        _list(_two(morpho, morpho));
        vm.prank(owner);
        account.revokeVenue(aave); // revoking needs no listing
        _list(_two(aave, morpho));

        IVenue[] memory usable = account.venues();
        assertEq(usable.length, 1);
        assertEq(address(usable[0]), address(morpho));
        aave.setDebt(owner, 5 * USDC);
        usdc.mint(address(account), 5 * USDC);
        assertEq(account.sweep(), 0);
        assertEq(usdc.balanceOf(address(account)), 5 * USDC);
    }

    function test_revokeVenue_ofTheMiddleOneKeepsTheOthers() public {
        TokenVenue third = _listThird();
        vm.startPrank(owner);
        account.acceptVenue(third);
        account.revokeVenue(morpho);
        vm.stopPrank();

        IVenue[] memory accepted = account.acceptedVenues();
        assertEq(accepted.length, 2);
        assertEq(address(accepted[0]), address(aave));
        assertEq(address(accepted[1]), address(third));
        IVenue[] memory usable = account.venues();
        assertEq(usable.length, 2);
        assertEq(address(usable[0]), address(aave)); // the factory's order
        assertEq(address(usable[1]), address(third));
        vm.expectRevert(abi.encodeWithSelector(ArdoiseAccount.VenueNotAccepted.selector, morpho));
        vm.prank(owner);
        account.revokeVenue(morpho);
    }

    // ----- helpers -----

    /// @dev A 1 USDC line on Aave, then revoked, next to an honest 50 USDC line on Morpho, with
    /// 300 USDC waiting on the account.
    function _openHonestAndRevokedLines() internal {
        _payArc(1 * USDC); // line 1, Aave
        vm.startPrank(owner);
        account.payVia(morpho, 50 * USDC, ARC, _b(payee), 0, ""); // line 2, Morpho
        account.revokeVenue(aave);
        vm.stopPrank();
        usdc.mint(address(account), 300 * USDC);
    }

    function _sweepTimes(uint256 times) internal {
        for (uint256 i = 0; i < times; ++i) {
            vm.prank(stranger);
            account.sweep();
        }
    }

    function _list(IVenue[] memory list) internal {
        vm.prank(admin);
        factory.setVenues(list);
    }

    function _two(IVenue a, IVenue b) internal pure returns (IVenue[] memory list) {
        list = new IVenue[](2);
        list[0] = a;
        list[1] = b;
    }

    /// @dev Lists a third, honest venue next to the two the account accepted at creation.
    function _listThird() internal returns (TokenVenue added) {
        added = new TokenVenue(factory, usdc, 1, 1_000_000 * USDC);
        IVenue[] memory list = new IVenue[](3);
        list[0] = aave;
        list[1] = morpho;
        list[2] = added;
        _list(list);
    }

    function _payArc(uint256 amount) internal {
        vm.prank(owner);
        account.pay(amount, ARC, _b(payee), 0, "");
    }

    function _b(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
