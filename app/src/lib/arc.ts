import { createPublicClient, fallback, http, type Chain } from "viem";
import { network } from "@/lib/network";

/**
 * RPC transport for an Arc chain: `ARC_RPC_URL` first when set (server side
 * only, so a keyed endpoint never reaches the browser), then the chain's
 * public endpoints, each tried in turn when the previous one fails.
 *
 * Blockdaemon's endpoint comes first among the public ones: on 2026-11-18 it
 * served a full `eth_getLogs` scan of an account (17 slices of 10,000 blocks)
 * in 0.7 s without error, while `rpc.mainnet.arc.io` and QuickNode's answered
 * "rate limit exceeded" from the third or fourth call, and dRPC's free plan
 * refuses log ranges over 100 blocks. The timeout is short because pages
 * render on each request: a slow endpoint should hand over fast.
 *
 * @param chain Arc mainnet or Arc Testnet.
 * @param rpcUrl Preferred endpoint, if any.
 * @returns The transport.
 */
export function arcTransport(chain: Chain, rpcUrl?: string) {
  const publicUrls = [...chain.rpcUrls.default.http].sort((a, b) => Number(b.includes("blockdaemon")) - Number(a.includes("blockdaemon")));
  const urls = rpcUrl ? [rpcUrl, ...publicUrls] : publicUrls;
  // No retry of the whole chain: one pass over every endpoint, then fail fast.
  return fallback(
    urls.map((url) => http(url, { timeout: 3_000, retryCount: 0 })),
    { retryCount: 0 },
  );
}

/** Read-only client for Arc on the selected network. */
export const arcClient = createPublicClient({
  chain: network.arc.chain,
  transport: arcTransport(network.arc.chain, process.env.ARC_RPC_URL || undefined),
});
