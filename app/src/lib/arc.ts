import { createPublicClient, http } from "viem";
import { network } from "@/lib/network";

/**
 * Read-only client for Arc on the selected network.
 *
 * Uses `ARC_RPC_URL` when set (server side only, so a keyed endpoint never
 * reaches the browser), otherwise viem's public Arc RPC. The timeout is short
 * because pages render on each request: a slow RPC should fail fast, not hold
 * the page for viem's default 10 s plus retries.
 */
export const arcClient = createPublicClient({
  chain: network.arc.chain,
  transport: http(process.env.ARC_RPC_URL || undefined, {
    timeout: 3_000,
    retryCount: 1,
  }),
});
