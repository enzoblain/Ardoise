import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionResult,
  numberToHex,
  zeroHash,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { arc } from "viem/chains";

import { accountAbi, erc20Abi, factoryAbi, guardAbi, venueAbi } from "./abis.js";
import { USDC_ADDRESS } from "./config.js";
import { Keeper } from "./keeper.js";

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;

const FACTORY: Address = "0x00000000000000000000000000000000000000f1";
const GUARD: Address = "0x00000000000000000000000000000000000000f2";
const VENUE: Address = "0x00000000000000000000000000000000000000f3";
const OWNER: Address = "0x00000000000000000000000000000000000000a1";
const ACCOUNT: Address = "0x00000000000000000000000000000000000000a2";
const KEEPER: Address = "0x00000000000000000000000000000000000000b1";
const TX: Hash = `0x${"ab".repeat(32)}`;

/** In-memory stand-in for Arc: one factory, one venue, one account created at `createdAt`. */
interface FakeChain {
  latest: bigint;
  createdAt: bigint;
  balance: bigint;
  debt: bigint;
  /** Amount `sweep()` reports in simulation. */
  sweepRepays: bigint;
  guardReverts: boolean;
  logsFail: boolean;
  /** Receipt of `TX`: `null` while the transaction is pending. */
  receipt: "success" | "reverted" | null;
  logRanges: [bigint, bigint][];
  sent: number;
}

function fakeChain(overrides: Partial<FakeChain> = {}): FakeChain {
  return {
    latest: 25_123n,
    createdAt: 10_099n,
    balance: 100n * USDC,
    debt: 4_000n,
    sweepRepays: 100n * USDC,
    guardReverts: false,
    logsFail: false,
    receipt: "success",
    logRanges: [],
    sent: 0,
    ...overrides,
  };
}

function call(chain: FakeChain, to: Address, data: Hex): Hex {
  switch (to.toLowerCase()) {
    case FACTORY: {
      const { functionName } = decodeFunctionData({ abi: factoryAbi, data });
      return functionName === "venues"
        ? encodeFunctionResult({ abi: factoryAbi, functionName: "venues", result: [VENUE] })
        : encodeFunctionResult({ abi: factoryAbi, functionName: "guard", result: GUARD });
    }
    case GUARD: {
      if (chain.guardReverts) throw new Error("execution reverted");
      const { functionName } = decodeFunctionData({ abi: guardAbi, data });
      const result = functionName === "minHealthFactor" ? (125n * WAD) / 100n : (15n * WAD) / 10n;
      return encodeFunctionResult({ abi: guardAbi, functionName, result });
    }
    case VENUE: {
      const debtUsd = chain.debt * WAD;
      const health = debtUsd === 0n ? 2n ** 256n - 1n : (7_800n * WAD * WAD) / debtUsd;
      return encodeFunctionResult({ abi: venueAbi, functionName: "health", result: [health, 10_000n * WAD, debtUsd] });
    }
    case USDC_ADDRESS:
      return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: chain.balance });
    case ACCOUNT:
      return encodeFunctionResult({ abi: accountAbi, functionName: "sweep", result: chain.sweepRepays });
    default:
      throw new Error(`unexpected call to ${to}`);
  }
}

function setUp(chain: FakeChain, options: { wallet?: boolean; fromBlock?: bigint } = {}) {
  const publicClient = createPublicClient({
    chain: arc,
    pollingInterval: 1,
    // viem caches the block number; the tests move the chain between two passes.
    cacheTime: 0,
    transport: custom({
      async request({ method, params }: { method: string; params: any }) {
        switch (method) {
          case "eth_chainId":
            return numberToHex(arc.id);
          case "eth_blockNumber":
            return numberToHex(chain.latest);
          case "eth_getLogs": {
            if (chain.logsFail) throw new Error("log query failed");
            const from = BigInt(params[0].fromBlock);
            const to = BigInt(params[0].toBlock);
            chain.logRanges.push([from, to]);
            if (chain.createdAt < from || chain.createdAt > to) return [];
            return [
              {
                address: FACTORY,
                topics: encodeEventTopics({
                  abi: factoryAbi,
                  eventName: "AccountCreated",
                  args: { owner: OWNER, account: ACCOUNT },
                }),
                data: "0x",
                blockNumber: numberToHex(chain.createdAt),
                blockHash: zeroHash,
                transactionHash: zeroHash,
                transactionIndex: "0x0",
                logIndex: "0x0",
                removed: false,
              },
            ];
          }
          case "eth_call":
            return call(chain, params[0].to, params[0].data);
          case "eth_getTransactionReceipt":
            if (chain.receipt === null) return null;
            return {
              transactionHash: TX,
              status: chain.receipt === "success" ? "0x1" : "0x0",
              blockNumber: numberToHex(chain.latest),
              blockHash: zeroHash,
              transactionIndex: "0x0",
              from: KEEPER,
              to: ACCOUNT,
              contractAddress: null,
              cumulativeGasUsed: "0x1",
              gasUsed: "0x1",
              effectiveGasPrice: "0x1",
              logs: [],
              logsBloom: `0x${"00".repeat(256)}`,
              type: "0x2",
            };
          default:
            throw new Error(`unexpected RPC method ${method}`);
        }
      },
    }),
  });

  // Only the two members the keeper uses; signing is out of scope here.
  const walletClient = {
    account: { address: KEEPER, type: "json-rpc" },
    writeContract: async () => {
      chain.sent += 1;
      return TX;
    },
  } as unknown as WalletClient<Transport, Chain, Account>;

  const logs: string[] = [];
  const clock = { now: 0 };
  const keeper = new Keeper({
    publicClient,
    walletClient: options.wallet ? walletClient : null,
    factory: FACTORY,
    fromBlock: options.fromBlock ?? 100n,
    log: (message) => logs.push(message),
    now: () => clock.now,
  });
  return { keeper, logs, clock };
}

