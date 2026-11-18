import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { network } from "./network";
import {
  MAX_BLOCK_RANGE,
  MIN_ANY_AMOUNT,
  REREAD_BLOCKS,
  RequestWatcher,
  blockRanges,
  matchPayment,
  type TransferLog,
} from "./requestWatch";

const PAYER: Address = "0x1111111111111111111111111111111111111111";
const PAYEE: Address = "0xdf41621b35b0c3512d1177DE1423747900fC7a77";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const log = (value: bigint, n = 1): TransferLog => ({
  args: { from: PAYER, to: PAYEE, value },
  transactionHash: hash(n),
  blockNumber: BigInt(100 + n),
});

describe("matchPayment", () => {
  it("returns the first transfer of at least the amount asked", () => {
    const payment = matchPayment([log(5_000_000n, 1), log(12_500_000n, 2), log(20_000_000n, 3)], 12_500_000n);
    expect(payment).toEqual({ from: PAYER, amount: 12_500_000n, transactionHash: hash(2), blockNumber: 102n });
  });

  it("accepts any transfer of at least 0.01 USDC when no amount is asked", () => {
    expect(matchPayment([log(0n, 1), log(MIN_ANY_AMOUNT, 2)], 0n)?.transactionHash).toBe(hash(2));
  });

  it("ignores dust sent to an open request", () => {
    expect(matchPayment([log(1n, 1), log(MIN_ANY_AMOUNT - 1n, 2)], 0n)).toBeUndefined();
  });

  it("returns nothing when no transfer is enough", () => {
    expect(matchPayment([log(12_499_999n)], 12_500_000n)).toBeUndefined();
    expect(matchPayment([], 0n)).toBeUndefined();
  });
});

describe("blockRanges", () => {
  it("splits a range into steps of MAX_BLOCK_RANGE blocks", () => {
    const ranges = blockRanges(10n, 10n + 2n * MAX_BLOCK_RANGE);
    expect(ranges).toEqual([
      [10n, 9n + MAX_BLOCK_RANGE],
      [10n + MAX_BLOCK_RANGE, 9n + 2n * MAX_BLOCK_RANGE],
      [10n + 2n * MAX_BLOCK_RANGE, 10n + 2n * MAX_BLOCK_RANGE],
    ]);
  });

  it("is empty when there is nothing new to read", () => {
    expect(blockRanges(11n, 10n)).toEqual([]);
  });
});

describe("RequestWatcher", () => {
  it("reads new blocks filtered on the payee, re-reading the last few, and finds the payment", async () => {
    const getLogs = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([log(12_500_000n, 7)]);
    const getBlockNumber = vi.fn().mockResolvedValueOnce(1_000n).mockResolvedValueOnce(1_010n);
    const getBlock = vi.fn().mockResolvedValue({ timestamp: 1_800_000_000n });
    const client = { getLogs, getBlockNumber, getBlock } as unknown as PublicClient;
    const watcher = new RequestWatcher(network.base, PAYEE, 12_500_000n, 900n, client);

    expect(await watcher.check()).toBeUndefined();
    expect(getLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: network.base.usdc, args: { to: PAYEE }, fromBlock: 900n, toBlock: 1_000n }),
    );
    const payment = await watcher.check();
    expect(payment?.transactionHash).toBe(hash(7));
    expect(payment?.landedAt).toBe(1_800_000_000_000);
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: 107n });
    // A node a few blocks behind may have answered the first read: the tail is read again.
    expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 1_001n - REREAD_BLOCKS, toBlock: 1_010n }));
  });

  it("never re-reads before the block the request started at", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const client = { getLogs, getBlockNumber: vi.fn().mockResolvedValue(105n) } as unknown as PublicClient;
    const watcher = new RequestWatcher(network.base, PAYEE, 1n, 100n, client);
    await watcher.check();
    await watcher.check();
    expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 100n }));
  });

  it("reads a long gap in several ranges", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const latest = 100n + 2n * MAX_BLOCK_RANGE + 5n;
    const client = { getLogs, getBlockNumber: vi.fn().mockResolvedValue(latest) } as unknown as PublicClient;
    await new RequestWatcher(network.base, PAYEE, 1n, 100n, client).check();
    expect(getLogs).toHaveBeenCalledTimes(3);
    expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ toBlock: latest }));
  });

  it("resumes from the same block after an RPC failure", async () => {
    const getLogs = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce([]);
    const client = { getLogs, getBlockNumber: vi.fn().mockResolvedValue(120n) } as unknown as PublicClient;
    const watcher = new RequestWatcher(network.base, PAYEE, 1n, 100n, client);

    await expect(watcher.check()).rejects.toThrow("429");
    await watcher.check();
    expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 100n }));
  });
});
