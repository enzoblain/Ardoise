// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {IGuard} from "../src/interfaces/IGuard.sol";
import {AaveV4Adapter} from "../src/venues/AaveV4Adapter.sol";
import {MorphoAdapter} from "../src/venues/MorphoAdapter.sol";
import {IMorpho} from "../src/venues/morpho/IMorpho.sol";
import {IAaveV4GiverPositionManager, IAaveV4Spoke, IAaveV4TakerPositionManager} from "../src/venues/aave/IAaveV4.sol";

/// @title Deploy
/// @notice Deploys Ardoise on Arc mainnet: `ArdoiseFactory`, then the Aave V4 and Morpho adapters
/// pointing to it, then registers both with `setVenues`. The guard is deployed separately
/// (`DeployGuard`, task B5); an existing one is set here when `ARDOISE_GUARD` names it, otherwise
/// `pay()` reverts with `GuardNotSet` until `setGuard`.
/// @dev The deployer becomes the factory admin. The Arc mainnet addresses are public and listed
/// in docs/api.md; the rest comes from the environment:
/// - `DEPLOYER_PRIVATE_KEY` (required): key that pays for and sends the transactions;
/// - `ARDOISE_PER_PAYMENT_CAP`, `ARDOISE_DAILY_CAP`: default caps of new accounts, in USDC units
///   (6 decimals); default 10 and 20 USDC;
/// - `ARDOISE_MIN_FINALITY_THRESHOLD`: CCTP finality threshold, default 2000 (standard);
/// - `ARDOISE_GUARD`: an already deployed guard to set on the new factory (the guard does not
///   depend on the factory), default none.
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
    address internal constant MORPHO = 0x34CD04070dD72b14E241112F6d83812Df5Af7fCD;
    /// @dev Flagship cirBTC/USDC market (86% LLTV), the one Circle's Borrow Kit uses.
    bytes32 internal constant MORPHO_CIRBTC_USDC = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;

    /// @notice Runs the deployment.
    /// @return factory The deployed factory.
    /// @return adapter The deployed Aave V4 adapter.
    /// @return morpho The deployed Morpho adapter, registered with the Aave one.
    function run() external returns (ArdoiseFactory factory, AaveV4Adapter adapter, MorphoAdapter morpho) {
        require(block.chainid == ARC_CHAIN_ID, "not Arc mainnet");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerKey);
        uint256 perPaymentCap = vm.envOr("ARDOISE_PER_PAYMENT_CAP", uint256(10e6));
        uint256 dailyCap = vm.envOr("ARDOISE_DAILY_CAP", uint256(20e6));
        uint256 finality = vm.envOr("ARDOISE_MIN_FINALITY_THRESHOLD", uint256(2000));
        require(finality <= type(uint32).max, "finality threshold too large");
        address guard = vm.envOr("ARDOISE_GUARD", address(0));

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
        morpho = new MorphoAdapter(factory, IMorpho(MORPHO), MORPHO_CIRBTC_USDC);
        IVenue[] memory venues = new IVenue[](2);
        venues[0] = adapter;
        venues[1] = morpho;
        factory.setVenues(venues);
        if (guard != address(0)) factory.setGuard(IGuard(guard));
        vm.stopBroadcast();

        console.log("ArdoiseFactory:", address(factory));
        console.log("AaveV4Adapter: ", address(adapter));
        console.log("MorphoAdapter: ", address(morpho));
        console.log("guard:         ", guard);
        console.log("admin:         ", admin);
    }
}
