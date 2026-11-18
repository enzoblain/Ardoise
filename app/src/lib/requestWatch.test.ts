import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { network } from "./network";
import { MAX_BLOCK_RANGE, RequestWatcher, blockRanges, matchPayment, type TransferLog } from "./requestWatch";

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

  it("accepts any non-zero transfer when no amount is asked", () => {
    expect(matchPayment([log(0n, 1), log(1n, 2)], 0n)?.transactionHash).toBe(hash(2));
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
  it("reads only new blocks, filtered on the payee, and finds the payment", async () => {
    const getLogs = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([log(12_500_000n, 7)]);
    const getBlockNumber = vi.fn().mockResolvedValueOnce(105n).mockResolvedValueOnce(110n);
    const client = { getLogs, getBlockNumber } as unknown as PublicClient;
    const watcher = new RequestWatcher(network.base, PAYEE, 12_500_000n, 100n, client);

    expect(await watcher.check()).toBeUndefined();
    expect(getLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: network.base.usdc, args: { to: PAYEE }, fromBlock: 100n, toBlock: 105n }),
    );
    expect((await watcher.check())?.transactionHash).toBe(hash(7));
    expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 106n, toBlock: 110n }));
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
