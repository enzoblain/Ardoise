// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {EnvAddress} from "./EnvAddress.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {MarginGuard} from "../src/guard/MarginGuard.sol";
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
/// @dev The deployer becomes the factory admin unless `ARDOISE_FACTORY_ADMIN` names another
/// address (a cold wallet or a multisig). The admin is immutable, and only it can call `setVenues`
/// and `setGuard`: with a separate admin the script deploys the three contracts, leaves the
/// factory without venues and guard (`pay()` reverts until both are set) and prints the calls the
/// admin has to send. The Arc mainnet addresses are public and listed in docs/api.md; the rest
/// comes from the environment:
/// - `DEPLOYER_PRIVATE_KEY` (required): key that pays for and sends the transactions;
/// - `ARDOISE_FACTORY_ADMIN`: address of the factory admin, default the deployer;
/// - `ARDOISE_PER_PAYMENT_CAP`, `ARDOISE_DAILY_CAP`: default caps of new accounts, in USDC units
///   (6 decimals); default 10 and 20 USDC;
/// - `ARDOISE_MIN_FINALITY_THRESHOLD`: CCTP finality threshold, default 2000 (standard);
/// - `ARDOISE_GUARD`: an already deployed guard to set on the new factory (the guard does not
///   depend on the factory), default none;
/// - `ARDOISE_GUARD_OWNER`: the owner `ARDOISE_GUARD` must have, default the factory admin.
/// The address settings are read strictly (`EnvAddress`): a value that is not an address stops the
/// script instead of falling back to the default. Usage and verification commands are in
/// contracts/deployments.md.
contract Deploy is EnvAddress {
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

    /// @notice Runs the deployment with the settings from the environment.
    /// @return factory The deployed factory.
    /// @return adapter The deployed Aave V4 adapter.
    /// @return morpho The deployed Morpho adapter.
    function run() external returns (ArdoiseFactory factory, AaveV4Adapter adapter, MorphoAdapter morpho) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = envAddressOr("ARDOISE_FACTORY_ADMIN", vm.addr(deployerKey));
        uint256 finality = vm.envOr("ARDOISE_MIN_FINALITY_THRESHOLD", uint256(2000));
        require(finality <= type(uint32).max, "finality threshold too large");
        return deploy(
            deployerKey,
            admin,
            envAddressOr("ARDOISE_GUARD", address(0)),
            envAddressOr("ARDOISE_GUARD_OWNER", admin),
            vm.envOr("ARDOISE_PER_PAYMENT_CAP", uint256(10e6)),
            vm.envOr("ARDOISE_DAILY_CAP", uint256(20e6)),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32(finality) // checked above
        );
    }

    /// @notice Deploys the factory and both adapters, registers the venues and the guard when the
    /// deployer is the admin, then checks the simulated result.
    /// @dev `forge script` runs this in a local simulation before it sends anything, so the final
    /// checks stop a wrong deployment from being sent; they do not re-read the chain after mining
    /// (the read-only checks for that are in contracts/deployments.md).
    /// Reverts before sending anything if the chain is not Arc mainnet or if `guard` is not
    /// a guard owned by `guardOwner` with its simulation off. When `admin` is not the deployer,
    /// `setVenues` and `setGuard` are not sent: the calls the admin must make are printed instead.
    /// @param deployerKey Key that sends the transactions.
    /// @param admin Factory admin (immutable): the only address that can list venues and set the
    /// guard.
    /// @param guard An already deployed guard to set on the factory, or the zero address for none.
    /// @param guardOwner Owner `guard` must have; ignored when `guard` is the zero address.
    /// @param perPaymentCap Default cap per payment of new accounts, in USDC units.
    /// @param dailyCap Default cap per UTC day of new accounts, in USDC units.
    /// @param finality CCTP finality threshold given to new accounts.
    /// @return factory The deployed factory.
    /// @return adapter The deployed Aave V4 adapter.
    /// @return morpho The deployed Morpho adapter.
    function deploy(
        uint256 deployerKey,
        address admin,
        address guard,
        address guardOwner,
        uint256 perPaymentCap,
        uint256 dailyCap,
        uint32 finality
    ) public returns (ArdoiseFactory factory, AaveV4Adapter adapter, MorphoAdapter morpho) {
        require(block.chainid == ARC_CHAIN_ID, "not Arc mainnet");
        // Checked before anything is sent: a guard without code would make every payment revert
        // while decoding its answer, and the guard's owner can stop every payment or switch on the
        // simulated price drop, so a guard owned by an unexpected address is refused.
        if (guard != address(0)) {
            require(guard.code.length > 0 && IGuard(guard).minHealthFactor() > 1e18, "ARDOISE_GUARD is not a guard");
            require(MarginGuard(guard).owner() == guardOwner, "ARDOISE_GUARD has an unexpected owner");
            require(MarginGuard(guard).simulatedDropBps() == 0, "ARDOISE_GUARD has a simulated drop set");
        }
        bool deployerIsAdmin = admin == vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        factory = new ArdoiseFactory(
            admin, IERC20(USDC), ITokenMessengerV2(TOKEN_MESSENGER_V2), finality, perPaymentCap, dailyCap
        );
        adapter = new AaveV4Adapter(
            factory,
            IAaveV4Spoke(AAVE_MAIN_SPOKE),
            IAaveV4TakerPositionManager(AAVE_TAKER),
            IAaveV4GiverPositionManager(AAVE_GIVER),
            AAVE_USDC_RESERVE
        );
        morpho = new MorphoAdapter(factory, IMorpho(MORPHO), MORPHO_CIRBTC_USDC);
        if (deployerIsAdmin) {
            IVenue[] memory venues = new IVenue[](2);
            venues[0] = adapter;
            venues[1] = morpho;
            factory.setVenues(venues);
            if (guard != address(0)) factory.setGuard(IGuard(guard));
        }
        vm.stopBroadcast();

        require(factory.admin() == admin, "factory admin is not the intended one");
        require(address(adapter.factory()) == address(factory), "Aave adapter points to another factory");
        require(address(morpho.factory()) == address(factory), "Morpho adapter points to another factory");
        IVenue[] memory listed = factory.venues();
        if (deployerIsAdmin) {
            require(
                listed.length == 2 && address(listed[0]) == address(adapter) && address(listed[1]) == address(morpho),
                "venues not registered on the factory"
            );
            require(address(factory.guard()) == guard, "guard not set on the factory");
        } else {
            require(listed.length == 0 && address(factory.guard()) == address(0), "unexpected factory state");
        }

        console.log("ArdoiseFactory:", address(factory));
        console.log("AaveV4Adapter: ", address(adapter));
        console.log("MorphoAdapter: ", address(morpho));
        console.log("guard:         ", guard);
        console.log("admin:         ", admin);
        if (!deployerIsAdmin) _logAdminCalls(address(factory), address(adapter), address(morpho), guard);
    }

    /// @dev Prints what a separate admin has to send. Without these calls the factory lists no
    /// venue and has no guard, so the deployment must not look finished.
    function _logAdminCalls(address factory, address adapter, address morpho, address guard) private pure {
        console.log("ACTION REQUIRED: the deployer is not the admin, so no venue and no guard are set.");
        console.log("pay() reverts on this factory until the admin sends, on Arc mainnet (chain id 5042):");
        console.log(
            string.concat(
                "  cast send ",
                vm.toString(factory),
                ' "setVenues(address[])" "[',
                vm.toString(adapter),
                ",",
                vm.toString(morpho),
                ']"'
            )
        );
        if (guard != address(0)) {
            console.log(
                string.concat("  cast send ", vm.toString(factory), ' "setGuard(address)" ', vm.toString(guard))
            );
        } else {
            console.log("  then setGuard(<guard>), once a guard is deployed with script/DeployGuard.s.sol");
            console.log(
                string.concat(
                    "  (run it with ARDOISE_FACTORY_ADDRESS=", vm.toString(factory), ": its default is another factory)"
                )
            );
        }
    }
}
