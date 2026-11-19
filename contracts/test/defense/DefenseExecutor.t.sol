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

    function test_defense_swapWorseThanSlippageRevertsSoTheAlarmIsNotConsumed() public {
        _policyUsdcThenWeth(0, 1e18, 100); // 1% max slippage, no USDC allowed
        _fund(weth, 1e18);
        router.setQuirks(200, false); // the pool pays 2% under the oracle
        bytes memory body = _alarm(1 * USDC, 1);

        _expectSwapFailed(body);
        assertFalse(executor.alarmUsed(1));
        assertEq(weth.balanceOf(owner), 1e18);
        assertEq(executor.remainingCap(owner, address(weth)), 1e18);
        assertEq(executor.lastDefenseAt(owner), 0);
        assertEq(messenger.burnCount(), 0);

        // Once the pool is back within the bound, the same alarm runs, exactly once.
        router.setQuirks(50, false);
        _deliver(body);
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 1 * USDC + MAX_FEE);
        assertTrue(executor.alarmUsed(1));
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.AlarmAlreadyUsed.selector, uint64(1)));
        vm.prank(transmitter);
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, body);
        assertEq(messenger.burnCount(), 1);
    }

    function test_defense_partialSwapWorseThanSlippageAlsoReverts() public {
        _policyUsdcThenWeth(0, 0.0005e18, 100); // exact-input path
        _fund(weth, 1e18);
        router.setQuirks(200, false);
        bytes memory body = _alarm(1 * USDC, 1);
        _expectSwapFailed(body);
        assertFalse(executor.alarmUsed(1));
        assertEq(executor.remainingCap(owner, address(weth)), 0.0005e18);
    }

    function test_defense_failedSwapAlsoHoldsBackTheUsdcPart() public {
        _policyUsdcThenWeth(0.5e6, 1e18, 100);
        _fund(usdc, 10 * USDC);
        _fund(weth, 1e18);
        router.setQuirks(200, false);
        bytes memory body = _alarm(2 * USDC, 1);

        // The USDC cap covers 0.5 of the 2.03 needed and the WETH swap fails on price: nothing is
        // delivered, so that the alarm cannot be consumed with only its USDC part.
        _expectSwapFailed(body);
        assertFalse(executor.alarmUsed(1));
        assertEq(usdc.balanceOf(owner), 10 * USDC);
        assertEq(weth.balanceOf(owner), 1e18);
        assertEq(executor.remainingCap(owner, address(usdc)), 0.5e6);
        assertEq(executor.remainingCap(owner, address(weth)), 1e18);
        assertEq(executor.lastDefenseAt(owner), 0);
        assertEq(messenger.burnCount(), 0);

        // With the price back, one delivery takes both parts, for what the alarm asks and no more.
        router.setQuirks(0, false);
        _deliver(body);
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 2 * USDC + MAX_FEE);
        assertEq(usdc.balanceOf(owner), 9.5e6);
        assertEq(messenger.burnCount(), 1);
    }

    function test_defense_swapNotNeededIsNotAttempted() public {
        _policyUsdcThenWeth(5 * USDC, 1e18, 100);
        _fund(usdc, 10 * USDC);
        _fund(weth, 1e18);
        router.setQuirks(0, true); // the USDC covers the alarm: the broken swap is never reached
        _deliver(_alarm(2 * USDC, 1));
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 2 * USDC + MAX_FEE);
        assertEq(weth.balanceOf(owner), 1e18);
    }

    function test_defense_revokedSwapAssetIsSkippedNotReverted() public {
        _policyUsdcThenWeth(0.5e6, 1e18, 100);
        _fund(usdc, 10 * USDC);
        weth.mint(owner, 1e18); // in the policy, but no allowance: nothing to sell
        router.setQuirks(0, true);
        _deliver(_alarm(2 * USDC, 1));
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 0.5e6);
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

    function test_defense_alwaysFailingSwapLetsTheAlarmExpire() public {
        _policyUsdcThenWeth(0.5e6, 1e18, 100);
        _fund(usdc, 10 * USDC);
        _fund(weth, 1e18);
        router.setQuirks(0, true);
        bytes memory body = _alarm(2 * USDC, 1); // valid for 1 hour

        // Every delivery reverts while the alarm is valid, without using caps or the interval.
        _expectSwapFailed(body);
        skip(30 minutes);
        _expectSwapFailed(body);
        assertFalse(executor.alarmUsed(1));
        assertEq(usdc.balanceOf(owner), 10 * USDC);
        assertEq(executor.remainingCap(owner, address(usdc)), 0.5e6);
        assertEq(executor.lastDefenseAt(owner), 0);

        // Past its expiry it is consumed like any expired alarm, and nothing stays stuck.
        skip(30 minutes + 1);
        vm.expectEmit(address(executor));
        emit DefenseExecutor.AlarmIgnored(owner, 1, DefenseExecutor.IgnoreReason.Expired);
        _deliver(body);
        assertTrue(executor.alarmUsed(1));
        assertEq(messenger.burnCount(), 0);

        // The owner can still be defended with USDC alone by taking the asset out of the policy.
        _policyUsdcOnly(0.5e6);
        _deliver(_alarm(2 * USDC, 2));
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 0.5e6);
    }

    function test_defense_swapOutOfGasRevertsSoTheAlarmIsNotConsumed() public {
        _policyUsdcThenWeth(0, 1e18, 100);
        _fund(weth, 1e18);
        router.setHungry(true); // the swap uses all the gas it gets, as with a tight relay
        bytes memory body = _alarm(1 * USDC, 1);
        vm.prank(transmitter);
        vm.expectRevert(DefenseExecutor.SwapOutOfGas.selector);
        executor.handleReceiveFinalizedMessage{gas: 1_000_000}(ARC, _sender(alarm), 2000, body);

        // Nothing was consumed: once relayed with a working swap, the same alarm runs.
        assertFalse(executor.alarmUsed(1));
        router.setHungry(false);
        _deliver(body);
        assertEq(messenger.burnCount(), 1);
    }

    function test_defense_partialSwapOutOfGasAlsoReverts() public {
        _policyUsdcThenWeth(0, 0.0005e18, 100); // exact-input path
        _fund(weth, 1e18);
        router.setHungry(true);
        bytes memory body = _alarm(1 * USDC, 1);
        vm.prank(transmitter);
        vm.expectRevert(DefenseExecutor.SwapOutOfGas.selector);
        executor.handleReceiveFinalizedMessage{gas: 1_000_000}(ARC, _sender(alarm), 2000, body);
        assertFalse(executor.alarmUsed(1));
    }

    function test_defense_tooLittleGasBeforeSwapReverts() public {
        _policyUsdcThenWeth(0, 1e18, 100);
        _fund(weth, 1e18);
        router.setQuirks(0, true); // the gas floor comes first: the swap is not even tried
        bytes memory body = _alarm(1 * USDC, 1);
        vm.prank(transmitter);
        vm.expectRevert(DefenseExecutor.SwapOutOfGas.selector);
        // Enough for the checks and the pull, under the floor once the swap is reached.
        executor.handleReceiveFinalizedMessage{gas: 250_000}(ARC, _sender(alarm), 2000, body);
        assertFalse(executor.alarmUsed(1));
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
        // Both bounds themselves are accepted.
        c.minDefenseInterval = 15 minutes;
        assertEq(new DefenseExecutor(c, none).minDefenseInterval(), 15 minutes);
        c.minDefenseInterval = 1 days;
        assertEq(new DefenseExecutor(c, none).minDefenseInterval(), 1 days);
    }

    function test_defense_tooSoonAlarmIsConsumedOnceExpired() public {
        _policyUsdcOnly(10 * USDC);
        _fund(usdc, 10 * USDC);
        _deliver(_alarm(1 * USDC, 1));
        bytes memory second = _alarm(1 * USDC, 2); // valid for 1 hour, interval 15 minutes
        skip(5 minutes);
        vm.expectRevert(
            abi.encodeWithSelector(DefenseExecutor.TooSoon.selector, owner, executor.lastDefenseAt(owner) + 15 minutes)
        );
        vm.prank(transmitter);
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, second);
        // Relayed again after its expiry, it is consumed instead of staying stuck.
        skip(1 hours);
        vm.expectEmit(address(executor));
        emit DefenseExecutor.AlarmIgnored(owner, 2, DefenseExecutor.IgnoreReason.Expired);
        _deliver(second);
        assertTrue(executor.alarmUsed(2));
        assertEq(messenger.burnCount(), 1);
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

    function _expectSwapFailed(bytes memory body) internal {
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.SwapFailed.selector, address(weth)));
        vm.prank(transmitter);
        executor.handleReceiveFinalizedMessage(ARC, _sender(alarm), 2000, body);
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
