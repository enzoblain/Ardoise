import { parseAbi } from "viem";

/**
 * Minimal ABIs for the contract members the keeper uses. They mirror the
 * frozen interfaces in `contracts/src/interfaces/` and the defense contracts
 * in `contracts/src/defense/`. The state-changing functions listed here are
 * `sweep()`, the permissionless `DefenseAlarm.raise(owner)` and CCTP's
 * `receiveMessage`, which delivers Circle's attested bytes unchanged: none of
 * them lets the keeper choose an amount or a recipient.
 */

export const factoryAbi = parseAbi([
  "event AccountCreated(address indexed owner, address indexed account)",
  "function venues() view returns (address[])",
  "function guard() view returns (address)",
  "function accountOf(address owner) view returns (address)",
]);

export const accountAbi = parseAbi(["function sweep() returns (uint256 repaid)"]);

export const venueAbi = parseAbi([
  "function health(address user) view returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd)",
]);

export const guardAbi = parseAbi([
  "function minHealthFactor() view returns (uint256)",
  "function targetHealthFactor() view returns (uint256)",
  // Addition of MarginGuard, not part of IGuard: the simulated price drop of the demo.
  "function simulatedDropBps() view returns (uint256)",
]);

export const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

/** `IDefenseAlarm` on Arc (`contracts/src/defense/interfaces/IDefenseAlarm.sol`). */
export const defenseAlarmAbi = parseAbi([
  "function raise(address owner) returns (uint64 nonce)",
  "function cooldown(address owner) view returns (uint64 nextAllowed)",
  "event AlarmRaised(address indexed owner, address indexed account, uint256 amountNeeded, uint64 nonce, uint64 expiry)",
  "error ExecutorNotSet()",
  "error NoAccount(address owner)",
  "error GuardNotSet()",
  "error PositionHealthy(address owner)",
  "error CoolingDown(uint64 nextAllowed)",
  "error SweepOutOfGas()",
]);

/**
 * CCTP V2 `MessageTransmitterV2.receiveMessage` on Base, with the errors and
 * events of `DefenseExecutor` (`contracts/src/defense/DefenseExecutor.sol`):
 * the transmitter calls the executor, so its reverts and logs come back
 * through this call.
 */
export const defenseRelayAbi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool success)",
  "error AlarmAlreadyUsed(uint64 nonce)",
  "error TooSoon(address owner, uint256 nextAllowed)",
  "error UnexpectedSender(uint32 sourceDomain, bytes32 sender)",
  "error UnfinalizedMessage(uint32 finalityThresholdExecuted)",
  "error StalePrice(address feed)",
  // Added by the executor's gas floor (PR #48): a delivery sent with too little gas for a swap.
  "error SwapOutOfGas()",
  // A swap that failed otherwise, in practice on price: the delivery reverts and can be sent again.
  "error SwapFailed(address asset)",
  "event DefenseExecuted(address indexed owner, address indexed account, uint64 indexed nonce, uint256 amount, uint256 maxFee)",
  "event AlarmIgnored(address indexed owner, uint64 indexed nonce, uint8 reason)",
]);
