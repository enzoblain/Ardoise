import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { describe, expect, it } from "vitest";
import { PaymentFailed, PaymentUnconfirmed, WAD, type PaymentRequest, type Venue } from "@/lib/ardoise";
import { createChainArdoise, toPaymentError } from "@/lib/chainArdoise";
import { accountAbi } from "@/lib/contracts/abis";

const OWNER: Address = "0x54e1714a0ffae58d3AA227C80FD48668e11f18d7";
const ACCOUNT: Address = "0x00000000000000000000000000000000000Ac0c1";
const GUARD: Address = "0x00000000000000000000000000000000000062d1";
const ADAPTER: Address = "0x38B564d0b3d57216A34d83FbF08DE48744567b38";
const PAYEE: Address = "0xdf41621b35b0c3512d1177DE1423747900fC7a77";
const TX: Hex = `0x${"ab".repeat(32)}`;
const AAVE: Venue = { id: "aave-v4", address: ADAPTER, name: "Aave V4", rateBps: 310, available: 10n ** 13n };

/** State of a fake Arc with one account on one Aave adapter. */
interface FakeArc {
  guard: Address;
  dropBps: bigint;
  caps: [bigint, bigint, bigint];
  allowed: bigint | null;
  simulateError?: Error;
  receiptError?: Error;
  logs: Log[];
  logRanges: [bigint, bigint][];
}

function fakeArc(overrides: Partial<FakeArc> = {}): FakeArc {
  return { guard: GUARD, dropBps: 0n, caps: [10_000_000n, 20_000_000n, 0n], allowed: null, logs: [], logRanges: [], ...overrides };
}

function revert(errorName: "CapExceeded" | "NoVenueAvailable", args: readonly bigint[]): Error {
  const data = encodeErrorResult({ abi: accountAbi, errorName, args } as never);
  const cause = new ContractFunctionRevertedError({ abi: accountAbi, data, functionName: "pay" });
  return new ContractFunctionExecutionError(cause, { abi: accountAbi, functionName: "pay", args: [] });
}

function paidLog(lineId: bigint): Log {
  return {
    address: ACCOUNT,
    topics: encodeEventTopics({ abi: accountAbi, eventName: "Paid", args: { lineId, venue: ADAPTER } }) as Log["topics"],
    data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint32, uint32, bytes32, string"), [
      1_000_000n,
      54_000n,
      1_054_000n,
      310,
      6,
      `0x000000000000000000000000${PAYEE.slice(2).toLowerCase()}`,
      "Logo design",
    ]),
    blockNumber: 31_800_000n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function client(arc: FakeArc) {
  const publicClient = {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      switch (functionName) {
        case "guard":
          return arc.guard;
        case "simulatedDropBps":
          return arc.dropBps;
        case "minHealthFactor":
          return (125n * WAD) / 100n;
        case "caps":
          return arc.caps;
        case "bestVenue":
          return ADAPTER;
        case "health":
          return [2n * WAD, 4n * WAD, 2n * WAD];
        case "simulatedHealth":
          return (2n * WAD * (10_000n - arc.dropBps)) / 10_000n;
        case "healthAfter":
          return (16n * WAD) / 10n;
        case "checkMargin":
          return arc.allowed ?? (args[2] as bigint);
        case "line":
          return {
            id: args[0],
            venue: ADAPTER,
            principal: 1_054_000n,
            repaid: 0n,
            accruedInterest: 0n,
            rateBps: 310,
            destinationDomain: 6,
            openedAt: 1_794_900_000,
            payee: `0x000000000000000000000000${PAYEE.slice(2).toLowerCase()}`,
            memo: "Logo design",
          };
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    async simulateContract() {
      if (arc.simulateError) throw arc.simulateError;
      return { result: 1n, request: {} };
    },
    async waitForTransactionReceipt() {
      if (arc.receiptError) throw arc.receiptError;
      return { status: "success", blockNumber: 31_800_000n, logs: [paidLog(7n)] };
    },
    async getBlockNumber() {
      return 31_800_000n;
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      arc.logRanges.push([fromBlock, toBlock]);
      return arc.logs.filter((log) => log.blockNumber! >= fromBlock && log.blockNumber! <= toBlock);
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { timestamp: blockNumber * 2n };
    },
  };
  const sent: unknown[] = [];
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 5042 },
    async writeContract(request: unknown) {
      sent.push(request);
      return TX;
    },
  };
  const account = createChainArdoise({
    publicClient: publicClient as never,
    walletClient: walletClient as never,
    owner: OWNER,
    account: ACCOUNT,
    venues: [AAVE],
    fromBlock: 31_777_009n,
  });
  return { account, sent };
}

const request = (amount: bigint, overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  amount,
  destinationDomain: 6,
  payee: PAYEE,
  maxFee: 54_000n,
  memo: "Logo design",
  ...overrides,
});

