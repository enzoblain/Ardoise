// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/// @title EnvAddress
/// @notice Strict reading of optional address settings for the deployment scripts.
/// @dev `vm.envOr(name, fallback)` returns the fallback when the value does not parse, not only
/// when the variable is unset. For an immutable role that turns a pasting mistake (a missing
/// digit) into a successful-looking deployment owned by the deploying key, so these settings are
/// read as text and a value that is not an address stops the script.
abstract contract EnvAddress is Script {
    /// @notice Reads an optional address from the environment.
    /// @dev Reverts, before the caller sends anything, if the variable is set to something that
    /// is not a 20-byte hex address or to the zero address. An empty value counts as unset,
    /// since `.env.example` ships the variables empty. Foundry trims whitespace around the value,
    /// so a trailing space yields the address that was meant, never the fallback.
    /// @param name Name of the environment variable.
    /// @param fallbackValue Address returned when the variable is unset or empty.
    /// @return value The parsed address, or `fallbackValue`.
    function envAddressOr(string memory name, address fallbackValue) public view returns (address value) {
        string memory raw = vm.envOr(name, string(""));
        if (bytes(raw).length == 0) return fallbackValue;
        try vm.parseAddress(raw) returns (address parsed) {
            value = parsed;
        } catch {
            revert(string.concat(name, " is not a valid address"));
        }
        require(value != address(0), string.concat(name, " is the zero address"));
    }
}
