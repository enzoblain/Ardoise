// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice Stand-in for Arc's native-coin precompile (0x1800…), which forge's EVM does not
/// implement: Arc's USDC moves balances through it, so every USDC transfer reverts on a fork
/// without it. It moves native balances (USDC with 18 decimals) with Foundry cheatcodes, which
/// any contract may call during a test. Etch it at the precompile address in fork tests only.
contract ArcNativeCoinMock {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Moves `value` of native balance from `from` to `to`, as the precompile does.
    function transfer(address from, address to, uint256 value) external returns (bool) {
        require(from.balance >= value, "insufficient native balance");
        VM.deal(from, from.balance - value);
        VM.deal(to, to.balance + value);
        return true;
    }
}

/// @notice Stand-in for Arc's USDC blocklist precompile (0x1800…01), which forge's EVM does not
/// implement either: `transferFrom` asks it about the spender. Nobody is blocklisted here.
contract ArcBlocklistMock {
    /// @notice Whether `account` is blocklisted: never, in tests.
    function isBlocklisted(address) external pure returns (bool) {
        return false;
    }
}
