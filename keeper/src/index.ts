import { createPublicClient, http } from "viem";
import { arc } from "viem/chains";

/**
 * Keeper entry point.
 *
 * Watches Arc mainnet blocks. The repay-only logic (task B2 in
 * docs/roadmap.md) hooks into `onBlock`; until then the keeper only proves
 * it can follow the chain. Over HTTP viem polls (about every 4 s) and calls
 * `onBlock` once per poll with the latest block, not once per Arc block.
 */
const client = createPublicClient({
  chain: arc,
  transport: http(process.env.ARC_RPC_URL || undefined),
});

function onBlock(blockNumber: bigint): void {
  console.log(`[keeper] Arc block ${blockNumber}`);
}

client.watchBlockNumber({
  onBlockNumber: onBlock,
  onError: (error) => console.error(`[keeper] ${error.message}`),
});
