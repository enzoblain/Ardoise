import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { ardoiseEventsAbi } from "@/lib/abi";
import type { Venue } from "@/lib/ardoise";
import { createMockArdoise } from "@/lib/mockArdoise";
import { buildStatement } from "@/lib/statement";

const AAVE: Venue = { id: "aave-v4", address: "0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d", name: "Aave V4", rateBps: 310, available: 10n ** 13n };
const MORPHO: Venue = { id: "morpho", address: "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD", name: "Morpho", rateBps: 398, available: 10n ** 13n };
const PAYEE = "0xdf41621b35b0c3512d1177DE1423747900fC7a77";
const DAY = 86_400;

function repaidLog(lineId: bigint, amount: bigint, blockNumber: bigint): Log {
  return {
    address: "0x000000000000000000000000000000000000a4d0",
    topics: encodeEventTopics({
      abi: ardoiseEventsAbi,
      eventName: "LineRepaid",
      args: { lineId, payer: PAYEE },
    }) as Log["topics"],
    data: encodeAbiParameters(parseAbiParameters("uint256"), [amount]),
    blockNumber,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"22".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 1,
    removed: false,
  };
}

describe("buildStatement", () => {
  it("decodes the account's Paid events into lines, newest first", async () => {
    const account = createMockArdoise([AAVE, MORPHO]);
    await account.pay({ amount: 20_000_000n, destinationDomain: 6, payee: PAYEE, maxFee: 53_948n, memo: "Logo design" });
    const { account: emitter, logs, blockTimes } = await account.events();
    const statement = buildStatement(emitter, logs, blockTimes, [AAVE, MORPHO], Math.floor(Date.now() / 1000));

    expect(statement.lines.map((l) => l.lineId)).toEqual([3n, 2n, 1n]);
    expect(statement.lines[0]).toMatchObject({
      venueName: "Aave V4",
      amount: 20_000_000n,
      maxFee: 53_948n,
      borrowed: 20_053_948n,
      rateBps: 310,
      destinationDomain: 6,
      payee: PAYEE,
      memo: "Logo design",
      repaid: 0n,
    });
    expect(statement.lines[2]).toMatchObject({ memo: "Design invoice #41", destinationDomain: 6, borrowed: 60_000_000n });
    expect(statement.lines[1]).toMatchObject({ memo: "Hosting, November", destinationDomain: 26, maxFee: 0n });
    expect(statement.totalBorrowed).toBe(120_053_948n);
  });

  it("accrues simple interest at the line's rate since its block", async () => {
    const account = createMockArdoise([AAVE]);
    const { account: emitter, logs, blockTimes } = await account.events();
    const oldest = blockTimes.get(1n)!;
    // 60 USDC at 3.10% for 365 days = 1.86 USDC; 3 days after the payment
    // plus 362 more days.
    const statement = buildStatement(emitter, logs, blockTimes, [AAVE], oldest + 365 * DAY);
    const line = statement.lines.find((l) => l.lineId === 1n)!;
    expect(line.accruedInterest).toBe(1_860_000n);
    expect(line.owed).toBe(61_860_000n);
  });

  it("subtracts LineRepaid events and never shows a negative balance", async () => {
    const account = createMockArdoise([AAVE]);
    const { account: emitter, logs, blockTimes } = await account.events();
    const now = blockTimes.get(2n)!;
    blockTimes.set(10n, now);
    const statement = buildStatement(
      emitter,
      [...logs, repaidLog(2n, 15_000_000n, 10n), repaidLog(1n, 70_000_000n, 10n)],
      blockTimes,
      [AAVE],
      now,
    );
    const hosting = statement.lines.find((l) => l.lineId === 2n)!;
    expect(hosting).toMatchObject({ repaid: 15_000_000n, owed: 25_000_000n });
    expect(statement.lines.find((l) => l.lineId === 1n)!.owed).toBe(0n);
  });

  it("leaves the interest of repaid lines out of the total", async () => {
    const account = createMockArdoise([AAVE]);
    const { account: emitter, logs, blockTimes } = await account.events();
    const later = blockTimes.get(1n)! + 365 * DAY;
    blockTimes.set(10n, later);
    const statement = buildStatement(emitter, [...logs, repaidLog(1n, 62_000_000n, 10n)], blockTimes, [AAVE], later);
    const hosting = statement.lines.find((l) => l.lineId === 2n)!;
    expect(statement.totalInterest).toBe(hosting.accruedInterest);
    expect(statement.totalOwed).toBe(hosting.owed);
  });

  it("ignores events with the same signature from another contract", async () => {
    const account = createMockArdoise([AAVE]);
    const { account: emitter, logs, blockTimes } = await account.events();
    const spoofed: Log = { ...logs[0], address: "0x000000000000000000000000000000000000dEaD" };
    const statement = buildStatement(emitter, [spoofed, logs[1]], blockTimes, [AAVE], blockTimes.get(2n)!);
    expect(statement.lines.map((l) => l.lineId)).toEqual([2n]);
  });

  it("keeps a non-EVM payee as bytes32 instead of truncating it", async () => {
    const account = createMockArdoise([AAVE]);
    const { account: emitter, logs, blockTimes } = await account.events();
    const solanaLike = `0x${"9f".repeat(32)}` as const;
    const log: Log = {
      ...logs[0],
      data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint32, uint32, bytes32, string"), [
        1_000_000n, 0n, 1_000_000n, 310, 5, solanaLike, "Solana payee",
      ]),
    };
    const [line] = buildStatement(emitter, [log], blockTimes, [AAVE], blockTimes.get(1n)!).lines;
    expect(line.payee).toBeUndefined();
    expect(line.payeeBytes32).toBe(solanaLike);
  });

  it("names unknown venues by address and ignores unrelated logs", async () => {
    const account = createMockArdoise([AAVE]);
    const { account: emitter, logs, blockTimes } = await account.events();
    const unrelated: Log = { ...logs[0], topics: [`0x${"ab".repeat(32)}`] };
    const statement = buildStatement(emitter, [...logs, unrelated], blockTimes, [], blockTimes.get(2n)!);
    expect(statement.lines).toHaveLength(2);
    expect(statement.lines[0].venueName).toBe(AAVE.address);
  });

  it("fails loudly when a block time is missing", async () => {
    const { account, logs } = await createMockArdoise([AAVE]).events();
    expect(() => buildStatement(account, logs, new Map(), [AAVE], 0)).toThrow(/No time for block/);
  });
});
