// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {IMessageHandlerV2, IMessageTransmitterV2} from "../../src/cctp/IMessageTransmitterV2.sol";
import {ITokenMessengerV2} from "../../src/cctp/ITokenMessengerV2.sol";
import {DefenseAlarm} from "../../src/defense/DefenseAlarm.sol";
import {IDefenseAlarm} from "../../src/defense/interfaces/IDefenseAlarm.sol";
import {DefenseExecutor, IAggregatorV3, ISwapRouter02} from "../../src/defense/DefenseExecutor.sol";
import {MarginGuard} from "../../src/guard/MarginGuard.sol";
import {IArdoiseFactory} from "../../src/interfaces/IArdoiseFactory.sol";
import {IVenue} from "../../src/interfaces/IVenue.sol";
import {MockVenue} from "../guard/MockVenue.sol";
import {MockTokenMessenger} from "../mocks/ArdoiseMocks.sol";
import {MockToken} from "../venues/mocks/MockAaveV4.sol";
import {DefenseFactoryMock, FeedMock, SwapRouterMock} from "./DefenseMocks.sol";

/// @notice CCTP V2 MessageTransmitter stand-in for both chains: `sendMessage` records what a
/// contract sends, as the real transmitter does in `MessageSent`, and `relay` delivers it to the
/// recipient exactly as `receiveMessage` would after Circle's attestation, with the source domain
/// and the sender taken from the send, not from the relayer.
contract CctpBridgeMock {
    struct Message {
        bytes32 sender;
        uint32 destinationDomain;
        bytes32 recipient;
        uint32 minFinalityThreshold;
        bytes body;
    }

    /// @notice CCTP domain the recorded messages come from (Arc: 26).
    uint32 public immutable sourceDomain;
    /// @notice Every message sent, in order.
    Message[] public messages;

    constructor(uint32 sourceDomain_) {
        sourceDomain = sourceDomain_;
    }

    /// @notice Records a message from `msg.sender`.
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external {
        messages.push(
            Message(
                bytes32(uint256(uint160(msg.sender))), destinationDomain, recipient, minFinalityThreshold, messageBody
            )
        );
    }

    /// @notice Number of messages sent.
    function count() external view returns (uint256) {
        return messages.length;
    }

    /// @notice Delivers message `index` to its recipient, as the destination transmitter would.
    /// @dev Passes the requested finality as the executed one; Circle may attest higher, which
    /// does not matter for the alarm (2000 requested, 2000 attested). Used nonces are not tracked,
    /// so a reverted delivery can be retried, as on mainnet.
    function relay(uint256 index) external returns (bool) {
        Message storage m = messages[index];
        IMessageHandlerV2 recipient = IMessageHandlerV2(address(uint160(uint256(m.recipient))));
        if (m.minFinalityThreshold >= 2000) {
            return recipient.handleReceiveFinalizedMessage(sourceDomain, m.sender, m.minFinalityThreshold, m.body);
        }
        return recipient.handleReceiveUnfinalizedMessage(sourceDomain, m.sender, m.minFinalityThreshold, m.body);
    }
}

