// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/// @title EnvAddress
/// @notice Strict reading of optional address settings for the deployment scripts.
/// @dev `vm.envOr(name, fallback)` returns the fallback whenever the value cannot be read, not
/// only when the variable is unset: an address that does not parse, or a string with an
/// unbalanced quote. For an immutable role that turns a pasting mistake (a missing digit, a lost
/// quote) into a successful-looking deployment owned by the deploying key, so these settings are
/// read with `vm.envString`, which reverts instead, and a value that is not an address stops the
/// script.
abstract contract EnvAddress is Script {
    /// @notice Reads an optional address from the environment.
    /// @dev Reverts, before the caller sends anything, if the variable is set to something that
    /// is not a 20-byte hex address or to the zero address. An empty value counts as unset, since
    /// `.env.example` ships the variables empty, and so does a value made only of whitespace,
    /// which Foundry returns as an empty string.
    /// Foundry accepts one pair of quotes around the value, trailing whitespace and a missing
    /// `0x`, and returns the address that was written; a leading space reverts.
    /// @param name Name of the environment variable.
    /// @param fallbackValue Address returned when the variable is unset or empty.
    /// @return value The parsed address, or `fallbackValue`.
    function envAddressOr(string memory name, address fallbackValue) public view returns (address value) {
        if (!vm.envExists(name)) return fallbackValue;
        string memory raw;
        try vm.envString(name) returns (string memory read) {
            raw = read;
        } catch {
            revert(string.concat(name, " is not a valid address"));
        }
        if (bytes(raw).length == 0) return fallbackValue;
        try vm.parseAddress(raw) returns (address parsed) {
            value = parsed;
        } catch {
            revert(string.concat(name, " is not a valid address"));
        }
        require(value != address(0), string.concat(name, " is the zero address"));
    }
}
