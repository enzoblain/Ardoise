// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {ArdoiseFactory} from "../src/ArdoiseFactory.sol";
import {MarginGuard} from "../src/guard/MarginGuard.sol";
import {IGuard} from "../src/interfaces/IGuard.sol";

/// @title DeployGuard
/// @notice Deploys `MarginGuard` on Arc mainnet and sets it on the factory (task B5), after which
/// `pay()` no longer reverts with `GuardNotSet`.
/// @dev By default the factory admin sends it and also becomes the guard's owner (thresholds and
/// the demo's simulated price drop). Both roles can be given to other addresses: the guard's
/// owner is immutable, and `setGuard` is admin-only, so when the sender is not the factory admin
/// the script deploys the guard, leaves the factory unchanged and prints the `setGuard` call the
/// admin has to send. Settings come from the environment:
/// - `DEPLOYER_PRIVATE_KEY`: the sender's key. When it is unset, the script broadcasts from the
///   `--sender` address instead, which lets anyone simulate it against mainnet without a key;
/// - `ARDOISE_FACTORY_ADDRESS`: the factory, default the mainnet one in contracts/deployments.md;
/// - `ARDOISE_FACTORY_ADMIN`: the factory admin when it is not the sender, default the sender.
///   Only naming it allows a run that does not set the guard, so a wrong key still sends nothing;
/// - `ARDOISE_GUARD_OWNER`: the guard's owner, default the factory admin;
/// - `ARDOISE_MIN_HEALTH_FACTOR`, `ARDOISE_TARGET_HEALTH_FACTOR`: thresholds in WAD, default
///   1.25e18 and 1.5e18 (roadmap B1);
/// - `ARDOISE_REPLACE_GUARD=true`: allow replacing a guard that is already set.
/// Usage and checks are in contracts/deployments.md.
contract DeployGuard is Script {
    uint256 internal constant ARC_CHAIN_ID = 5042;
    address internal constant MAINNET_FACTORY = 0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD;

    /// @notice Runs the deployment with the settings from the environment.
    /// @return guard The deployed guard, set on the factory when the sender is its admin.
    function run() external returns (MarginGuard guard) {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address sender = key == 0 ? msg.sender : vm.addr(key);
        address admin = vm.envOr("ARDOISE_FACTORY_ADMIN", sender);
        return deploy(
            ArdoiseFactory(vm.envOr("ARDOISE_FACTORY_ADDRESS", MAINNET_FACTORY)),
            key,
            sender,
            admin,
            vm.envOr("ARDOISE_GUARD_OWNER", admin),
            vm.envOr("ARDOISE_MIN_HEALTH_FACTOR", uint256(1.25e18)),
            vm.envOr("ARDOISE_TARGET_HEALTH_FACTOR", uint256(1.5e18)),
            vm.envOr("ARDOISE_REPLACE_GUARD", false)
        );
    }

    /// @notice Deploys the guard, sets it on `factory` when `sender` is the factory admin, then
    /// checks the result on chain.
    /// @dev Reverts before sending anything if the chain is not Arc mainnet, `admin` is not the
    /// factory admin, or a guard is set and `replace` is false. When `sender` is not `admin`,
    /// `setGuard` is not sent: the call the admin must make is printed instead.
    /// @param factory Factory to set the guard on.
    /// @param key Sender's private key, or 0 to broadcast from `sender` without one.
    /// @param sender Address that sends the transactions.
    /// @param admin Factory admin, the only address that can call `setGuard`.
    /// @param guardOwner Owner of the guard (immutable): sets thresholds and the simulated drop.
    /// @param minHealthFactor Minimum health factor after a payment (WAD).
    /// @param targetHealthFactor Health factor the keeper repays back to (WAD).
    /// @param replace Whether an existing guard may be replaced.
    /// @return guard The deployed guard.
    function deploy(
        ArdoiseFactory factory,
        uint256 key,
        address sender,
        address admin,
        address guardOwner,
        uint256 minHealthFactor,
        uint256 targetHealthFactor,
        bool replace
    ) public returns (MarginGuard guard) {
        require(block.chainid == ARC_CHAIN_ID, "not Arc mainnet");
        bool senderIsAdmin = admin == sender;
        // Checked before sending anything, so a wrong key or a second run costs no gas.
        require(
            factory.admin() == admin,
            senderIsAdmin ? "sender is not the factory admin" : "ARDOISE_FACTORY_ADMIN is not the factory admin"
        );
        require(
            address(factory.guard()) == address(0) || replace,
            "a guard is already set; set ARDOISE_REPLACE_GUARD=true to replace it"
        );

        if (key == 0) vm.startBroadcast(sender);
        else vm.startBroadcast(key);
        guard = new MarginGuard(guardOwner, minHealthFactor, targetHealthFactor);
        if (senderIsAdmin) factory.setGuard(IGuard(address(guard)));
        vm.stopBroadcast();

        if (senderIsAdmin) {
            require(address(factory.guard()) == address(guard), "factory does not point to the new guard");
        }
        require(guard.owner() == guardOwner, "guard owner is not the intended one");
        require(guard.minHealthFactor() == minHealthFactor, "minimum health factor not set");
        require(guard.targetHealthFactor() == targetHealthFactor, "target health factor not set");
        require(guard.simulatedDropBps() == 0, "simulation must start off");

        console.log("MarginGuard:", address(guard));
        console.log("factory:    ", address(factory));
        console.log("owner:      ", guardOwner);
        if (!senderIsAdmin) {
            console.log("ACTION REQUIRED: the sender is not the factory admin, so the factory does not use this guard.");
            console.log("It keeps its current guard:", address(factory.guard()));
            console.log("The admin must send, on Arc mainnet (chain id 5042), from", admin);
            console.log(
                string.concat(
                    "  cast send ", vm.toString(address(factory)), ' "setGuard(address)" ', vm.toString(address(guard))
                )
            );
        }
    }
}
