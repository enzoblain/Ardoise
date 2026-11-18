import type { Address, Log } from "viem";
import { describe, expect, it } from "vitest";
import { createAccountEvents, eventsFromJson, eventsToJson } from "@/lib/accountEvents";

const FACTORY: Address = "0x00000000000000000000000000000000000FAC70";
const OWNER: Address = "0x00000000000000000000000000000000000000A1";
const ACCOUNT: Address = "0x00000000000000000000000000000000000Ac0c1";

function log(blockNumber: bigint): Log {
  return {
    address: ACCOUNT,
    topics: [`0x${"11".repeat(32)}`],
    data: "0x",
    blockNumber,
    transactionHash: `0x${"22".repeat(32)}`,
    logIndex: 0,
  } as unknown as Log;
}

function fakeArc(logsAt: bigint[]) {
  const arc = { latest: 1_000n + 25_000n, ranges: [] as [bigint, bigint][], accountOfReads: 0, blockReads: 0 };
  const client = {
    async readContract() {
      arc.accountOfReads++;
      return ACCOUNT;
    },
    getBlockNumber: async () => arc.latest,
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      arc.ranges.push([fromBlock, toBlock]);
      return logsAt.filter((b) => b >= fromBlock && b <= toBlock).map(log);
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      arc.blockReads++;
      return { timestamp: blockNumber * 2n };
    },
  };
  return { arc, store: createAccountEvents(client as never, FACTORY, 1_000n) };
}

describe("account events store", () => {
  it("scans from the deployment in slices, then only the new blocks", async () => {
    const { arc, store } = fakeArc([5_000n, 26_000n]);
    const first = await store.read(OWNER, ACCOUNT);
    expect(arc.ranges).toEqual([
      [1_000n, 10_999n],
      [11_000n, 20_999n],
      [21_000n, 26_000n],
    ]);
    expect(first?.logs.map((l) => l.blockNumber)).toEqual([5_000n, 26_000n]);
    expect(first?.blockTimes.get(5_000n)).toBe(10_000);

    arc.ranges = [];
    arc.latest = 26_500n;
    const second = await store.read(OWNER, ACCOUNT);
    expect(arc.ranges).toEqual([[26_001n, 26_500n]]);
    expect(second?.logs).toHaveLength(2);
    expect(arc.accountOfReads).toBe(1);
    expect(arc.blockReads).toBe(2);
  });

  it("shares one scan between concurrent requests", async () => {
    const { arc, store } = fakeArc([]);
    await Promise.all([store.read(OWNER, ACCOUNT), store.read(OWNER, ACCOUNT)]);
    expect(arc.ranges).toHaveLength(3);
  });

  it("refuses an account that is not the owner's, without scanning it", async () => {
    const { arc, store } = fakeArc([]);
    expect(await store.read(OWNER, "0x00000000000000000000000000000000DeadBeef")).toBeNull();
    expect(arc.ranges).toHaveLength(0);
  });

  it("survives a JSON round trip with the fields the statement reads", async () => {
    const { store } = fakeArc([5_000n]);
    const events = (await store.read(OWNER, ACCOUNT))!;
    const back = eventsFromJson(JSON.parse(JSON.stringify(eventsToJson(events))));
    expect(back.logs[0]).toMatchObject({ address: ACCOUNT, blockNumber: 5_000n, data: "0x", logIndex: 0 });
    expect(back.blockTimes).toEqual(events.blockTimes);
  });
});
