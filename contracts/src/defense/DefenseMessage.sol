// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DefenseMessage
/// @notice Body of the CCTP message `DefenseAlarm` sends to `DefenseExecutor`:
/// `abi.encode(address owner, address account, uint256 amountNeeded, uint64 nonce, uint64 expiry)`,
/// 160 bytes.
library DefenseMessage {
    /// @notice An alarm.
    /// @param owner Owner of the position, whose policy and funds the executor uses.
    /// @param account The owner's Ardoise account on Arc: the only destination of the funds.
    /// @param amountNeeded USDC (6 decimals) that brings the position back to the target.
    /// @param nonce Alarm identifier, consumed once.
    /// @param expiry Timestamp after which the alarm is ignored.
    struct Alarm {
        address owner;
        address account;
        uint256 amountNeeded;
        uint64 nonce;
        uint64 expiry;
    }

    /// @notice Encoded length of an alarm.
    uint256 internal constant LENGTH = 160;

    /// @notice Encodes an alarm.
    /// @param alarm The alarm.
    /// @return The message body.
    function encode(Alarm memory alarm) internal pure returns (bytes memory) {
        return abi.encode(alarm.owner, alarm.account, alarm.amountNeeded, alarm.nonce, alarm.expiry);
    }

    /// @notice Decodes an alarm; reverts if `body` is not `LENGTH` bytes or a field is out of range.
    /// @param body The message body.
    /// @return alarm The alarm.
    function decode(bytes calldata body) internal pure returns (Alarm memory alarm) {
        require(body.length == LENGTH, "bad defense message");
        (alarm.owner, alarm.account, alarm.amountNeeded, alarm.nonce, alarm.expiry) =
            abi.decode(body, (address, address, uint256, uint64, uint64));
    }
}
