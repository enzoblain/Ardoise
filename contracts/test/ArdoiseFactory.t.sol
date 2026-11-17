// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseAccount} from "../src/ArdoiseAccount.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {IArdoise} from "../src/interfaces/IArdoise.sol";
import {IArdoiseFactory} from "../src/interfaces/IArdoiseFactory.sol";
import {IGuard} from "../src/interfaces/IGuard.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {MockGuard, MockTokenMessenger, TokenVenue} from "./mocks/ArdoiseMocks.sol";
import {MockToken} from "./venues/mocks/MockAaveV4.sol";

/// @notice Unit tests of `ArdoiseFactory`: account registry, venue list and guard.
contract ArdoiseFactoryTest is Test {
    MockToken internal usdc;
    MockTokenMessenger internal messenger;
    ArdoiseFactory internal factory;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockToken(6);
        messenger = new MockTokenMessenger();
        factory = _deploy(admin);
    }

    function test_constructor_storesConfiguration() public view {
        assertEq(factory.admin(), admin);
        assertEq(address(factory.usdc()), address(usdc));
        assertEq(address(factory.tokenMessenger()), address(messenger));
        assertEq(factory.minFinalityThreshold(), 2000);
        assertEq(factory.defaultPerPaymentCap(), 100e6);
        assertEq(factory.defaultDailyCap(), 500e6);
        assertEq(factory.venues().length, 0);
        assertEq(address(factory.guard()), address(0));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ArdoiseFactory.ZeroAddress.selector);
        _deploy(address(0));
        vm.expectRevert(ArdoiseFactory.ZeroAddress.selector);
        new ArdoiseFactory(admin, IERC20(address(0)), ITokenMessengerV2(address(messenger)), 2000, 1, 1);
        vm.expectRevert(ArdoiseFactory.ZeroAddress.selector);
        new ArdoiseFactory(admin, IERC20(address(usdc)), ITokenMessengerV2(address(0)), 2000, 1, 1);
    }

    function test_createAccount_registersCallerAsOwner() public {
        vm.recordLogs();
        vm.prank(alice);
        IArdoise account = factory.createAccount();

        assertEq(address(factory.accountOf(alice)), address(account));
        assertEq(account.owner(), alice);
        ArdoiseAccount concrete = ArdoiseAccount(address(account));
        assertEq(address(concrete.factory()), address(factory));
        assertEq(address(concrete.usdc()), address(usdc));
        assertEq(address(concrete.tokenMessenger()), address(messenger));
        assertEq(concrete.minFinalityThreshold(), 2000);
        (uint256 perPayment, uint256 daily, uint256 spent) = account.caps();
        assertEq(perPayment, 100e6);
        assertEq(daily, 500e6);
        assertEq(spent, 0);
    }

    function test_createAccount_emitsAccountCreated() public {
        // The account address is the factory's first CREATE.
        address expected = vm.computeCreateAddress(address(factory), 1);
        vm.expectEmit(address(factory));
        emit IArdoiseFactory.AccountCreated(alice, IArdoise(expected));
        vm.prank(alice);
        factory.createAccount();
    }

    function test_createAccount_revertsWhenCallerHasOne() public {
        vm.prank(alice);
        IArdoise account = factory.createAccount();
        vm.expectRevert(abi.encodeWithSelector(IArdoiseFactory.AccountExists.selector, account));
        vm.prank(alice);
        factory.createAccount();
        assertEq(address(factory.accountOf(alice)), address(account));
    }

    function test_createAccount_givesEachUserTheirOwn() public {
        vm.prank(alice);
        IArdoise a = factory.createAccount();
        vm.prank(bob);
        IArdoise b = factory.createAccount();
        assertTrue(address(a) != address(b));
        assertEq(b.owner(), bob);
        assertEq(address(factory.accountOf(makeAddr("nobody"))), address(0));
    }

    function test_setVenues_adminOnly() public {
        IVenue[] memory list = new IVenue[](1);
        list[0] = new TokenVenue(factory, usdc, 300, 1e12);
        vm.expectRevert(abi.encodeWithSelector(ArdoiseFactory.NotAdmin.selector, alice));
        vm.prank(alice);
        factory.setVenues(list);

        vm.expectEmit(address(factory));
        emit IArdoiseFactory.VenuesUpdated(list);
        vm.prank(admin);
        factory.setVenues(list);
        assertEq(address(factory.venues()[0]), address(list[0]));
    }

    function test_setVenues_rejectsVenueForAnotherAssetOrFactory() public {
        IVenue[] memory list = new IVenue[](1);
        list[0] = new TokenVenue(factory, new MockToken(6), 300, 1e12);
        vm.expectRevert(abi.encodeWithSelector(ArdoiseFactory.InvalidVenue.selector, list[0]));
        vm.prank(admin);
        factory.setVenues(list);

        list[0] = new TokenVenue(_deploy(admin), usdc, 300, 1e12);
        vm.expectRevert(abi.encodeWithSelector(ArdoiseFactory.InvalidVenue.selector, list[0]));
        vm.prank(admin);
        factory.setVenues(list);
    }

    function test_setGuard_adminOnlyAndReadByAccounts() public {
        vm.prank(alice);
        IArdoise account = factory.createAccount();
        IGuard newGuard = new MockGuard();

        vm.expectRevert(abi.encodeWithSelector(ArdoiseFactory.NotAdmin.selector, alice));
        vm.prank(alice);
        factory.setGuard(newGuard);

        vm.expectEmit(address(factory));
        emit IArdoiseFactory.GuardUpdated(newGuard);
        vm.prank(admin);
        factory.setGuard(newGuard);
        // Existing accounts follow the factory.
        assertEq(address(account.guard()), address(newGuard));
    }

    function _deploy(address admin_) internal returns (ArdoiseFactory) {
        return
            new ArdoiseFactory(admin_, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), 2000, 100e6, 500e6);
    }
}
