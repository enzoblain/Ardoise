import type { Address, Chain, Hex } from "viem";
import { arc, arcTestnet, base, baseSepolia } from "viem/chains";

/** Which set of chains the app talks to. */
export type NetworkName = "testnet" | "mainnet";

/** A chain a payment can be delivered on. */
export interface PayoutChain {
  key: "arc" | "base";
  label: string;
  chain: Chain;
  /** CCTP domain id, the same on mainnet and testnet. */
  cctpDomain: number;
  /** USDC's ERC-20 contract on this chain: what a payee receives. */
  usdc: Address;
  /**
   * Public RPC used to read logs from the browser, when the chain's default
   * one cannot: Base's own public RPC answers every `eth_getLogs` with
   * "request limit reached", publicnode's serves 2,000-block ranges.
   */
  logsRpcUrl?: string;
}

interface Network {
  name: NetworkName;
  /** Circle's attestation service (Iris) for this network. */
  irisUrl: string;
  arc: PayoutChain;
  base: PayoutChain;
}

const NETWORKS: Record<NetworkName, Network> = {
  testnet: {
    name: "testnet",
    irisUrl: "https://iris-api-sandbox.circle.com",
    arc: {
      key: "arc",
      label: "Arc Testnet",
      chain: arcTestnet,
      cctpDomain: 26,
      usdc: "0x3600000000000000000000000000000000000000",
    },
    base: {
      key: "base",
      label: "Base Sepolia",
      chain: baseSepolia,
      cctpDomain: 6,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      logsRpcUrl: "https://base-sepolia-rpc.publicnode.com",
    },
  },
  mainnet: {
    name: "mainnet",
    irisUrl: "https://iris-api.circle.com",
    arc: {
      key: "arc",
      label: "Arc",
      chain: arc,
      cctpDomain: 26,
      usdc: "0x3600000000000000000000000000000000000000",
    },
    base: {
      key: "base",
      label: "Base",
      chain: base,
      cctpDomain: 6,
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      logsRpcUrl: "https://base-rpc.publicnode.com",
    },
  },
};

/**
 * Network selected by `NEXT_PUBLIC_ARDOISE_NETWORK`.
 *
 * Defaults to testnet when unset: the team builds on Arc Testnet and switches
 * to mainnet for the venue adapters and the demo (see docs/roadmap.md).
 *
 * @throws If the variable is set to anything other than `testnet` or
 *   `mainnet`, so a typo cannot silently point a mainnet build at testnet.
 */
export const network: Network = selectNetwork(
  process.env.NEXT_PUBLIC_ARDOISE_NETWORK,
);

function selectNetwork(value: string | undefined): Network {
  if (!value) return NETWORKS.testnet;
  if (value === "testnet" || value === "mainnet") return NETWORKS[value];
  throw new Error(
    `NEXT_PUBLIC_ARDOISE_NETWORK must be "testnet" or "mainnet", got "${value}"`,
  );
}

/**
 * Finds the payout chain for a CCTP domain id.
 *
 * @param domain CCTP domain id, as reported by Iris.
 * @returns The matching chain on the current network, or `undefined` if the
 *   app does not deliver there.
 */
export function chainByDomain(domain: number): PayoutChain | undefined {
  return [network.arc, network.base].find((c) => c.cctpDomain === domain);
}

/**
 * Builds the explorer link of a transaction.
 *
 * @param chain Chain the transaction was sent on.
 * @param hash Transaction hash.
 * @returns The transaction page on that chain's explorer.
 */
export function txUrl(chain: PayoutChain, hash: Hex): string {
  return `${chain.chain.blockExplorers?.default.url}/tx/${hash}`;
}
