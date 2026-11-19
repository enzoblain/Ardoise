// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMessageTransmitterV2
/// @notice The Circle CCTP V2 MessageTransmitter calls Ardoise's defense makes, copied from
/// https://github.com/circlefin/evm-cctp-contracts (src/v2/MessageTransmitterV2.sol).
interface IMessageTransmitterV2 {
    /// @notice Sends a generic message to `recipient` on `destinationDomain`. No fee is charged.
    /// @param destinationDomain CCTP domain of the destination chain.
    /// @param recipient Contract on the destination chain implementing `IMessageHandlerV2`.
    /// @param destinationCaller Only address allowed to relay the message, or zero for anyone.
    /// @param minFinalityThreshold Finality the attestation waits for (1000 fast, 2000 standard).
    /// @param messageBody Application payload.
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external;

    /// @notice Delivers an attested message to its recipient on this chain.
    /// @param message The message bytes emitted by `MessageSent` on the source chain.
    /// @param attestation Circle's attestation, from the Iris API.
    /// @return success True when the recipient handled the message.
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
}

/// @title IMessageHandlerV2
/// @notice Recipient interface of CCTP V2 generic messages, copied from
/// https://github.com/circlefin/evm-cctp-contracts (src/interfaces/v2/IMessageHandlerV2.sol).
interface IMessageHandlerV2 {
    /// @notice Handles a message attested at a finality threshold of 2000 or more.
    /// @param sourceDomain CCTP domain the message comes from.
    /// @param sender Sender on the source chain, as bytes32.
    /// @param finalityThresholdExecuted Finality the message was attested at.
    /// @param messageBody Application payload.
    /// @return True if handled; a false return or a revert makes `receiveMessage` revert.
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);

    /// @notice Handles a message attested below a finality threshold of 2000.
    /// @param sourceDomain CCTP domain the message comes from.
    /// @param sender Sender on the source chain, as bytes32.
    /// @param finalityThresholdExecuted Finality the message was attested at.
    /// @param messageBody Application payload.
    /// @return True if handled; a false return or a revert makes `receiveMessage` revert.
    function handleReceiveUnfinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);
}
