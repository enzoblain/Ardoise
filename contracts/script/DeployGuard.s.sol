// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {MarginGuard} from "../src/guard/MarginGuard.sol";
import {IGuard} from "../src/interfaces/IGuard.sol";

/// @title DeployGuard
/// @notice Deploys `MarginGuard` on Arc mainnet and sets it on the factory (task B5), after which
/// `pay()` no longer reverts with `GuardNotSet`.
/// @dev The factory admin must send it: `setGuard` is admin-only, and the admin also becomes the
/// guard's owner (thresholds and the demo's simulated price drop). Settings come from the
/// environment:
/// - `DEPLOYER_PRIVATE_KEY`: the admin's key. When it is unset, the script broadcasts from the
///   `--sender` address instead, which lets anyone simulate it against mainnet without a key;
/// - `ARDOISE_FACTORY_ADDRESS`: the factory, default the mainnet one in contracts/deployments.md;
/// - `ARDOISE_MIN_HEALTH_FACTOR`, `ARDOISE_TARGET_HEALTH_FACTOR`: thresholds in WAD, default
///   1.25e18 and 1.5e18 (roadmap B1);
/// - `ARDOISE_REPLACE_GUARD=true`: allow replacing a guard that is already set.
/// Usage and checks are in contracts/deployments.md.
contract DeployGuard is Script {
    uint256 internal constant ARC_CHAIN_ID = 5042;
    address internal constant MAINNET_FACTORY = 0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD;

    /// @notice Runs the deployment with the settings from the environment.
    /// @return guard The deployed guard, now set on the factory.
    function run() external returns (MarginGuard guard) {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        return deploy(
            ArdoiseFactory(vm.envOr("ARDOISE_FACTORY_ADDRESS", MAINNET_FACTORY)),
            key,
            key == 0 ? msg.sender : vm.addr(key),
            vm.envOr("ARDOISE_MIN_HEALTH_FACTOR", uint256(1.25e18)),
            vm.envOr("ARDOISE_TARGET_HEALTH_FACTOR", uint256(1.5e18)),
            vm.envOr("ARDOISE_REPLACE_GUARD", false)
        );
    }

    /// @notice Deploys the guard and sets it on `factory`, then checks the result on chain.
    /// @dev Reverts before sending anything if the chain is not Arc mainnet, `admin` is not the
    /// factory admin, or a guard is set and `replace` is false.
    /// @param factory Factory to set the guard on.
    /// @param key Admin's private key, or 0 to broadcast from the script's sender.
    /// @param admin Factory admin, who sends the transactions and owns the guard.
    /// @param minHealthFactor Minimum health factor after a payment (WAD).
    /// @param targetHealthFactor Health factor the keeper repays back to (WAD).
    /// @param replace Whether an existing guard may be replaced.
    /// @return guard The deployed guard.
    function deploy(
        ArdoiseFactory factory,
        uint256 key,
        address admin,
        uint256 minHealthFactor,
        uint256 targetHealthFactor,
        bool replace
    ) public returns (MarginGuard guard) {
        require(block.chainid == ARC_CHAIN_ID, "not Arc mainnet");
        // Checked before sending anything, so a wrong key or a second run costs no gas.
        require(factory.admin() == admin, "sender is not the factory admin");
        require(
            address(factory.guard()) == address(0) || replace,
            "a guard is already set; set ARDOISE_REPLACE_GUARD=true to replace it"
        );

        if (key == 0) vm.startBroadcast(admin);
        else vm.startBroadcast(key);
        guard = new MarginGuard(admin, minHealthFactor, targetHealthFactor);
        factory.setGuard(IGuard(address(guard)));
        vm.stopBroadcast();

        require(address(factory.guard()) == address(guard), "factory does not point to the new guard");
        require(guard.owner() == admin, "guard owner is not the admin");
        require(guard.minHealthFactor() == minHealthFactor, "minimum health factor not set");
        require(guard.targetHealthFactor() == targetHealthFactor, "target health factor not set");
        require(guard.simulatedDropBps() == 0, "simulation must start off");

        console.log("MarginGuard:", address(guard));
        console.log("factory:    ", address(factory));
        console.log("owner:      ", admin);
    }
}
