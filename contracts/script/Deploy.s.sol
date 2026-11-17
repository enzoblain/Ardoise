// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {AaveV4Adapter} from "../src/venues/AaveV4Adapter.sol";
import {IAaveV4GiverPositionManager, IAaveV4Spoke, IAaveV4TakerPositionManager} from "../src/venues/aave/IAaveV4.sol";

/// @title Deploy
/// @notice Deploys Ardoise on Arc mainnet: `ArdoiseFactory`, then the Aave V4 adapter pointing to
/// it, then registers the adapter with `setVenues`. The guard is deployed and set separately
/// (task B5), so `pay()` reverts with `GuardNotSet` until then.
/// @dev The deployer becomes the factory admin. The Arc mainnet addresses are public and listed
/// in docs/api.md; the rest comes from the environment:
/// - `DEPLOYER_PRIVATE_KEY` (required): key that pays for and sends the transactions;
/// - `ARDOISE_PER_PAYMENT_CAP`, `ARDOISE_DAILY_CAP`: default caps of new accounts, in USDC units
///   (6 decimals); default 10 and 20 USDC;
/// - `ARDOISE_MIN_FINALITY_THRESHOLD`: CCTP finality threshold, default 2000 (standard).
/// Usage and verification commands are in contracts/deployments.md.
contract Deploy is Script {
    uint256 internal constant ARC_CHAIN_ID = 5042;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address internal constant AAVE_MAIN_SPOKE = 0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d;
    address internal constant AAVE_TAKER = 0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF;
    address internal constant AAVE_GIVER = 0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1;
    /// @dev USDC reserve on the Main Spoke.
    uint256 internal constant AAVE_USDC_RESERVE = 0;

    /// @notice Runs the deployment.
    /// @return factory The deployed factory.
    /// @return adapter The deployed Aave V4 adapter, registered as the only venue.
    function run() external returns (ArdoiseFactory factory, AaveV4Adapter adapter) {
        require(block.chainid == ARC_CHAIN_ID, "not Arc mainnet");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerKey);
        uint256 perPaymentCap = vm.envOr("ARDOISE_PER_PAYMENT_CAP", uint256(10e6));
        uint256 dailyCap = vm.envOr("ARDOISE_DAILY_CAP", uint256(20e6));
        uint256 finality = vm.envOr("ARDOISE_MIN_FINALITY_THRESHOLD", uint256(2000));
        require(finality <= type(uint32).max, "finality threshold too large");

        vm.startBroadcast(deployerKey);
        factory = new ArdoiseFactory(
            admin,
            IERC20(USDC),
            ITokenMessengerV2(TOKEN_MESSENGER_V2),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32(finality), // checked above
            perPaymentCap,
            dailyCap
        );
        adapter = new AaveV4Adapter(
            factory,
            IAaveV4Spoke(AAVE_MAIN_SPOKE),
            IAaveV4TakerPositionManager(AAVE_TAKER),
            IAaveV4GiverPositionManager(AAVE_GIVER),
            AAVE_USDC_RESERVE
        );
        IVenue[] memory venues = new IVenue[](1);
        venues[0] = adapter;
        factory.setVenues(venues);
        vm.stopBroadcast();

        console.log("ArdoiseFactory:", address(factory));
        console.log("AaveV4Adapter: ", address(adapter));
        console.log("admin:         ", admin);
    }
}
