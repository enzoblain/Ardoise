// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseFactory} from "../../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../../src/cctp/ITokenMessengerV2.sol";
import {MarginGuard} from "../../src/guard/MarginGuard.sol";
import {IArdoise} from "../../src/interfaces/IArdoise.sol";
import {IVenue} from "../../src/interfaces/IVenue.sol";
import {AaveV4Adapter} from "../../src/venues/AaveV4Adapter.sol";
import {MorphoAdapter} from "../../src/venues/MorphoAdapter.sol";
import {
    IAaveV4GiverPositionManager,
    IAaveV4Spoke,
    IAaveV4TakerPositionManager
} from "../../src/venues/aave/IAaveV4.sol";
import {IMorpho, MarketParams} from "../../src/venues/morpho/IMorpho.sol";
import {ArcBlocklistMock, ArcNativeCoinMock} from "../mocks/ArcNativeCoinMock.sol";

/// @notice Ardoise with both adapters against the real Arc mainnet contracts, on a fork.
/// @dev Skipped unless `ARC_FORK_URL` is set (an Arc mainnet RPC endpoint), so `forge test` stays
/// offline by default: `ARC_FORK_URL=https://rpc.blockdaemon.mainnet.arc.io forge test --match-contract Fork`.
contract MorphoAdapterForkTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant CIRBTC = 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0;
    address internal constant TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    IMorpho internal constant MORPHO = IMorpho(0x34CD04070dD72b14E241112F6d83812Df5Af7fCD);
    bytes32 internal constant MARKET = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;
    address internal constant AAVE_MAIN_SPOKE = 0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d;
    address internal constant AAVE_TAKER = 0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF;
    address internal constant AAVE_GIVER = 0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1;
    uint32 internal constant ARC = 26;

    ArdoiseFactory internal factory;
    AaveV4Adapter internal aave;
    MorphoAdapter internal morpho;
    address internal user = makeAddr("user");
    IArdoise internal account;
    bool internal forked;

    function setUp() public {
        string memory url = vm.envOr("ARC_FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        address nativeCoin = 0x1800000000000000000000000000000000000000;
        vm.etch(nativeCoin, address(new ArcNativeCoinMock()).code);
        vm.allowCheatcodes(nativeCoin);
        vm.etch(0x1800000000000000000000000000000000000001, address(new ArcBlocklistMock()).code);

        factory =
            new ArdoiseFactory(address(this), IERC20(USDC), ITokenMessengerV2(TOKEN_MESSENGER_V2), 2000, 10e6, 20e6);
        aave = new AaveV4Adapter(
            factory,
            IAaveV4Spoke(AAVE_MAIN_SPOKE),
            IAaveV4TakerPositionManager(AAVE_TAKER),
            IAaveV4GiverPositionManager(AAVE_GIVER),
            0
        );
        morpho = new MorphoAdapter(factory, MORPHO, MARKET);
        IVenue[] memory list = new IVenue[](2);
        list[0] = aave;
        list[1] = morpho;
        factory.setVenues(list);
        factory.setGuard(new MarginGuard(address(this), 1.25e18, 1.5e18));

        // The user has cirBTC on Morpho only: 0.001 BTC, about 60 USD.
        deal(CIRBTC, user, 100_000);
        vm.startPrank(user);
        IERC20(CIRBTC).approve(address(MORPHO), 100_000);
        MORPHO.supplyCollateral(_params(), 100_000, user, "");
        MORPHO.setAuthorization(address(morpho), true);
        account = factory.createAccount();
        vm.stopPrank();
    }

    function test_fork_readsTheMarketLikeTheApp() public view {
        if (!forked) return;
        assertEq(morpho.asset(), USDC);
        assertEq(morpho.collateralToken(), CIRBTC);
        assertEq(morpho.lltv(), 0.86e18);
        assertGt(morpho.rate(), 0);
        assertGt(morpho.available(), 1_000_000e6);
        (uint256 hf, uint256 collateralUsd, uint256 debtUsd) = morpho.health(user);
        assertEq(hf, type(uint256).max);
        assertGt(collateralUsd, 10e18);
        assertEq(debtUsd, 0);
    }

    function test_fork_paysFromMorphoWhenTheUserHasNoAavePosition() public {
        if (!forked) return;
        // Whichever venue is cheaper, the user can only borrow on Morpho.
        assertEq(address(account.bestVenue(5e6)), address(morpho));
        address payee = makeAddr("payee");
        vm.prank(user);
        account.pay(5e6, ARC, bytes32(uint256(uint160(payee))), 0, "fork test");
        assertEq(IERC20(USDC).balanceOf(payee), 5e6);
        assertApproxEqAbs(morpho.debtOf(user), 5e6, 1);
        assertLt(morpho.healthAfter(user, 0), type(uint256).max);
        assertGe(morpho.healthAfter(user, 0), 1.25e18);
    }

    function test_fork_refusesWhatTheGuardRefusesOnMorpho() public {
        if (!forked) return;
        // About 60 USD of collateral at 86% LLTV and a 1.25 minimum: about 41 USD at most.
        vm.prank(user);
        account.setCaps(100e6, 100e6);
        vm.expectPartialRevert(IArdoise.PaymentRefused.selector);
        vm.prank(user);
        account.pay(60e6, ARC, bytes32(uint256(uint160(user))), 0, "");
    }

    function test_fork_sweepRepaysTheMorphoDebt() public {
        if (!forked) return;
        vm.prank(user);
        account.pay(5e6, ARC, bytes32(uint256(uint160(user))), 0, "");
        vm.warp(block.timestamp + 1 days);
        uint256 debt = morpho.debtOf(user);
        assertGt(debt, 5e6, "a day of interest accrues");
        // The user sends back what they borrowed plus a little: the account repays the line.
        vm.prank(user);
        assertTrue(IERC20(USDC).transfer(address(account), 5e6));
        account.sweep();
        assertLe(morpho.debtOf(user), debt - 5e6 + 1);
    }

    function test_fork_onlyTheUsersAccountMayBorrow() public {
        if (!forked) return;
        // The user's Morpho authorization is the adapter's, but nobody else can spend it.
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(IVenue.UnauthorizedCaller.selector, stranger, user));
        vm.prank(stranger);
        morpho.borrow(user, 1e6);
        vm.expectRevert(abi.encodeWithSelector(IVenue.UnauthorizedCaller.selector, user, user));
        vm.prank(user);
        morpho.borrow(user, 1e6);
    }

    function test_fork_fullRepaymentClearsThePositionAndReturnsTheRest() public {
        if (!forked) return;
        vm.prank(user);
        account.pay(5e6, ARC, bytes32(uint256(uint160(user))), 0, "");
        vm.warp(block.timestamp + 7 days);
        uint256 debt = morpho.debtOf(user);
        // Anyone may repay: 10 USDC offered, exactly the debt is taken, by shares.
        vm.deal(address(this), 10e18);
        assertTrue(IERC20(USDC).approve(address(morpho), 10e6));
        uint256 repaid = morpho.repay(user, 10e6);
        assertEq(repaid, debt);
        assertEq(morpho.debtOf(user), 0);
        (, uint128 borrowShares,) = MORPHO.position(MARKET, user);
        assertEq(borrowShares, 0);
        assertEq(IERC20(USDC).balanceOf(address(this)), 10e6 - debt);
        assertEq(IERC20(USDC).allowance(address(this), address(morpho)), 10e6 - debt);
    }

    function _params() internal view returns (MarketParams memory) {
        return MarketParams({
            loanToken: morpho.asset(),
            collateralToken: morpho.collateralToken(),
            oracle: morpho.oracle(),
            irm: morpho.irm(),
            lltv: morpho.lltv()
        });
    }
}
