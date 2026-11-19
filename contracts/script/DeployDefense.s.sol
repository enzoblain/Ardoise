// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {IMessageTransmitterV2} from "../src/cctp/IMessageTransmitterV2.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {DefenseAlarm} from "../src/defense/DefenseAlarm.sol";
import {DefenseExecutor, IAggregatorV3, ISwapRouter02} from "../src/defense/DefenseExecutor.sol";
import {IArdoiseFactory} from "../src/interfaces/IArdoiseFactory.sol";

/// @notice CCTP V2 addresses, identical on Arc and Base mainnet.
abstract contract DefenseAddresses is Script {
    address internal constant MESSAGE_TRANSMITTER_V2 = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64;
    address internal constant TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    uint32 internal constant ARC_DOMAIN = 26;
    uint32 internal constant BASE_DOMAIN = 6;
}

/// @title DeployDefenseAlarm
/// @notice Step 1, on Arc mainnet: deploys `DefenseAlarm` for an Ardoise factory.
/// @dev Environment: `DEPLOYER_PRIVATE_KEY` (required), `DEFENSE_FACTORY` (required: the factory
/// address, never hard-coded so the alarm follows a redeployed factory), `DEFENSE_COOLDOWN`
/// (seconds between two alarms per owner, default 1800), `DEFENSE_ALARM_TTL` (seconds an alarm
/// stays valid on Base, default 600; the alarm refuses a TTL longer than the cooldown). Funds still
/// on their way back from Base are protected by the executor's `minDefenseInterval`. Commands
/// are in contracts/deployments.md.
contract DeployDefenseAlarm is DefenseAddresses {
    /// @notice Runs the deployment.
    /// @return alarm The deployed alarm.
    function run() external returns (DefenseAlarm alarm) {
        require(block.chainid == 5042, "not Arc mainnet");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        IArdoiseFactory factory = IArdoiseFactory(vm.envAddress("DEFENSE_FACTORY"));
        uint256 cooldown = vm.envOr("DEFENSE_COOLDOWN", uint256(1800));
        uint256 ttl = vm.envOr("DEFENSE_ALARM_TTL", uint256(600));
        require(cooldown <= type(uint64).max && ttl <= type(uint64).max, "timing too large");
        vm.startBroadcast(key);
        alarm = new DefenseAlarm(
            factory,
            IMessageTransmitterV2(MESSAGE_TRANSMITTER_V2),
            BASE_DOMAIN,
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64(cooldown), // checked above
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64(ttl)
        );
        vm.stopBroadcast();
        console.log("DefenseAlarm:", address(alarm));
    }
}

/// @title DeployDefenseExecutor
/// @notice Step 2, on Base mainnet: deploys `DefenseExecutor` trusting the alarm on Arc, with WETH
/// as the only asset it can sell (ETH/USD Chainlink feed, 0.05% Uniswap V3 pool).
/// @dev Environment: `DEPLOYER_PRIVATE_KEY` (required), `DEFENSE_ALARM_ADDRESS` (required),
/// `DEFENSE_BURN_FINALITY` (1000 fast, default; 2000 standard), `DEFENSE_MAX_PRICE_AGE`
/// (seconds, default 1500: the feed's heartbeat on Base is 1200 s), `DEFENSE_MIN_INTERVAL`
/// (seconds between two burns for the same owner, default 3600: longer than a standard-finality
/// burn from Base, 13 to 19 minutes, takes to be minted on Arc).
contract DeployDefenseExecutor is DefenseAddresses {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant ETH_USD_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    uint24 internal constant WETH_USDC_POOL_FEE = 500;

    /// @notice Runs the deployment.
    /// @return executor The deployed executor.
    function run() external returns (DefenseExecutor executor) {
        require(block.chainid == 8453, "not Base mainnet");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address alarm = vm.envAddress("DEFENSE_ALARM_ADDRESS");
        uint256 finality = vm.envOr("DEFENSE_BURN_FINALITY", uint256(1000));
        require(finality == 1000 || finality == 2000, "finality must be 1000 or 2000");
        uint256 maxPriceAge = vm.envOr("DEFENSE_MAX_PRICE_AGE", uint256(1500));
        uint256 minInterval = vm.envOr("DEFENSE_MIN_INTERVAL", uint256(3600));
        DefenseExecutor.SwapAssetConfig[] memory assets = new DefenseExecutor.SwapAssetConfig[](1);
        assets[0] = DefenseExecutor.SwapAssetConfig(WETH, IAggregatorV3(ETH_USD_FEED), WETH_USDC_POOL_FEE);
        vm.startBroadcast(key);
        executor = new DefenseExecutor(
            DefenseExecutor.Config({
                messageTransmitter: MESSAGE_TRANSMITTER_V2,
                tokenMessenger: ITokenMessengerV2(TOKEN_MESSENGER_V2),
                alarm: alarm,
                arcDomain: ARC_DOMAIN,
                usdc: IERC20(USDC),
                swapRouter: ISwapRouter02(SWAP_ROUTER_02),
                // forge-lint: disable-next-line(unsafe-typecast)
                burnFinality: uint32(finality), // 1000 or 2000, checked above
                maxPriceAge: maxPriceAge,
                minDefenseInterval: minInterval
            }),
            assets
        );
        vm.stopBroadcast();
        console.log("DefenseExecutor:", address(executor));
    }
}

/// @title SetDefenseExecutor
/// @notice Step 3, on Arc mainnet: records the executor in the alarm (once, by the alarm's
/// deployer).
/// @dev Environment: `DEPLOYER_PRIVATE_KEY`, `DEFENSE_ALARM_ADDRESS`, `DEFENSE_EXECUTOR_ADDRESS`.
contract SetDefenseExecutor is DefenseAddresses {
    /// @notice Runs the call.
    function run() external {
        require(block.chainid == 5042, "not Arc mainnet");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        DefenseAlarm alarm = DefenseAlarm(vm.envAddress("DEFENSE_ALARM_ADDRESS"));
        address executor = vm.envAddress("DEFENSE_EXECUTOR_ADDRESS");
        vm.startBroadcast(key);
        alarm.setExecutor(executor);
        vm.stopBroadcast();
        console.log("executor set:", executor);
    }
}
