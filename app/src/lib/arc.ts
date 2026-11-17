import { createPublicClient, http } from "viem";
import { arc } from "viem/chains";

/**
 * Read-only client for Arc mainnet (chain id 5042).
 *
 * Uses `ARC_RPC_URL` when set (server side only, so a keyed endpoint never
 * reaches the browser), otherwise viem's public Arc RPC. The timeout is short
 * because pages render on each request: a slow RPC should fail fast, not hold
 * the page for viem's default 10 s plus retries.
 */
export const arcClient = createPublicClient({
  chain: arc,
  transport: http(process.env.ARC_RPC_URL || undefined, {
    timeout: 3_000,
    retryCount: 1,
  }),
});
