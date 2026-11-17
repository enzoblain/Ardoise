import type { Chain, Hex } from "viem";
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
  explorerUrl: string;
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
      explorerUrl: "https://explorer.testnet.arc.io",
    },
    base: {
      key: "base",
      label: "Base Sepolia",
      chain: baseSepolia,
      cctpDomain: 6,
      explorerUrl: "https://sepolia.basescan.org",
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
      explorerUrl: "https://explorer.arc.io",
    },
    base: {
      key: "base",
      label: "Base",
      chain: base,
      cctpDomain: 6,
      explorerUrl: "https://basescan.org",
    },
  },
};

/**
 * Network selected by `NEXT_PUBLIC_ARDOISE_NETWORK`.
 *
 * Defaults to testnet: the team builds on Arc Testnet and switches to
 * mainnet for the venue adapters and the demo (see docs/roadmap.md).
 */
export const network: Network =
  NETWORKS[
    process.env.NEXT_PUBLIC_ARDOISE_NETWORK === "mainnet" ? "mainnet" : "testnet"
  ];

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
  return `${chain.explorerUrl}/tx/${hash}`;
}
