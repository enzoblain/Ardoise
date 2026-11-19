// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {EnvAddress} from "../script/EnvAddress.sol";

contract EnvAddressHarness is EnvAddress {}

/// @notice The deployment scripts' address settings: a value that is not an address must stop
/// the script instead of falling back to the deploying key.
/// @dev `vm.setEnv` is process-wide and tests run in parallel, so each test uses its own
/// variable name.
contract EnvAddressTest is Test {
    address internal constant FALLBACK = address(0xFA11BAC);
    string internal constant VALID = "0x54e1714a0ffae58d3AA227C80FD48668e11f18d7";
    EnvAddressHarness internal env;

    function setUp() public {
        env = new EnvAddressHarness();
    }

    function test_unsetReturnsTheFallback() public view {
        assertEq(env.envAddressOr("ARDOISE_TEST_ADDRESS_UNSET", FALLBACK), FALLBACK);
    }

    function test_emptyReturnsTheFallback() public {
        vm.setEnv("ARDOISE_TEST_ADDRESS_EMPTY", "");
        assertEq(env.envAddressOr("ARDOISE_TEST_ADDRESS_EMPTY", FALLBACK), FALLBACK);
    }

    function test_validAddressIsReturned() public {
        vm.setEnv("ARDOISE_TEST_ADDRESS_VALID", VALID);
        assertEq(env.envAddressOr("ARDOISE_TEST_ADDRESS_VALID", FALLBACK), 0x54e1714a0ffae58d3AA227C80FD48668e11f18d7);
    }

    function test_truncatedAddressReverts() public {
        vm.setEnv("ARDOISE_TEST_ADDRESS_TRUNCATED", "0x54e1714a0ffae58d3AA227C80FD48668e11f18d");
        vm.expectRevert(bytes("ARDOISE_TEST_ADDRESS_TRUNCATED is not a valid address"));
        env.envAddressOr("ARDOISE_TEST_ADDRESS_TRUNCATED", FALLBACK);
    }

    function test_trailingSpaceGivesTheNamedAddressNotTheFallback() public {
        vm.setEnv("ARDOISE_TEST_ADDRESS_SPACE", string.concat(VALID, " "));
        assertEq(env.envAddressOr("ARDOISE_TEST_ADDRESS_SPACE", FALLBACK), 0x54e1714a0ffae58d3AA227C80FD48668e11f18d7);
    }

    function test_innerSpaceReverts() public {
        vm.setEnv("ARDOISE_TEST_ADDRESS_INNER", "0x54e1714a0ffae58d3AA2 27C80FD48668e11f18d7");
        vm.expectRevert(bytes("ARDOISE_TEST_ADDRESS_INNER is not a valid address"));
        env.envAddressOr("ARDOISE_TEST_ADDRESS_INNER", FALLBACK);
    }

    function test_notHexReverts() public {
        vm.setEnv("ARDOISE_TEST_ADDRESS_TEXT", "multisig");
        vm.expectRevert(bytes("ARDOISE_TEST_ADDRESS_TEXT is not a valid address"));
        env.envAddressOr("ARDOISE_TEST_ADDRESS_TEXT", FALLBACK);
    }

    function test_zeroAddressReverts() public {
        vm.setEnv("ARDOISE_TEST_ADDRESS_ZERO", "0x0000000000000000000000000000000000000000");
        vm.expectRevert(bytes("ARDOISE_TEST_ADDRESS_ZERO is the zero address"));
        env.envAddressOr("ARDOISE_TEST_ADDRESS_ZERO", FALLBACK);
    }
}
