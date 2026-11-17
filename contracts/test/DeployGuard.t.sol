// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {DeployGuard} from "../script/DeployGuard.s.sol";
import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {ITokenMessengerV2} from "../src/cctp/ITokenMessengerV2.sol";
import {MarginGuard} from "../src/guard/MarginGuard.sol";
import {MockTokenMessenger} from "./mocks/ArdoiseMocks.sol";
import {MockToken} from "./venues/mocks/MockAaveV4.sol";

/// @notice Runs the guard deployment against a local factory, on the Arc mainnet chain id.
/// @dev Calls `deploy` with explicit settings: `vm.setEnv` is process-wide and tests run in
/// parallel, so the environment-reading `run()` is exercised by the mainnet simulation instead
/// (contracts/deployments.md).
contract DeployGuardTest is Test {
    uint256 internal constant ADMIN_KEY = 0xA11CE;
    address internal admin = vm.addr(ADMIN_KEY);
    ArdoiseFactory internal factory;
    DeployGuard internal script;

    function setUp() public {
        vm.chainId(5042);
        factory = new ArdoiseFactory(
            admin,
            IERC20(address(new MockToken(6))),
            ITokenMessengerV2(address(new MockTokenMessenger())),
            2000,
            10e6,
            20e6
        );
        script = new DeployGuard();
    }

    function _deploy(bool replace) internal returns (MarginGuard) {
        return script.deploy(factory, ADMIN_KEY, admin, 1.25e18, 1.5e18, replace);
    }

    function test_deploysTheGuardAndSetsItOnTheFactory() public {
        MarginGuard guard = _deploy(false);
        assertEq(address(factory.guard()), address(guard));
        assertEq(guard.owner(), admin);
        assertEq(guard.minHealthFactor(), 1.25e18);
        assertEq(guard.targetHealthFactor(), 1.5e18);
        assertEq(guard.simulatedDropBps(), 0);
    }

    function test_broadcastsFromTheSenderWithoutAKey() public {
        MarginGuard guard = script.deploy(factory, 0, admin, 1.25e18, 1.5e18, false);
        assertEq(address(factory.guard()), address(guard));
    }

    function test_refusesAnAddressThatIsNotTheFactoryAdmin() public {
        vm.expectRevert(bytes("sender is not the factory admin"));
        script.deploy(factory, 0xB0B, vm.addr(0xB0B), 1.25e18, 1.5e18, false);
    }

    function test_refusesToReplaceAGuardUnlessAsked() public {
        MarginGuard first = _deploy(false);
        vm.expectRevert(bytes("a guard is already set; set ARDOISE_REPLACE_GUARD=true to replace it"));
        _deploy(false);
        MarginGuard second = _deploy(true);
        assertTrue(address(second) != address(first));
        assertEq(address(factory.guard()), address(second));
    }

    function test_refusesAnotherChain() public {
        vm.chainId(1);
        vm.expectRevert(bytes("not Arc mainnet"));
        _deploy(false);
    }

    function test_rejectsInvalidThresholds() public {
        vm.expectRevert(abi.encodeWithSelector(MarginGuard.InvalidThresholds.selector, 1.5e18, 1.25e18));
        script.deploy(factory, ADMIN_KEY, admin, 1.5e18, 1.25e18, false);
    }
}
