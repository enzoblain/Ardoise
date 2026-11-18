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

/**
 * Blocks read again on every check. A load-balanced RPC can answer the block
 * number from one node and the logs from another a few blocks behind; moving
 * the cursor past blocks that node had not seen yet would miss a payment for
 * good. Re-reading the tail also covers a short reorg.
 */
export const REREAD_BLOCKS = 20n;

/**
 * Smallest transfer that confirms a request without an amount: 0.01 USDC.
 * Bots send tiny "address poisoning" transfers from lookalike addresses; they
 * must not show as the payment.
 */
export const MIN_ANY_AMOUNT = 10_000n;

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
 * @param minAmount Smallest amount that pays the request, in USDC units; 0 for any
 *   amount, which still needs `MIN_ANY_AMOUNT`.
 * @returns The payment, or `undefined` if none of the logs pays the request.
 */
export function matchPayment(logs: TransferLog[], minAmount: bigint): ReceivedPayment | undefined {
  const floor = minAmount > 0n ? minAmount : MIN_ANY_AMOUNT;
  for (const log of logs) {
    const { from, value } = log.args;
    if (!from || value === undefined || !log.transactionHash || log.blockNumber === null) continue;
    if (value < floor) continue;
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
  private readonly start: bigint;
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
    this.start = fromBlock;
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
    // Next time, start a little before the newest block read (see REREAD_BLOCKS).
    const rewound = this.next - REREAD_BLOCKS;
    this.next = rewound > this.start ? rewound : this.start;
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
  /** Address the demo payment was sent to. */
  payee: string;
  /** Chain it was sent on, as `PayoutChain.key`. */
  chain: string;
  /** USDC units, as a decimal string (bigint does not cross the channel as is). */
  amount: string;
}

/**
 * Checks that a demo payment message pays a request: same request, same payee
 * and chain (both stay editable on the pay screen), and enough USDC.
 *
 * @param data Whatever arrived on the channel.
 * @param request The request the page waits for.
 * @param minAmount Smallest amount that pays it, in USDC units.
 * @returns The amount paid, or `undefined` if the message does not pay this request.
 */
export function demoPaymentAmount(
  data: unknown,
  request: { id: string; payee: string; chain: string },
  minAmount: bigint,
): bigint | undefined {
  const msg = data as Partial<DemoPaymentMessage> | null;
  if (!msg || msg.requestId !== request.id || msg.chain !== request.chain) return undefined;
  if (typeof msg.payee !== "string" || msg.payee.toLowerCase() !== request.payee.toLowerCase()) return undefined;
  if (typeof msg.amount !== "string" || !/^\d+$/.test(msg.amount)) return undefined;
  const amount = BigInt(msg.amount);
  return amount >= (minAmount > 0n ? minAmount : MIN_ANY_AMOUNT) ? amount : undefined;
}