describe("on-chain Ardoise client", () => {
  it("quotes a payment the guard allows, with the venue's margin before and after", async () => {
    const { account } = client(fakeArc());
    const quote = await account.quote(request(1_000_000n));
    expect(quote.error).toBeUndefined();
    expect(quote.venue?.name).toBe("Aave V4");
    expect(quote.borrow).toBe(1_054_000n);
    expect(quote.healthBefore?.healthFactor).toBe(2n * WAD);
    expect(quote.healthAfter).toBe((16n * WAD) / 10n);
    expect(quote.minHealthFactor).toBe((125n * WAD) / 100n);
  });

  it("reports GuardNotSet while the factory has no guard, still showing the margin", async () => {
    const { account } = client(fakeArc({ guard: zeroAddress }));
    const quote = await account.quote(request(1_000_000n));
    expect(quote.error).toEqual({ code: "GuardNotSet" });
    expect(quote.minHealthFactor).toBeNull();
    expect(quote.healthAfter).toBeDefined();
    expect(await account.minHealthFactor()).toBeNull();
  });

  it("refuses what the guard refuses, and what the caps forbid", async () => {
    expect((await client(fakeArc({ allowed: 400_000n })).account.quote(request(1_000_000n))).error).toEqual({
      code: "PaymentRefused",
      allowed: 400_000n,
    });
    const capped = client(fakeArc({ caps: [10_000_000n, 20_000_000n, 19_500_000n] })).account;
    expect((await capped.quote(request(1_000_000n))).error).toEqual({ code: "CapExceeded", remaining: 500_000n });
  });

  it("rejects a fee on Arc and a zero amount before reading the chain", async () => {
    const { account } = client(fakeArc());
    expect((await account.quote(request(1_000_000n, { destinationDomain: 26 }))).error).toEqual({ code: "FeeOnArc" });
    expect((await account.quote(request(0n))).error).toEqual({ code: "ZeroAmount" });
  });

  it("surfaces a revert only the simulation sees", async () => {
    const { account } = client(fakeArc({ simulateError: new Error("Aave: borrow allowance exceeded") }));
    expect((await account.quote(request(1_000_000n))).error).toEqual({
      code: "Reverted",
      message: "Aave: borrow allowance exceeded",
    });
  });

  it("shows positions the way the guard judges them under a simulated drop", async () => {
    const { account } = client(fakeArc({ dropBps: 3_000n }));
    expect(await account.simulatedDropBps()).toBe(3_000);
    const quote = await account.quote(request(1_000_000n));
    expect(quote.healthBefore?.healthFactor).toBe((14n * WAD) / 10n);
    expect(quote.healthAfter).toBe((112n * WAD) / 100n);
  });

  it("pays from the owner's wallet and builds the line from the Paid event", async () => {
    const { account, sent } = client(fakeArc());
    const line = await account.pay(request(1_000_000n));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ address: ACCOUNT, functionName: "pay" });
    expect(line).toMatchObject({
      id: 7n,
      principal: 1_054_000n,
      rateBps: 310,
      destinationDomain: 6,
      memo: "Logo design",
      openedAt: 63_600_000,
      transactionHash: TX,
    });
    expect(line.venue.name).toBe("Aave V4");
  });

  it("reports a sent payment whose receipt cannot be read as unconfirmed, with its hash", async () => {
    const { account } = client(fakeArc({ receiptError: new Error("request timed out\ndetails") }));
    const error = await account.pay(request(1_000_000n)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentUnconfirmed);
    expect((error as PaymentUnconfirmed).transactionHash).toBe(TX);
    expect((error as PaymentUnconfirmed).message).toBe("request timed out");
  });

  it("reads the account's logs in slices from the factory's deployment", async () => {
    const arc = fakeArc({ logs: [paidLog(1n)] });
    const { account } = client(arc);
    const { logs, blockTimes } = await account.events();
    expect(logs).toHaveLength(1);
    expect(arc.logRanges[0]).toEqual([31_777_009n, 31_787_008n]);
    expect(arc.logRanges.at(-1)?.[1]).toBe(31_800_000n);
    expect(blockTimes.get(31_800_000n)).toBe(63_600_000);
  });
});

describe("toPaymentError", () => {
  it("maps contract errors by name, with their arguments", () => {
    expect(toPaymentError(revert("CapExceeded", [2_000_000n, 1_000_000n]))).toEqual({ code: "CapExceeded", remaining: 1_000_000n });
    expect(toPaymentError(revert("NoVenueAvailable", [1n]))).toEqual({ code: "NoVenueAvailable" });
  });

  it("keeps any other failure as a message", () => {
    expect(toPaymentError(new Error("User rejected the request."))).toEqual({
      code: "Reverted",
      message: "User rejected the request.",
    });
  });

  it("is what pay() throws for a contract refusal", () => {
    expect(new PaymentFailed({ code: "GuardNotSet" }).reason.code).toBe("GuardNotSet");
  });
});
