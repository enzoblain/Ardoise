// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITokenMessengerV2
/// @notice The Circle CCTP V2 TokenMessenger call Ardoise makes to pay on another chain, copied
/// from https://github.com/circlefin/evm-cctp-contracts (src/v2/TokenMessengerV2.sol).
interface ITokenMessengerV2 {
    /// @notice Burns `amount` of `burnToken` from the caller and sends a message that mints it to
    /// `mintRecipient` on `destinationDomain`, with `hookData` attached.
    /// @dev With `hookData` set to "cctp-forward", Circle's Forwarding Service submits the mint on
    /// the destination chain, so the recipient needs no gas there; its fee comes out of `maxFee`.
    /// The caller must have approved this contract for `amount`.
    /// @param amount Amount to burn, fees included, in token decimals.
    /// @param destinationDomain CCTP domain of the destination chain.
    /// @param mintRecipient Recipient on the destination chain, as bytes32.
    /// @param burnToken Token to burn (USDC).
    /// @param destinationCaller Only address allowed to submit the mint, or zero for anyone.
    /// @param maxFee Maximum fee taken from `amount` on the destination chain.
    /// @param minFinalityThreshold Finality the attestation waits for (1000 fast, 2000 standard).
    /// @param hookData Data passed to the destination; "cctp-forward" enables the Forwarding Service.
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}
