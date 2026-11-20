import { createPublicClient, encodeFunctionData, erc20Abi, http, parseAbi, parseUnits, type Address } from "viem";
import { base } from "viem/chains";
import { network } from "@/lib/network";

/**
 * The defense executor on Base the keeper relays to (the demo pair, see
 * contracts/deployments.md, *CCTP-attested defense*): when the alarm on Arc
 * fires, it spends what the owner pre-authorized here to repay on Arc.
 */
export const DEFENSE_EXECUTOR: Address = "0x7016D3D0a4DB22c6C2079C5e7172a1A4d2161f29";

export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const policyAbi = parseAbi([
  "function policyOf(address owner) view returns ((address[] assets, uint256[] caps, uint64 period, uint16 maxSlippageBps, uint256 maxFee))",
  "function setPolicy(address[] assets, uint256[] caps, uint64 period, uint16 maxSlippageBps, uint256 maxFee)",
  "function clearPolicy()",
]);
const baseClient = createPublicClient({ chain: base, transport: http() });

/** One asset of the owner's defense mandate, in the order it is used. */
export interface MandateAsset {
  symbol: string;
  /** Cap per period, in display units. */
  cap: number;
}

/** The owner's defense mandate on Base, or `null` when none is set. */
export interface Mandate {
  assets: MandateAsset[];
  periodHours: number;
  maxSlippageBps: number;
}

/**
 * Reads the owner's defense mandate on the executor (mainnet only).
 *
 * @param owner The owner's wallet.
 * @returns The mandate, or `null` when the owner has none or off mainnet.
 */
export async function readMandate(owner: Address): Promise<Mandate | null> {
  if (network.name !== "mainnet") return null;
  const policy = await baseClient.readContract({ address: DEFENSE_EXECUTOR, abi: policyAbi, functionName: "policyOf", args: [owner] });
  if (policy.assets.length === 0) return null;
  return {
    assets: policy.assets.map((asset, i) =>
      asset.toLowerCase() === WETH.toLowerCase()
        ? { symbol: "WETH", cap: Number(policy.caps[i]) / 1e18 }
        : { symbol: "USDC", cap: Number(policy.caps[i]) / 1e6 },
    ),
    periodHours: Number(policy.period) / 3600,
    maxSlippageBps: policy.maxSlippageBps,
  };
}

/** The demo account's mandate, simulated: USDC first, then WETH. */
export const DEMO_MANDATE: Mandate = {
  assets: [
    { symbol: "USDC", cap: 50 },
    { symbol: "WETH", cap: 0.02 },
  ],
  periodHours: 24,
  maxSlippageBps: 100,
};

/** What the owner chooses for the mandate, in display units. */
export interface MandateChoice {
  /** USDC per day the executor may take, or 0 to leave USDC out. */
  usdcPerDay: number;
  /** WETH per day the executor may sell, or 0 to leave WETH out. */
  wethPerDay: number;
  /** Largest shortfall of a WETH sale against Chainlink, in basis points (10 to 500). */
  maxSlippageBps: number;
}

/** Largest CCTP fee (protocol and forwarder) the owner accepts per defense: 0.025 USDC. */
export const MANDATE_MAX_FEE = 25_000n;

/**
 * Reads what the owner holds on Base for the mandate.
 *
 * @param owner The owner's wallet on Base.
 * @returns USDC (6 decimals) and WETH (18 decimals) balances.
 */
export async function readBaseFunds(owner: Address): Promise<{ usdc: bigint; weth: bigint }> {
  const [usdc, weth] = await Promise.all([
    baseClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    baseClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
  ]);
  return { usdc, weth };
}

/**
 * The Base calls that set the owner's defense mandate on the executor:
 * approve each asset up to its daily cap, then `setPolicy` with USDC first,
 * then WETH, over 24 hours. USDC goes first so WETH is sold only when USDC
 * is not enough.
 *
 * @param choice What the owner chose.
 * @returns The calls, in order.
 * @throws If neither asset is chosen or the slippage is out of range.
 */
export function mandateCalls(choice: MandateChoice): { to: Address; data: `0x${string}` }[] {
  if (choice.maxSlippageBps < 10 || choice.maxSlippageBps > 500) throw new Error("Slippage must be between 0.1% and 5%.");
  const assets: Address[] = [];
  const caps: bigint[] = [];
  if (choice.usdcPerDay > 0) {
    assets.push(BASE_USDC);
    caps.push(parseUnits(choice.usdcPerDay.toString(), 6));
  }
  if (choice.wethPerDay > 0) {
    assets.push(WETH);
    caps.push(parseUnits(choice.wethPerDay.toString(), 18));
  }
  if (assets.length === 0) throw new Error("Choose USDC, WETH or both.");
  return [
    ...assets.map((asset, i) => ({
      to: asset,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DEFENSE_EXECUTOR, caps[i]] }),
    })),
    {
      to: DEFENSE_EXECUTOR,
      data: encodeFunctionData({ abi: policyAbi, functionName: "setPolicy", args: [assets, caps, 86_400n, choice.maxSlippageBps, MANDATE_MAX_FEE] }),
    },
  ];
}

/**
 * The Base calls that remove the mandate: `clearPolicy`, then both approvals back to 0.
 *
 * @returns The calls, in order.
 */
export function clearMandateCalls(): { to: Address; data: `0x${string}` }[] {
  return [
    { to: DEFENSE_EXECUTOR, data: encodeFunctionData({ abi: policyAbi, functionName: "clearPolicy" }) },
    { to: BASE_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DEFENSE_EXECUTOR, 0n] }) },
    { to: WETH, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DEFENSE_EXECUTOR, 0n] }) },
  ];
}
