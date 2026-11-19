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
        vm.warp(1_763_400_000);
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

    // ----- helpers -----

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
