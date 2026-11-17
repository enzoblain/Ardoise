import { parseAbi } from "viem";

/**
 * Minimal ABIs for the contract members the keeper uses. They mirror the
 * frozen interfaces in `contracts/src/interfaces/`; the only state-changing
 * function listed anywhere in this file is `sweep()`, which is what keeps
 * the keeper repay-only.
 */

export const factoryAbi = parseAbi([
  "event AccountCreated(address indexed owner, address indexed account)",
  "function venues() view returns (address[])",
  "function guard() view returns (address)",
]);

export const accountAbi = parseAbi(["function sweep() returns (uint256 repaid)"]);

export const venueAbi = parseAbi([
  "function health(address user) view returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd)",
]);

export const guardAbi = parseAbi([
  "function minHealthFactor() view returns (uint256)",
  "function targetHealthFactor() view returns (uint256)",
]);

export const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
