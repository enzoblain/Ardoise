import { createPublicClient, http, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { PayoutChain } from "@/lib/network";

/** ERC-20 transfer, as USDC emits it on Arc and on Base. */
export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/**
 * Most blocks read in one `eth_getLogs` call. Public RPCs cap the range of a
 * log query, and Arc makes several blocks a second, so a request left open a
 * while is read in steps.
 */
export const MAX_BLOCK_RANGE = 2_000n;

/** A USDC transfer that pays a request. */
export interface ReceivedPayment {
  from: Address;
  /** USDC units (6 decimals). */
  amount: bigint;
  transactionHash: Hex;
  blockNumber: bigint;
}

/** One USDC transfer log, as read from the chain. */
export interface TransferLog {
  args: { from?: Address; to?: Address; value?: bigint };
  transactionHash: Hex | null;
  blockNumber: bigint | null;
}

/**
 * Picks the first transfer that pays the request: to the payee, of at least
 * the amount asked. A request without an amount is paid by any transfer.
 *
 * @param logs Transfer logs to the payee, oldest first.
 * @param minAmount Smallest amount that pays the request, in USDC units; 0 for any amount.
 * @returns The payment, or `undefined` if none of the logs pays the request.
 */
export function matchPayment(logs: TransferLog[], minAmount: bigint): ReceivedPayment | undefined {
  for (const log of logs) {
    const { from, value } = log.args;
    if (!from || value === undefined || !log.transactionHash || log.blockNumber === null) continue;
    if (value === 0n || value < minAmount) continue;
    return { from, amount: value, transactionHash: log.transactionHash, blockNumber: log.blockNumber };
  }
  return undefined;
}

/**
 * Splits a block range into steps of at most `MAX_BLOCK_RANGE` blocks.
 *
 * @param from First block to read.
 * @param to Last block to read, included.
 * @returns The inclusive ranges, in order; empty if `to` is before `from`.
 */
export function blockRanges(from: bigint, to: bigint): Array<[bigint, bigint]> {
  const ranges: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += MAX_BLOCK_RANGE) {
    const end = start + MAX_BLOCK_RANGE - 1n;
    ranges.push([start, end < to ? end : to]);
  }
  return ranges;
}

/**
 * Watches a chain for the USDC that pays a request, from the block the request
 * was created at. It reads the chain itself, so it sees the payment whoever
 * sends it and however it is sent; it cannot tell two payments of the same
 * amount to the same payee apart, which is why it only counts transfers made
 * after the request was created.
 */
export class RequestWatcher {
  private readonly client: PublicClient;
  private next: bigint;

  /**
   * @param chain Chain the payee asked to be paid on.
   * @param payee Address that receives the USDC.
   * @param minAmount Smallest amount that pays the request, in USDC units; 0 for any amount.
   * @param fromBlock Block the request was created at.
   * @param client Client for `chain`; a public one by default.
   */
  constructor(
    private readonly chain: PayoutChain,
    private readonly payee: Address,
    private readonly minAmount: bigint,
    fromBlock: bigint,
    client?: PublicClient,
  ) {
    this.client = client ?? logsClient(chain);
    this.next = fromBlock;
  }

  /**
   * Reads the blocks added since the last check.
   *
   * @returns The payment if it arrived, otherwise `undefined`.
   * @throws If the RPC fails; the next check resumes from the same block.
   */
  async check(): Promise<ReceivedPayment | undefined> {
    const latest = await this.client.getBlockNumber();
    for (const [fromBlock, toBlock] of blockRanges(this.next, latest)) {
      const logs = await this.client.getLogs({
        address: this.chain.usdc,
        event: TRANSFER_EVENT,
        args: { to: this.payee },
        fromBlock,
        toBlock,
      });
      const payment = matchPayment(logs, this.minAmount);
      if (payment) return payment;
      this.next = toBlock + 1n;
    }
    return undefined;
  }
}

/**
 * Reads the current block of a chain: the point a new request is watched from.
 *
 * @param chain Chain the payee asked to be paid on.
 * @returns The latest block number.
 */
export async function currentBlock(chain: PayoutChain): Promise<bigint> {
  return logsClient(chain).getBlockNumber();
}

function logsClient(chain: PayoutChain): PublicClient {
  return createPublicClient({ chain: chain.chain, transport: http(chain.logsRpcUrl) }) as PublicClient;
}

/** Channel a simulated payment uses to reach a waiting page in the same browser. */
export const DEMO_CHANNEL = "ardoise-payment-requests";

/** Message posted on `DEMO_CHANNEL` when the demo account pays a request. */
export interface DemoPaymentMessage {
  requestId: string;
  /** USDC units, as a decimal string (bigint does not cross the channel as is). */
  amount: string;
}
