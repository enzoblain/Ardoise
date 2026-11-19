// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ITokenMessengerV2} from "../../src/cctp/ITokenMessengerV2.sol";
import {DefenseExecutor, IAggregatorV3, ISwapRouter02} from "../../src/defense/DefenseExecutor.sol";

/// @notice The swap and burn leg of `DefenseExecutor` on a Base mainnet fork, against the real
/// Uniswap V3 router, WETH, Chainlink ETH/USD feed, USDC and CCTP TokenMessengerV2. Skipped when
/// `BASE_RPC_URL` is not set.
contract DefenseExecutorForkTest is Test {
    address internal constant MESSAGE_TRANSMITTER = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64;
    address internal constant TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant ETH_USD_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;

    DefenseExecutor internal executor;
    address internal alarm = makeAddr("alarm");
    address internal owner = makeAddr("owner");
    address internal account = makeAddr("account");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        DefenseExecutor.SwapAssetConfig[] memory assets = new DefenseExecutor.SwapAssetConfig[](1);
        assets[0] = DefenseExecutor.SwapAssetConfig(WETH, IAggregatorV3(ETH_USD_FEED), 500);
        executor = new DefenseExecutor(
            DefenseExecutor.Config({
                messageTransmitter: MESSAGE_TRANSMITTER,
                tokenMessenger: ITokenMessengerV2(TOKEN_MESSENGER),
                alarm: alarm,
                arcDomain: 26,
                usdc: IERC20(USDC),
                swapRouter: ISwapRouter02(SWAP_ROUTER),
                burnFinality: 1000,
                maxPriceAge: 1 days,
                minDefenseInterval: 1 hours
            }),
            assets
        );
    }

    function test_fork_swapsWethAndBurnsToArc() public {
        vm.skip(address(executor) == address(0));
        deal(WETH, owner, 0.01e18);
        address[] memory policyAssets = new address[](2);
        uint256[] memory caps = new uint256[](2);
        policyAssets[0] = USDC;
        policyAssets[1] = WETH;
        caps[0] = 10e6;
        caps[1] = 0.01e18;
        vm.startPrank(owner);
        executor.setPolicy(policyAssets, caps, 1 days, 100, 0.03e6);
        IERC20(WETH).approve(address(executor), type(uint256).max);
        vm.stopPrank();

        bytes memory body =
            abi.encode(owner, account, uint256(1e6), uint64(1), uint64(vm.getBlockTimestamp() + 1 hours));
        vm.recordLogs();
        vm.prank(MESSAGE_TRANSMITTER);
        assertTrue(executor.handleReceiveFinalizedMessage(26, bytes32(uint256(uint160(alarm))), 2000, body));

        // 1.03 USDC was bought with WETH and burned: nothing stays in the executor.
        assertEq(IERC20(USDC).balanceOf(address(executor)), 0);
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0);
        assertLt(IERC20(WETH).balanceOf(owner), 0.01e18);
        bool executed;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == DefenseExecutor.DefenseExecuted.selector) executed = true;
        }
        assertTrue(executed);
    }

    /// A relayer sells enough WETH into the real 0.05% pool to push it past the owner's 1% bound,
    /// delivers the alarm, then buys the WETH back. The delivery reverts instead of consuming the
    /// alarm, and the same alarm runs once the pool is back.
    function test_fork_poolPushedOffTheOracleRevertsAndTheAlarmStaysDeliverable() public {
        vm.skip(address(executor) == address(0));
        deal(WETH, owner, 0.01e18);
        address[] memory policyAssets = new address[](1);
        uint256[] memory caps = new uint256[](1);
        policyAssets[0] = WETH;
        caps[0] = 0.01e18;
        vm.startPrank(owner);
        executor.setPolicy(policyAssets, caps, 1 days, 100, 0.03e6);
        IERC20(WETH).approve(address(executor), type(uint256).max);
        vm.stopPrank();
        bytes memory body = abi.encode(owner, account, uint256(1e6), uint64(1), uint64(vm.getBlockTimestamp() + 900));
        bytes32 sender = bytes32(uint256(uint160(alarm)));

        // Well over the 800 WETH that moved the pool by 1% when this was measured.
        uint256 size = 2_000e18;
        deal(WETH, attacker, size);
        vm.startPrank(attacker);
        IERC20(WETH).approve(SWAP_ROUTER, type(uint256).max);
        IERC20(USDC).approve(SWAP_ROUTER, type(uint256).max);
        uint256 usdcOut = ISwapRouter02(SWAP_ROUTER)
            .exactInputSingle(ISwapRouter02.ExactInputSingleParams(WETH, USDC, 500, attacker, size, 0, 0));
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.SwapFailed.selector, WETH));
        vm.prank(MESSAGE_TRANSMITTER);
        executor.handleReceiveFinalizedMessage(26, sender, 2000, body);
        assertFalse(executor.alarmUsed(1));
        assertEq(IERC20(WETH).balanceOf(owner), 0.01e18);
        assertEq(executor.remainingCap(owner, WETH), 0.01e18);
        assertEq(executor.lastDefenseAt(owner), 0);

        vm.prank(attacker);
        ISwapRouter02(SWAP_ROUTER)
            .exactInputSingle(ISwapRouter02.ExactInputSingleParams(USDC, WETH, 500, attacker, usdcOut, 0, 0));

        vm.prank(MESSAGE_TRANSMITTER);
        assertTrue(executor.handleReceiveFinalizedMessage(26, sender, 2000, body));
        assertTrue(executor.alarmUsed(1));
        assertEq(executor.lastDefenseAt(owner), vm.getBlockTimestamp());
        assertEq(IERC20(USDC).balanceOf(address(executor)), 0);
        assertLt(IERC20(WETH).balanceOf(owner), 0.01e18);

        vm.expectRevert(abi.encodeWithSelector(DefenseExecutor.AlarmAlreadyUsed.selector, uint64(1)));
        vm.prank(MESSAGE_TRANSMITTER);
        executor.handleReceiveFinalizedMessage(26, sender, 2000, body);
    }
}