/// @notice End to end on one test chain, with a production alarm (venues' real health factors) and
/// a real fall of the collateral: the message `DefenseAlarm.raise` sends is delivered as is
/// to `DefenseExecutor.handleReceiveFinalizedMessage` (same encoding, sender = the alarm, domain
/// 26), and the executor burns to the account the alarm named, enough to restore the target health
/// factor once minted and swept. Each side's unit tests use their own mocks; this one checks that
/// they agree.
contract DefenseEndToEndTest is Test {
    uint32 internal constant ARC = 26;
    uint32 internal constant BASE = 6;
    uint256 internal constant MAX_FEE = 0.03e6;

    // Arc side.
    CctpBridgeMock internal bridge;
    DefenseFactoryMock internal factory;
    MarginGuard internal guard;
    MockVenue internal venue;
    MockToken internal usdcArc;
    DefenseAlarm internal alarm;

    // Base side.
    MockToken internal usdcBase;
    MockToken internal weth;
    FeedMock internal feed;
    SwapRouterMock internal router;
    MockTokenMessenger internal messenger;
    DefenseExecutor internal executor;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal account = makeAddr("account");

    function setUp() public {
        vm.warp(1_795_000_000);
        bridge = new CctpBridgeMock(ARC);

        factory = new DefenseFactoryMock();
        guard = new MarginGuard(admin, 1.25e18, 1.5e18);
        venue = new MockVenue(0.78e18);
        usdcArc = new MockToken(6);
        venue.setAsset(address(usdcArc));
        IVenue[] memory list = new IVenue[](1);
        list[0] = venue;
        factory.setVenues(list);
        factory.setGuard(guard);
        factory.setAccount(owner, account);
        venue.setPosition(owner, 4e18, 2e6); // health factor 1.56
        vm.prank(admin);
        alarm = new DefenseAlarm(
            IArdoiseFactory(address(factory)), IMessageTransmitterV2(address(bridge)), BASE, 1800, 900, false
        );

        usdcBase = new MockToken(6);
        weth = new MockToken(18);
        feed = new FeedMock(8, 1777e8);
        router = new SwapRouterMock(usdcBase, 1777e6);
        messenger = new MockTokenMessenger();
        DefenseExecutor.SwapAssetConfig[] memory assets = new DefenseExecutor.SwapAssetConfig[](1);
        assets[0] = DefenseExecutor.SwapAssetConfig(address(weth), IAggregatorV3(address(feed)), 500);
        executor = new DefenseExecutor(
            DefenseExecutor.Config({
                messageTransmitter: address(bridge),
                tokenMessenger: ITokenMessengerV2(address(messenger)),
                alarm: address(alarm),
                arcDomain: ARC,
                usdc: IERC20(address(usdcBase)),
                swapRouter: ISwapRouter02(address(router)),
                burnFinality: 1000,
                maxPriceAge: 1 hours,
                minDefenseInterval: 2400
            }),
            assets
        );
        vm.prank(admin);
        alarm.setExecutor(address(executor));

        // The owner's policy on Base: a little USDC, then WETH.
        address[] memory policyAssets = new address[](2);
        uint256[] memory caps = new uint256[](2);
        policyAssets[0] = address(usdcBase);
        policyAssets[1] = address(weth);
        caps[0] = 0.2e6;
        caps[1] = 0.01e18;
        usdcBase.mint(owner, 1e6);
        weth.mint(owner, 0.01e18);
        vm.startPrank(owner);
        executor.setPolicy(policyAssets, caps, 1 days, 100, MAX_FEE);
        usdcBase.approve(address(executor), type(uint256).max);
        weth.approve(address(executor), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev The collateral loses 30% of its value: health factor 1.56 -> 1.092, under 1.25.
    function _collateralFalls() internal {
        venue.movePrice(owner, 0.7e18);
    }

    function test_raiseIsDeliveredAsIsAndBurnsToTheAccount() public {
        _collateralFalls();
        (, uint256 amountNeeded) = alarm.shortfall(owner);
        assertEq(amountNeeded, 544_000);

        vm.prank(makeAddr("anyone"));
        uint64 nonce = alarm.raise(owner);

        // What the alarm sent: from the alarm, to the executor on Base, finalized, and byte for byte
        // the documented body, expiry included.
        (bytes32 sender, uint32 domain, bytes32 recipient, uint32 finality, bytes memory body) = bridge.messages(0);
        assertEq(body, abi.encode(owner, account, amountNeeded, nonce, uint64(vm.getBlockTimestamp() + 900)));
        assertEq(sender, bytes32(uint256(uint160(address(alarm)))));
        assertEq(domain, BASE);
        assertEq(recipient, bytes32(uint256(uint160(address(executor)))));
        assertEq(finality, 2000);

        vm.expectEmit(address(executor));
        emit DefenseExecutor.DefenseExecuted(owner, account, nonce, amountNeeded + MAX_FEE, MAX_FEE);
        vm.prank(makeAddr("relayer"));
        assertTrue(bridge.relay(0));

        // The burn goes to the account the alarm named, for what it asked plus the fee.
        (
            uint256 burned,
            uint32 burnDomain,
            bytes32 mintRecipient,
            address burnToken,,
            uint256 maxFee,
            uint32 burnFinality,
            bytes memory hookData
        ) = messenger.last();
        assertEq(burnDomain, ARC);
        assertEq(mintRecipient, bytes32(uint256(uint160(account))));
        assertEq(burnToken, address(usdcBase));
        assertEq(burned, amountNeeded + MAX_FEE);
        assertEq(maxFee, MAX_FEE);
        assertEq(burnFinality, 1000);
        assertEq(hookData, abi.encodePacked(bytes32("cctp-forward")));
        assertTrue(executor.alarmUsed(nonce));
        // 0.2 USDC from the USDC cap, the rest bought with WETH.
        assertEq(usdcBase.balanceOf(owner), 0.8e6);
        // 0.374 USDC bought with WETH at 1777 USDC/WETH (the mock's exact-output rounding is up).
        uint256 usdcFromWeth = amountNeeded + MAX_FEE - 0.2e6;
        uint256 wethSpent = (usdcFromWeth * 1e18 + 1777e6 - 1) / 1777e6;
        assertEq(weth.balanceOf(owner), 0.01e18 - wethSpent);

        // Once minted on Arc (at worst `burned - maxFee`) and swept, the target is reached.
        uint256 minted = burned - maxFee;
        venue.setPosition(owner, 2.8e18, 2e6 - minted);
        (uint256 healthFactor,,) = venue.health(owner);
        assertApproxEqAbs(healthFactor, 1.5e18, 10);
    }

    // On mainnet the transmitter itself rejects a second `receiveMessage` of the same message
    // ("Nonce already used") before the executor runs; this checks the executor's own backstop.
    function test_replayedDeliveryIsRefused() public {
        _collateralFalls();
        uint64 nonce = alarm.raise(owner);
        bridge.relay(0);
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.AlarmAlreadyUsed.selector, nonce));
        bridge.relay(0);
    }

    // A relayer who moves the pool and delivers in one transaction must not cancel the defense.
    function test_deliveryWithThePoolOffTheOracleRevertsAndCanBeRetried() public {
        vm.prank(admin);
        guard.setSimulatedDrop(3_000);
        (, uint256 amountNeeded) = alarm.shortfall(owner);
        uint256 raisedAt = vm.getBlockTimestamp();
        uint64 nonce = alarm.raise(owner);

        // The owner allows 1% of slippage; the pool pays 1.5% under the oracle at delivery.
        router.setQuirks(150, false);
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.SwapFailed.selector, address(weth)));
        vm.prank(makeAddr("attacker"));
        bridge.relay(0);
        assertFalse(executor.alarmUsed(nonce));
        assertEq(executor.lastDefenseAt(owner), 0);
        assertEq(usdcBase.balanceOf(owner), 1e6);
        assertEq(weth.balanceOf(owner), 0.01e18);
        assertEq(executor.remainingCap(owner, address(usdcBase)), 0.2e6);
        assertEq(executor.remainingCap(owner, address(weth)), 0.01e18);
        assertEq(messenger.burnCount(), 0);

        // No second alarm is needed, and none could be raised before the cooldown anyway.
        vm.expectRevert(abi.encodeWithSelector(IDefenseAlarm.CoolingDown.selector, uint64(raisedAt + 1800)));
        alarm.raise(owner);

        // Later in the alarm's validity the pool is back at the oracle: the same message runs.
        skip(600);
        router.setQuirks(0, false);
        vm.expectEmit(address(executor));
        emit DefenseExecutor.DefenseExecuted(owner, account, nonce, amountNeeded + MAX_FEE, MAX_FEE);
        assertTrue(bridge.relay(0));
        assertTrue(executor.alarmUsed(nonce));
        assertEq(messenger.burnCount(), 1);

        // And only once.
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.AlarmAlreadyUsed.selector, nonce));
        bridge.relay(0);
        assertEq(messenger.burnCount(), 1);
    }

    function test_sameBodyFromAnotherSenderIsRefused() public {
        _collateralFalls();
        alarm.raise(owner);
        (,,,, bytes memory body) = bridge.messages(0);

        // An impostor sends the alarm's exact body through the real messaging path.
        address impostor = makeAddr("impostor");
        vm.prank(impostor);
        bridge.sendMessage(BASE, bytes32(uint256(uint160(address(executor)))), bytes32(0), 2000, body);
        vm.expectRevert(
            abi.encodeWithSelector(DefenseExecutor.UnexpectedSender.selector, ARC, bytes32(uint256(uint160(impostor))))
        );
        bridge.relay(1);
        assertEq(messenger.burnCount(), 0);
        // The genuine alarm still goes through, exactly once.
        assertTrue(bridge.relay(0));
        assertEq(messenger.burnCount(), 1);
    }

    function test_secondAlarmAfterCooldownWaitsForTheInterval() public {
        _collateralFalls();
        alarm.raise(owner);
        bridge.relay(0);
        uint256 firstBurn = vm.getBlockTimestamp();

        // The minted USDC has not reached the account yet: after the cooldown, the shortfall is
        // unchanged and a second alarm goes out, but the executor refuses it until the interval
        // since the first burn is over, then accepts it while the alarm is still valid.
        skip(1800);
        alarm.raise(owner);
        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.TooSoon.selector, owner, firstBurn + 2400));
        bridge.relay(1);
        skip(600);
        assertTrue(bridge.relay(1));
        assertEq(messenger.burnCount(), 2);
    }
}
