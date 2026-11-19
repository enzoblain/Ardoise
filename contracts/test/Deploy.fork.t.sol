// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {MarginGuard} from "../src/guard/MarginGuard.sol";
import {IGuard} from "../src/interfaces/IGuard.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {AaveV4Adapter} from "../src/venues/AaveV4Adapter.sol";
import {MorphoAdapter} from "../src/venues/MorphoAdapter.sol";

/// @notice Runs the main deployment against the real Arc mainnet lending contracts, on a fork.
/// @dev Skipped unless `ARC_FORK_URL` is set, like the other fork tests: the adapters read Aave V4
/// and Morpho in their constructors. Calls `deploy` with explicit settings because `vm.setEnv` is
/// process-wide and tests run in parallel.
contract DeployForkTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xD3910;
    address internal deployer = vm.addr(DEPLOYER_KEY);
    address internal coldAdmin = makeAddr("cold admin");
    Deploy internal script;

    function setUp() public {
        string memory url = vm.envOr("ARC_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        script = new Deploy();
    }

    function _deploy(address admin, address guard, address guardOwner)
        internal
        returns (ArdoiseFactory factory, AaveV4Adapter adapter, MorphoAdapter morpho)
    {
        return script.deploy(DEPLOYER_KEY, admin, guard, guardOwner, 10e6, 20e6, 2000);
    }

    function test_deployerAsAdminRegistersVenuesAndGuard() public {
        MarginGuard guard = new MarginGuard(deployer, 1.25e18, 1.5e18);
        (ArdoiseFactory factory, AaveV4Adapter adapter, MorphoAdapter morpho) =
            _deploy(deployer, address(guard), deployer);
        assertEq(factory.admin(), deployer);
        IVenue[] memory venues = factory.venues();
        assertEq(venues.length, 2);
        assertEq(address(venues[0]), address(adapter));
        assertEq(address(venues[1]), address(morpho));
        assertEq(address(factory.guard()), address(guard));
    }

    function test_separateAdminIsLeftToRegisterVenuesAndGuard() public {
        MarginGuard guard = new MarginGuard(coldAdmin, 1.25e18, 1.5e18);
        (ArdoiseFactory factory, AaveV4Adapter adapter, MorphoAdapter morpho) =
            _deploy(coldAdmin, address(guard), coldAdmin);
        assertEq(factory.admin(), coldAdmin);
        assertEq(factory.venues().length, 0, "the deployer cannot list venues");
        assertEq(address(factory.guard()), address(0), "the deployer cannot set the guard");

        // The calls the script prints, sent by the admin, complete the deployment.
        IVenue[] memory venues = new IVenue[](2);
        venues[0] = adapter;
        venues[1] = morpho;
        vm.startPrank(coldAdmin);
        factory.setVenues(venues);
        factory.setGuard(IGuard(address(guard)));
        vm.stopPrank();
        assertEq(factory.venues().length, 2);
        assertEq(address(factory.guard()), address(guard));
    }

    function test_refusesAGuardWithAnUnexpectedOwner() public {
        MarginGuard guard = new MarginGuard(makeAddr("someone else"), 1.25e18, 1.5e18);
        vm.expectRevert(bytes("ARDOISE_GUARD has an unexpected owner"));
        _deploy(deployer, address(guard), deployer);
    }

    function test_refusesAGuardWithASimulatedDrop() public {
        MarginGuard guard = new MarginGuard(deployer, 1.25e18, 1.5e18);
        vm.prank(deployer);
        guard.setSimulatedDrop(5500);
        vm.expectRevert(bytes("ARDOISE_GUARD has a simulated drop set"));
        _deploy(deployer, address(guard), deployer);
    }
}
