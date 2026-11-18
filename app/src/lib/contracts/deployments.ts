import { parseAbi, type Address } from "viem";
import { network } from "@/lib/network";

/** Addresses the app talks to on one network. */
export interface Deployment {
  factory: Address;
  /** Block the factory was deployed at: account logs are read from there. */
  deployBlock: bigint;
  /** Aave V4 Main Spoke, where the owner's cirBTC collateral and USDC debt live. */
  aaveSpoke: Address;
  /** Aave V4 position managers the owner authorizes once (docs/api.md). */
  aaveTaker: Address;
  aaveGiver: Address;
  /** `AaveV4Adapter`, the spender of the owner's borrow allowance. */
  aaveAdapter: Address;
  /** Reserve ids on the Main Spoke. */
  usdcReserveId: bigint;
  cirBtcReserveId: bigint;
  /** cirBTC, Circle's wrapped bitcoin on Arc (8 decimals): the collateral. */
  cirBtc: Address;
}

// From contracts/deployments.md (A4, PR #14). The contracts only exist on
// Arc mainnet: on testnet the app runs the simulated account.
export const MAINNET_DEPLOYMENT: Deployment = {
  factory: "0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD",
  deployBlock: 31_777_009n,
  aaveSpoke: "0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d",
  aaveTaker: "0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF",
  aaveGiver: "0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1",
  aaveAdapter: "0x38B564d0b3d57216A34d83FbF08DE48744567b38",
  usdcReserveId: 0n,
  cirBtcReserveId: 2n,
  cirBtc: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
};

/** The deployment of the selected network, or `null` where nothing is deployed. */
export const deployment: Deployment | null = network.name === "mainnet" ? MAINNET_DEPLOYMENT : null;

/** The Aave V4 calls of the one-time account setup (docs/api.md, *One-time user setup on Aave V4*). */
export const aaveSpokeAbi = parseAbi([
  "function isPositionManager(address user, address positionManager) view returns (bool)",
  "function setUserPositionManager(address positionManager, bool approve)",
  "function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)",
  // Supplying and enabling collateral, which a passkey account batches into its
  // activation; selectors checked against the mainnet calls of test 0.1.
  "function supply(uint256 reserveId, uint256 amount, address onBehalfOf)",
  "function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)",
]);

/** The ERC-20 calls on cirBTC: its balance in the wallet, and the approval before supplying it. */
export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
export const aaveTakerAbi = parseAbi([
  "function borrowAllowance(address spoke, uint256 reserveId, address owner, address spender) view returns (uint256)",
  "function approveBorrow(address spoke, uint256 reserveId, address spender, uint256 amount)",
]);
