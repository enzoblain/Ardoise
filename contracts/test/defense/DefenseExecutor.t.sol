// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ITokenMessengerV2} from "../../src/cctp/ITokenMessengerV2.sol";
import {DefenseExecutor, IAggregatorV3, ISwapRouter02} from "../../src/defense/DefenseExecutor.sol";
import {MockTokenMessenger} from "../mocks/ArdoiseMocks.sol";
import {MockToken} from "../venues/mocks/MockAaveV4.sol";
import {FeedMock, SwapRouterMock} from "./DefenseMocks.sol";

/// @notice Unit tests of `DefenseExecutor` with mock CCTP, Uniswap and Chainlink.
contract DefenseExecutorTest is Test {
    uint32 internal constant ARC = 26;
    uint256 internal constant USDC = 1e6;
    uint256 internal constant MAX_FEE = 0.03e6;

    MockToken internal usdc;
    MockToken internal weth;
    FeedMock internal feed;
    SwapRouterMock internal router;
    MockTokenMessenger internal messenger;
    DefenseExecutor internal executor;

    address internal transmitter = makeAddr("transmitter");
    address internal alarm = makeAddr("alarm");
    address internal owner = makeAddr("owner");
    address internal account = makeAddr("account");

    function setUp() public {
        vm.warp(1_795_000_000);
        usdc = new MockToken(6);
        weth = new MockToken(18);
        feed = new FeedMock(8, 1777e8);
        router = new SwapRouterMock(usdc, 1777e6);
        messenger = new MockTokenMessenger();
        DefenseExecutor.SwapAssetConfig[] memory assets = new DefenseExecutor.SwapAssetConfig[](1);
        assets[0] = DefenseExecutor.SwapAssetConfig(address(weth), IAggregatorV3(address(feed)), 500);
        executor = new DefenseExecutor(
            DefenseExecutor.Config({
                messageTransmitter: transmitter,
                tokenMessenger: ITokenMessengerV2(address(messenger)),
                alarm: alarm,
                arcDomain: ARC,
                usdc: IERC20(address(usdc)),
                swapRouter: ISwapRouter02(address(router)),
                burnFinality: 1000,
                maxPriceAge: 1 hours,
                minDefenseInterval: 15 minutes
            }),
            assets
        );
    }

    // ----- Message checks -----

    function test_handler_rejectsWrongCaller() public {
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.NotMessageTransmitter.selector, address(this)));
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, _alarm(1 * USDC, 1));
    }

    function test_handler_rejectsWrongDomainOrSender() public {
        vm.startPrank(transmitter);
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.UnexpectedSender.selector, uint32(0), _sender(alarm)));
        executor.handleReceiveFinalizedMessage(0, _sender(alarm), 2000, _alarm(1 * USDC, 1));
        bytes32 impostor = _sender(makeAddr("impostor"));
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.UnexpectedSender.selector, ARC, impostor));
        executor.handleReceiveFinalizedMessage(ARC, impostor, 2000, _alarm(1 * USDC, 1));
        vm.stopPrank();
    }

    function test_handler_rejectsUnfinalizedMessages() public {
        vm.startPrank(transmitter);
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.UnfinalizedMessage.selector, uint32(1000)));
        executor.handleReceiveUnfinalizedMessage(ARC, _sender(alarm), 1000, _alarm(1 * USDC, 1));
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.UnfinalizedMessage.selector, uint32(1000)));
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 1000, _alarm(1 * USDC, 1));
        vm.stopPrank();
    }

    function test_handler_rejectsMalformedBody() public {
        vm.expectRevert(bytes("bad defense message"));
        vm.prank(transmitter);
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, hex"1234");
    }

    function test_handler_rejectsReplayedAlarm() public {
        _policyUsdcOnly(10 * USDC);
        _fund(usdc, 10 * USDC);
        _deliver(_alarm(1 * USDC, 7));
        bytes memory body = _alarm(1 * USDC, 7);
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.AlarmAlreadyUsed.selector, uint64(7)));
        vm.prank(transmitter);
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, body);
    }

    function test_handler_consumesExpiredAlarmWithoutMovingFunds() public {
        _policyUsdcOnly(10 * USDC);
        _fund(usdc, 10 * USDC);
        bytes memory body = _alarm(1 * USDC, 1);
        skip(1 hours + 1);
        vm.expectEmit(address(executor));
        emit DefenseExecutor.AlarmIgnored(owner, 1, DefenseExecutor.IgnoreReason.Expired);
        _deliver(body);
        assertTrue(executor.alarmUsed(1));
        assertEq(usdc.balanceOf(owner), 10 * USDC);
        assertEq(messenger.burnCount(), 0);
    }

    function test_handler_ignoresOwnerWithoutPolicy() public {
        _fund(usdc, 10 * USDC);
        vm.expectEmit(address(executor));
        emit DefenseExecutor.AlarmIgnored(owner, 1, DefenseExecutor.IgnoreReason.NoPolicy);
        _deliver(_alarm(1 * USDC, 1));
        assertEq(usdc.balanceOf(owner), 10 * USDC);
    }

    // ----- Defense -----

    function test_defense_usdcBurnedToAccountOnArc() public {
        _policyUsdcOnly(10 * USDC);
        _fund(usdc, 10 * USDC);

        vm.expectEmit(address(executor));
        emit DefenseExecutor.DefenseExecuted(owner, account, 1, 1 * USDC + MAX_FEE, MAX_FEE);
        _deliver(_alarm(1 * USDC, 1));

        (
            uint256 amount,
            uint32 domain,
            bytes32 recipient,
            address burnToken,
            bytes32 caller,
            uint256 maxFee,
            uint32 finality,
            bytes memory hook
        ) = messenger.last();
        assertEq(amount, 1 * USDC + MAX_FEE);
        assertEq(domain, ARC);
        assertEq(recipient, bytes32(uint256(uint160(account))));
        assertEq(burnToken, address(usdc));
        assertEq(caller, bytes32(0));
        assertEq(maxFee, MAX_FEE);
        assertEq(finality, 1000);
        assertEq(hook, abi.encodePacked(bytes32("cctp-forward")));
        assertEq(usdc.balanceOf(owner), 10 * USDC - amount);
        assertEq(usdc.balanceOf(address(executor)), 0);
        assertEq(executor.remainingCap(owner, address(usdc)), 10 * USDC - amount);
    }

    function test_defense_usesWethAfterUsdcInPolicyOrder() public {
        _policyUsdcThenWeth(0.5e6, 1e18, 100);
        _fund(usdc, 10 * USDC);
        _fund(weth, 1e18);

        _deliver(_alarm(2 * USDC, 1));

        // 0.5 USDC from the USDC cap, the remaining 1.53 USDC bought with WETH.
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 2 * USDC + MAX_FEE);
        assertEq(usdc.balanceOf(owner), 9.5e6);
        uint256 wethUsed = 1e18 - weth.balanceOf(owner);
        // 1.53 USDC at 1777 USDC/WETH: about 0.000861 WETH, the unused allowance went back.
        assertApproxEqAbs(wethUsed, uint256(1.53e6) * 1e18 / 1777e6, 1e12);
        assertEq(weth.balanceOf(address(executor)), 0);
        assertEq(weth.allowance(address(executor), address(router)), 0);
        assertEq(executor.remainingCap(owner, address(weth)), 1e18 - wethUsed);
    }

    function test_defense_capsResetAfterPeriod() public {
        _policyUsdcOnly(1.5e6);
        _fund(usdc, 10 * USDC);
        _deliver(_alarm(1 * USDC, 1)); // takes 1.03
        skip(15 minutes); // the minimum interval between two burns
        _deliver(_alarm(1 * USDC, 2)); // only 0.47 left under the cap
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 0.47e6);
        assertEq(executor.remainingCap(owner, address(usdc)), 0);

        skip(1 days);
        assertEq(executor.remainingCap(owner, address(usdc)), 1.5e6);
        _deliver(_alarm(1 * USDC, 3));
        (amount,,,,,,,) = messenger.last();
        assertEq(amount, 1.03e6);
    }

    function test_defense_swapWorseThanSlippageIsSkippedAndRefunded() public {
        _policyUsdcThenWeth(0, 1e18, 100); // 1% max slippage, no USDC allowed
        _fund(weth, 1e18);
        router.setQuirks(200, false); // the pool pays 2% under the oracle

        vm.expectEmit(address(executor));
        emit DefenseExecutor.AlarmIgnored(owner, 1, DefenseExecutor.IgnoreReason.NotEnoughFunds);
        _deliver(_alarm(1 * USDC, 1));
        assertEq(weth.balanceOf(owner), 1e18);
        assertEq(executor.remainingCap(owner, address(weth)), 1e18);
        assertEq(messenger.burnCount(), 0);
    }

    function test_defense_partialWethUsesMinOut() public {
        // Only 0.0005 WETH (about 0.89 USDC) is allowed: exact-input swap with an oracle minimum.
        _policyUsdcThenWeth(0, 0.0005e18, 100);
        _fund(weth, 1e18);
        router.setQuirks(50, false); // 0.5% under the oracle, within 1%
        _deliver(_alarm(1 * USDC, 1));
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, uint256(0.0005e18) * 1777e6 * 9950 / (1e18 * 10_000));
        assertEq(weth.balanceOf(owner), 1e18 - 0.0005e18);
    }

    function test_defense_brokenRouterFallsBackAndRefunds() public {
        _policyUsdcThenWeth(0.5e6, 1e18, 100);
        _fund(usdc, 10 * USDC);
        _fund(weth, 1e18);
        router.setQuirks(0, true);
        _deliver(_alarm(2 * USDC, 1));
        // Only the 0.5 USDC cap is burned; the WETH is untouched.
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 0.5e6);
        assertEq(weth.balanceOf(owner), 1e18);
    }

    function test_defense_stalePriceRevertsSoTheMessageCanBeRetried() public {
        _policyUsdcThenWeth(0, 1e18, 100);
        _fund(weth, 1e18);
        feed.set(1777e8, block.timestamp - 2 hours);
        bytes memory body = _alarm(1 * USDC, 1);
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.StalePrice.selector, address(feed)));
        vm.prank(transmitter);
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, body);
        assertFalse(executor.alarmUsed(1));
    }

    function test_defense_fundsBelowFeeAreReturned() public {
        _policyUsdcOnly(0.02e6); // less than the 0.03 fee
        _fund(usdc, 10 * USDC);
        _deliver(_alarm(1 * USDC, 1));
        assertEq(usdc.balanceOf(owner), 10 * USDC);
        assertEq(usdc.balanceOf(address(executor)), 0);
        assertEq(messenger.burnCount(), 0);
    }

    function test_defense_respectsAllowanceAndBalance() public {
        _policyUsdcOnly(10 * USDC);
        usdc.mint(owner, 10 * USDC);
        vm.prank(owner);
        usdc.approve(address(executor), 0.6e6);
        _deliver(_alarm(1 * USDC, 1));
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 0.6e6);
    }

    function test_constructor_boundsTheDefenseInterval() public {
        DefenseExecutor.SwapAssetConfig[] memory none = new DefenseExecutor.SwapAssetConfig[](0);
        DefenseExecutor.Config memory c = DefenseExecutor.Config({
            messageTransmitter: transmitter,
            tokenMessenger: ITokenMessengerV2(address(messenger)),
            alarm: alarm,
            arcDomain: ARC,
            usdc: IERC20(address(usdc)),
            swapRouter: ISwapRouter02(address(router)),
            burnFinality: 1000,
            maxPriceAge: 1 hours,
            minDefenseInterval: 0
        });
        vm.expectRevert(DefenseExecutor.InvalidConfig.selector);
        new DefenseExecutor(c, none);
        c.minDefenseInterval = 1 days + 1;
        vm.expectRevert(DefenseExecutor.InvalidConfig.selector);
        new DefenseExecutor(c, none);
    }

    function test_defense_revertsAlarmWithinMinIntervalOfLastBurn() public {
        DefenseExecutor.SwapAssetConfig[] memory assets = new DefenseExecutor.SwapAssetConfig[](0);
        executor = new DefenseExecutor(
            DefenseExecutor.Config({
                messageTransmitter: transmitter,
                tokenMessenger: ITokenMessengerV2(address(messenger)),
                alarm: alarm,
                arcDomain: ARC,
                usdc: IERC20(address(usdc)),
                swapRouter: ISwapRouter02(address(router)),
                burnFinality: 1000,
                maxPriceAge: 1 hours,
                minDefenseInterval: 1 hours
            }),
            assets
        );
        _policyUsdcOnly(10 * USDC);
        _fund(usdc, 10 * USDC);
        _deliver(_alarm(1 * USDC, 1));
        assertEq(executor.lastDefenseAt(owner), vm.getBlockTimestamp());

        // The first defense's funds may still be on their way to Arc: a second alarm reverts, so
        // it can be relayed again once the interval is over, as long as it has not expired.
        skip(30 minutes);
        bytes memory second = _alarm(1 * USDC, 2);
        uint256 nextAllowed = executor.lastDefenseAt(owner) + 1 hours;
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.TooSoon.selector, owner, nextAllowed));
        vm.prank(transmitter);
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, second);
        assertFalse(executor.alarmUsed(2));
        assertEq(usdc.balanceOf(owner), 10 * USDC - 1.03e6);

        skip(30 minutes);
        _deliver(second);
        assertEq(messenger.burnCount(), 2);
    }

    // ----- Policy -----

    function test_setPolicy_validates() public {
        address[] memory assets = new address[](2);
        uint256[] memory caps = new uint256[](2);
        assets[0] = address(usdc);
        assets[1] = address(usdc);
        vm.startPrank(owner);
        vm.expectRevert(DefenseExecutor.InvalidPolicy.selector); // duplicate
        executor.setPolicy(assets, caps, 1 days, 100, MAX_FEE);
        assets[1] = makeAddr("unsupported");
        vm.expectRevert(DefenseExecutor.InvalidPolicy.selector);
        executor.setPolicy(assets, caps, 1 days, 100, MAX_FEE);
        assets[1] = address(weth);
        vm.expectRevert(DefenseExecutor.InvalidPolicy.selector); // slippage over 10%
        executor.setPolicy(assets, caps, 1 days, 1_001, MAX_FEE);
        vm.expectRevert(DefenseExecutor.InvalidPolicy.selector); // zero period
        executor.setPolicy(assets, caps, 0, 100, MAX_FEE);
        executor.setPolicy(assets, caps, 1 days, 100, MAX_FEE);
        assertEq(executor.policyOf(owner).assets.length, 2);
        executor.clearPolicy();
        assertEq(executor.policyOf(owner).assets.length, 0);
        vm.stopPrank();
    }

    // ----- helpers -----

    function _alarm(uint256 amount, uint64 nonce) internal view returns (bytes memory) {
        // vm.getBlockTimestamp: under via_ir, block.timestamp may be cached across a skip().
        return abi.encode(owner, account, amount, nonce, uint64(vm.getBlockTimestamp() + 1 hours));
    }

    function _deliver(bytes memory body) internal {
        vm.prank(transmitter);
        assertTrue(executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, body));
    }

    function _sender(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _fund(MockToken token, uint256 amount) internal {
        token.mint(owner, amount);
        vm.prank(owner);
        token.approve(address(executor), type(uint256).max);
    }

    function _policyUsdcOnly(uint256 cap) internal {
        address[] memory assets = new address[](1);
        uint256[] memory caps = new uint256[](1);
        assets[0] = address(usdc);
        caps[0] = cap;
        vm.prank(owner);
        executor.setPolicy(assets, caps, 1 days, 100, MAX_FEE);
    }

    function _policyUsdcThenWeth(uint256 usdcCap, uint256 wethCap, uint16 slippage) internal {
        address[] memory assets = new address[](2);
        uint256[] memory caps = new uint256[](2);
        assets[0] = address(usdc);
        assets[1] = address(weth);
        caps[0] = usdcCap;
        caps[1] = wethCap;
        vm.prank(owner);
        executor.setPolicy(assets, caps, 1 days, slippage, MAX_FEE);
    }
}