test("reads the account history in slices without gap or overlap", async () => {
  const chain = fakeChain();
  const { keeper, logs } = setUp(chain);
  await keeper.tick();
  assert.deepEqual(chain.logRanges, [
    [100n, 10_099n],
    [10_100n, 20_099n],
    [20_100n, 25_123n],
  ]);
  assert.equal(logs.filter((line) => line.startsWith("watching account")).length, 1);
});

test("reads the last blocks again on the next pass and does not watch an account twice", async () => {
  const chain = fakeChain({ createdAt: 25_123n });
  const { keeper, logs } = setUp(chain);
  await keeper.tick();
  chain.logRanges.length = 0;
  chain.latest += 1n;
  await keeper.tick();
  assert.deepEqual(chain.logRanges, [[25_119n, 25_124n]]);
  assert.equal(logs.filter((line) => line.startsWith("watching account")).length, 1);
});

test("a dry run logs what it would send once, and sends nothing", async () => {
  const chain = fakeChain();
  const { keeper, logs } = setUp(chain);
  await keeper.tick();
  await keeper.tick();
  assert.equal(logs.filter((line) => line.includes("would repay 100 USDC")).length, 1);
  assert.equal(chain.sent, 0);
});

test("sends sweep() once and confirms it", async () => {
  const chain = fakeChain();
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  assert.equal(chain.sent, 1);
  assert.ok(logs.some((line) => line.includes(`sweep() confirmed in ${TX}`)));
});

test("does not send when sweep() would repay less than the minimum", async () => {
  // The balance is there, but the debt Ardoise can repay is not.
  const chain = fakeChain({ sweepRepays: 0n });
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  await keeper.tick();
  assert.equal(chain.sent, 0);
  assert.equal(logs.filter((line) => line.includes("would repay only 0 USDC")).length, 1);
});

test("does nothing for an account without debt", async () => {
  const chain = fakeChain({ debt: 0n });
  const { keeper } = setUp(chain, { wallet: true });
  await keeper.tick();
  assert.equal(chain.sent, 0);
});

test("waits after a revert, doubling the delay", async () => {
  const chain = fakeChain({ receipt: "reverted" });
  const { keeper, clock } = setUp(chain, { wallet: true });
  await keeper.tick();
  assert.equal(chain.sent, 1);

  clock.now = 59_000;
  await keeper.tick();
  assert.equal(chain.sent, 1, "still within the first delay");

  clock.now = 60_000;
  await keeper.tick();
  assert.equal(chain.sent, 2, "retried after one minute");

  clock.now = 60_000 + 119_000;
  await keeper.tick();
  assert.equal(chain.sent, 2, "the second delay is two minutes");

  clock.now = 60_000 + 120_000;
  chain.receipt = "success";
  await keeper.tick();
  assert.equal(chain.sent, 3);

  // A success clears the history: the next sweep is not delayed.
  await keeper.tick();
  assert.equal(chain.sent, 4);
});

test("still sweeps when the guard cannot be read", async () => {
  const chain = fakeChain({ guardReverts: true });
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  await keeper.tick();
  assert.equal(chain.sent, 2);
  assert.equal(logs.filter((line) => line.includes("cannot be read")).length, 1);
});

test("keeps checking known accounts when the log query fails", async () => {
  const chain = fakeChain();
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  chain.logsFail = true;
  await keeper.tick();
  assert.equal(chain.sent, 2);
  assert.ok(logs.some((line) => line.startsWith("reading new accounts failed")));
});
