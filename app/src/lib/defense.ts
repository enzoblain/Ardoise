import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { network } from "@/lib/network";

/**
 * The defense executor on Base the keeper relays to (the demo pair, see
 * contracts/deployments.md, *CCTP-attested defense*): when the alarm on Arc
 * fires, it spends what the owner pre-authorized here to repay on Arc.
 */
export const DEFENSE_EXECUTOR: Address = "0x7016D3D0a4DB22c6C2079C5e7172a1A4d2161f29";

const WETH: Address = "0x4200000000000000000000000000000000000006";
const policyAbi = parseAbi([
  "function policyOf(address owner) view returns ((address[] assets, uint256[] caps, uint64 period, uint16 maxSlippageBps, uint256 maxFee))",
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
