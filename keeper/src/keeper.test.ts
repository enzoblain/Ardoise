import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionResult,
  numberToHex,
  pad,
  zeroAddress,
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
import { GATEWAY_MAINNET, GatewayFunder, type StandingOrder } from "./gateway.js";
import { Keeper, type KeeperOptions } from "./keeper.js";

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;

const FACTORY: Address = "0x00000000000000000000000000000000000000f1";
const GUARD: Address = "0x00000000000000000000000000000000000000f2";
const VENUE: Address = "0x00000000000000000000000000000000000000f3";
const SECOND_VENUE: Address = "0x00000000000000000000000000000000000000f4";
const OWNER: Address = "0x00000000000000000000000000000000000000a1";
const ACCOUNT: Address = "0x00000000000000000000000000000000000000a2";
const KEEPER: Address = "0x00000000000000000000000000000000000000b1";
const TX: Hash = `0x${"ab".repeat(32)}`;

/**
 * In-memory stand-in for Arc: one factory, one venue (two with `secondVenueDebt`), one account
 * created at `createdAt`.
 */
interface FakeChain {
  latest: bigint;
  createdAt: bigint;
  balance: bigint;
  debt: bigint;
  /** Debt on a second venue (Morpho next to Aave V4), or `null` for a factory with one venue. */
  secondVenueDebt: bigint | null;
  /** What the first venue answers instead of the position derived from `debt`, in the contract's own units. */
  position: { healthFactor: bigint; debtUsd: bigint; debtOf: bigint } | null;
  /** Makes every venue's `debtOf` read fail, while `health` still answers. */
  debtOfFails: boolean;
  /** Amount `sweep()` reports in simulation. */
  sweepRepays: bigint;
  guardReverts: boolean;
  /** Simulated price drop reported by the guard, or `null` for a guard without the simulation. */
  simulatedDropBps: bigint | null;
  logsFail: boolean;
  /** Makes the account's balance read fail. */
  callsFail: boolean;
  /** Receipt of `TX`: `null` while the transaction is pending. */
  receipt: "success" | "reverted" | null;
  /** Makes the keeper wallet fail to send, as an empty wallet would. */
  sendFails: boolean;
  logRanges: [bigint, bigint][];
  sent: number;
}

function fakeChain(overrides: Partial<FakeChain> = {}): FakeChain {
  return {
    latest: 25_123n,
    createdAt: 10_099n,
    balance: 100n * USDC,
    debt: 4_000n,
    secondVenueDebt: null,
    position: null,
    debtOfFails: false,
    sweepRepays: 100n * USDC,
    guardReverts: false,
    simulatedDropBps: 0n,
    logsFail: false,
    callsFail: false,
    receipt: "success",
    sendFails: false,
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
        ? encodeFunctionResult({
            abi: factoryAbi,
            functionName: "venues",
            result: chain.secondVenueDebt === null ? [VENUE] : [VENUE, SECOND_VENUE],
          })
        : encodeFunctionResult({ abi: factoryAbi, functionName: "guard", result: GUARD });
    }
    case GUARD: {
      if (chain.guardReverts) throw new Error("execution reverted");
      const { functionName } = decodeFunctionData({ abi: guardAbi, data });
      if (functionName === "simulatedDropBps") {
        if (chain.simulatedDropBps === null) throw new Error("execution reverted");
        return encodeFunctionResult({ abi: guardAbi, functionName, result: chain.simulatedDropBps });
      }
      const result = functionName === "minHealthFactor" ? (125n * WAD) / 100n : (15n * WAD) / 10n;
      return encodeFunctionResult({ abi: guardAbi, functionName, result });
    }
    case VENUE:
    case SECOND_VENUE: {
      // Both positions hold 7,800 USD of risk-adjusted collateral.
      const debt = to.toLowerCase() === VENUE ? chain.debt : chain.secondVenueDebt!;
      const override = to.toLowerCase() === VENUE ? chain.position : null;
      if (decodeFunctionData({ abi: venueAbi, data }).functionName === "debtOf") {
        if (chain.debtOfFails) throw new Error("execution reverted");
        return encodeFunctionResult({ abi: venueAbi, functionName: "debtOf", result: override?.debtOf ?? debt * USDC });
      }
      const debtUsd = override?.debtUsd ?? debt * WAD;
      const health = override?.healthFactor ?? (debtUsd === 0n ? 2n ** 256n - 1n : (7_800n * WAD * WAD) / debtUsd);
      return encodeFunctionResult({ abi: venueAbi, functionName: "health", result: [health, 10_000n * WAD, debtUsd] });
    }
    case USDC_ADDRESS:
      if (chain.callsFail) throw new Error("execution reverted");
      return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: chain.balance });
    case ACCOUNT:
      return encodeFunctionResult({ abi: accountAbi, functionName: "sweep", result: chain.sweepRepays });
    default:
      throw new Error(`unexpected call to ${to}`);
  }
}

function setUp(
  chain: FakeChain,
  options: { wallet?: boolean; fromBlock?: bigint; gateway?: KeeperOptions["gateway"]; defense?: KeeperOptions["defense"] } = {},
) {
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
          case "eth_getTransactionByHash":
            return null;
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
      // A failing fake RPC call must fail at once instead of being retried.
    }, { retryCount: 0 }),
  });

  // Only the two members the keeper uses; signing is out of scope here.
  const walletClient = {
    account: { address: KEEPER, type: "json-rpc" },
    writeContract: async () => {
      if (chain.sendFails) throw new Error("insufficient funds for gas");
      chain.sent += 1;
      // A confirmed sweep moves the whole balance into the debt.
      if (chain.receipt === "success") chain.balance = 0n;
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
    receiptTimeoutMs: 20,
    gateway: options.gateway,
    defense: options.defense,
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
  assert.deepEqual(chain.logRanges, [[24_884n, 25_124n]]);
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
  chain.balance = 50n * USDC;
  chain.sweepRepays = 50n * USDC;
  await keeper.tick();
  assert.equal(chain.sent, 4);
});

test("waits for a pending sweep() instead of sending a second one", async () => {
  const chain = fakeChain({ receipt: null });
  const { keeper, logs, clock } = setUp(chain, { wallet: true });
  await keeper.tick();
  assert.equal(chain.sent, 1);

  clock.now = 120_000;
  await keeper.tick();
  assert.equal(chain.sent, 1, "no second transaction while the first is pending");
  assert.ok(logs.some((line) => line.includes("still pending")));

  // The transaction lands: the balance went into the debt, nothing is left to sweep.
  chain.receipt = "success";
  chain.balance = 0n;
  await keeper.tick();
  assert.equal(chain.sent, 1);
  assert.ok(logs.some((line) => line.includes(`sweep() confirmed in ${TX}`)));
});

test("treats a sweep() without receipt as lost after the deadline and retries later", async () => {
  const chain = fakeChain({ receipt: null });
  const { keeper, logs, clock } = setUp(chain, { wallet: true });
  await keeper.tick();

  clock.now = 300_000;
  await keeper.tick();
  assert.ok(logs.some((line) => line.includes("treating it as lost")));
  assert.equal(chain.sent, 1, "the retry delay applies first");

  clock.now = 300_000 + 60_000;
  chain.receipt = "success";
  await keeper.tick();
  assert.equal(chain.sent, 2);
});

test("waits after a send that fails", async () => {
  const chain = fakeChain({ sendFails: true });
  const { keeper, logs, clock } = setUp(chain, { wallet: true });
  await keeper.tick();
  assert.ok(logs.some((line) => line.includes("sending sweep() failed")));

  chain.sendFails = false;
  await keeper.tick();
  assert.equal(chain.sent, 0, "still within the delay");

  clock.now = 60_000;
  await keeper.tick();
  assert.equal(chain.sent, 1);
});

test("keeps reporting the margin of an account on hold", async () => {
  const chain = fakeChain({ receipt: "reverted" });
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();

  // During the hold the position falls under the minimum and the balance is gone.
  chain.debt = 6_500n;
  chain.balance = 0n;
  await keeper.tick();
  assert.ok(logs.some((line) => line.includes("under the minimum but nothing to repay with")));
});

test("logs a failing check again after it recovered", async () => {
  const chain = fakeChain({ debt: 0n });
  const { keeper, logs } = setUp(chain);
  await keeper.tick();
  for (const broken of [true, false, true]) {
    chain.callsFail = broken;
    await keeper.tick();
  }
  assert.equal(logs.filter((line) => line.includes("check failed")).length, 2);
  assert.equal(logs.filter((line) => line.includes("check works again")).length, 1);
});

test("never reads logs before the start block", async () => {
  const chain = fakeChain({ latest: 25_123n, createdAt: 25_100n });
  const { keeper } = setUp(chain, { fromBlock: 25_050n });
  await keeper.tick();
  await keeper.tick();
  assert.deepEqual(chain.logRanges, [
    [25_050n, 25_123n],
    [25_050n, 25_123n],
  ]);
});

test("still sweeps when the guard cannot be read, and says so once", async () => {
  const chain = fakeChain({ guardReverts: true });
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  await keeper.tick();
  assert.equal(chain.sent, 1);
  assert.equal(logs.filter((line) => line.includes("cannot be read")).length, 1);
});

test("keeps checking known accounts when the log query fails", async () => {
  const chain = fakeChain();
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  chain.logsFail = true;
  chain.balance = 50n * USDC;
  chain.sweepRepays = 50n * USDC;
  await keeper.tick();
  assert.equal(chain.sent, 2);
  assert.ok(logs.some((line) => line.startsWith("reading new accounts failed")));
});

test("under a simulated drop, labels the logs and sweeps to restore the margin", async () => {
  // Health factor 1.95 for 4,000 USDC of debt; -40% brings it to 1.17, under the 1.25 minimum.
  const chain = fakeChain({ simulatedDropBps: 4_000n });
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  assert.ok(logs.some((line) => line.startsWith("SIMULATION: collateral price -40%")));
  assert.ok(logs.some((line) => line.includes("[SIMULATION] health factor 1.170") && line.includes("under the minimum")));
  assert.equal(chain.sent, 1);
});

test("says when the simulation is turned off again", async () => {
  const chain = fakeChain({ simulatedDropBps: 4_000n, balance: 0n });
  const { keeper, logs } = setUp(chain);
  await keeper.tick();
  chain.simulatedDropBps = 0n;
  await keeper.tick();
  assert.ok(logs.some((line) => line.startsWith("simulation off")));
  assert.ok(logs.some((line) => line.includes("health factor 1.950") && !line.includes("[SIMULATION]")));
});

test("judges at the real price, and says so once, when the simulated drop cannot be read", async () => {
  // Under the minimum only if a drop applied: the real health factor is 1.95.
  const chain = fakeChain({ simulatedDropBps: null, balance: 0n });
  const { keeper, logs } = setUp(chain);
  await keeper.tick();
  await keeper.tick();
  assert.equal(logs.filter((line) => line.includes("assuming no simulation")).length, 1);
  assert.ok(logs.some((line) => line.includes("health factor 1.950") && line.includes("margin is fine")));
  assert.ok(!logs.some((line) => line.includes("[SIMULATION]")));
});

test("asks Gateway for the shortfall of an account under the minimum with nothing to repay with", async () => {
  const chain = fakeChain({ debt: 6_500n, balance: 0n });
  const calls: [Address, Address, bigint][] = [];
  const { keeper } = setUp(chain, { gateway: { fund: async (owner, account, shortfall) => void calls.push([owner, account, shortfall]), isCovering: () => false } });
  await keeper.tick();
  assert.equal(calls.length, 1);
  const [owner, account, shortfall] = calls[0];
  assert.equal(owner.toLowerCase(), OWNER);
  assert.equal(account.toLowerCase(), ACCOUNT);
  // 6,500 of debt at HF 1.2 back to 1.5: 6,500 - 7,800 / 1.5 = 1,300 USDC.
  assert.equal(shortfall, 1_300n * USDC);
});

test("caps what Gateway may bring at the debt on every venue, less the balance already on the account", async () => {
  // 0.05 USDC on the account is too little to sweep now, but it repays with the next sweep.
  const chain = fakeChain({ debt: 6_500n, secondVenueDebt: 1_000n, balance: 50_000n });
  const calls: [bigint, bigint][] = [];
  const { keeper } = setUp(chain, {
    gateway: { fund: async (_owner, _account, shortfall, maxDraw) => void calls.push([shortfall, maxDraw]), isCovering: () => false },
  });
  await keeper.tick();
  assert.deepEqual(calls, [[1_300n * USDC - 50_000n, 7_500n * USDC - 50_000n]]);
});

test("leaves the shortfall to the defense alarm when every standing order is larger than the debt left", async () => {
  // 4,000 USDC of debt at HF 1.95, judged at 1.17 under a -40% drop: 880 USDC missing.
  const chain = fakeChain({ debt: 4_000n, balance: 0n, simulatedDropBps: 4_000n });
  const submitted: string[] = [];
  const gatewayLogs: string[] = [];
  const address32 = (address: Address): Hex => pad(address, { size: 32 });
  // The owner's only order brings 5,000 USDC: 1,000 USDC of it could never leave the account.
  const tooLarge: StandingOrder = {
    burnIntent: {
      maxBlockHeight: "62265703",
      maxFee: "30000",
      spec: {
        version: 1,
        sourceDomain: 6,
        destinationDomain: GATEWAY_MAINNET.arcDomain,
        sourceContract: address32(GATEWAY_MAINNET.walletContract),
        destinationContract: address32(GATEWAY_MAINNET.minterContract),
        sourceToken: address32(GATEWAY_MAINNET.sourceUsdc[6]),
        destinationToken: address32(GATEWAY_MAINNET.arcUsdc),
        sourceDepositor: address32(OWNER),
        destinationRecipient: address32(ACCOUNT),
        sourceSigner: address32(OWNER),
        destinationCaller: address32(zeroAddress),
        value: (5_000n * USDC).toString(),
        salt: pad("0x01", { size: 32 }),
        hookData: "0x",
      },
    },
    signature: "0x1234",
  };
  const gateway = new GatewayFunder({
    network: GATEWAY_MAINNET,
    loadOrders: async () => [tooLarge],
    log: (message) => gatewayLogs.push(message),
    dryRun: false,
    fetch: async (url) => {
      submitted.push(url);
      return { ok: true, status: 201, json: async () => ({ transferId: "t1" }) };
    },
  });
  const defended: Address[] = [];
  const { keeper } = setUp(chain, {
    gateway,
    defense: { defend: async (owner) => (defended.push(owner), "raised") },
  });
  await keeper.tick();
  assert.deepEqual(submitted, [], "nothing sent to Gateway");
  assert.ok(gatewayLogs.some((line) => line.includes("skipped: larger than the debt left to repay")));
  assert.deepEqual(defended.map((owner) => owner.toLowerCase()), [OWNER]);
});

test("sweeps a balance under the usual minimum when it is all a position under the minimum needs", async () => {
  // 0.30 USDC of debt at HF 1.20 needs 0.06 USDC to reach 1.5; the account holds 0.08 USDC.
  const position = { healthFactor: (12n * WAD) / 10n, debtUsd: (3n * WAD) / 10n, debtOf: 300_000n };
  const chain = fakeChain({ position, balance: 80_000n, sweepRepays: 80_000n });
  const shortfalls: bigint[] = [];
  const defended: Address[] = [];
  const { keeper, logs } = setUp(chain, {
    wallet: true,
    gateway: { fund: async (_owner, _account, shortfall) => void shortfalls.push(shortfall), isCovering: () => false },
    defense: { defend: async (owner) => (defended.push(owner), "raised") },
  });
  await keeper.tick();
  assert.equal(chain.sent, 1, "the sweep is sent although it repays less than 0.1 USDC");
  assert.ok(logs.some((line) => line.includes("under the minimum, sweeping the balance")));
  assert.deepEqual(shortfalls, [0n]);
  assert.equal(defended.length, 0);
});

test("draws from Gateway when a balance under the usual minimum does not restore the position", async () => {
  const position = { healthFactor: (12n * WAD) / 10n, debtUsd: (3n * WAD) / 10n, debtOf: 300_000n };
  const chain = fakeChain({ position, balance: 50_000n });
  const calls: [bigint, bigint][] = [];
  const { keeper } = setUp(chain, {
    wallet: true,
    gateway: { fund: async (_owner, _account, shortfall, maxDraw) => void calls.push([shortfall, maxDraw]), isCovering: () => false },
  });
  await keeper.tick();
  assert.equal(chain.sent, 0);
  assert.deepEqual(calls, [[10_000n, 250_000n]]);
});

test("sweeps a balance under the usual minimum when the alarm finds it restores the position", async () => {
  const chain = fakeChain({ debt: 6_500n, balance: 50_000n, sweepRepays: 50_000n });
  const { keeper } = setUp(chain, { wallet: true, defense: { defend: async () => "sweep" } });
  await keeper.tick();
  assert.equal(chain.sent, 1);
});

test("still sweeps and raises the alarm, but draws nothing from Gateway, when a venue's debt cannot be read", async () => {
  const chain = fakeChain({ debt: 6_500n, balance: 100n * USDC, debtOfFails: true });
  const calls: [bigint, bigint][] = [];
  const defended: Address[] = [];
  const { keeper, logs } = setUp(chain, {
    wallet: true,
    gateway: { fund: async (_owner, _account, shortfall, maxDraw) => void calls.push([shortfall, maxDraw]), isCovering: () => false },
    defense: { defend: async (owner) => (defended.push(owner), "raised") },
  });
  await keeper.tick();
  assert.equal(chain.sent, 1, "the sweep does not need the debt figure");
  assert.ok(!logs.some((line) => line.includes("check failed")));
  // The fake sweep emptied the account and left the debt: the position is now underfunded.
  await keeper.tick();
  await keeper.tick();
  assert.deepEqual(calls, [[0n, 0n], [0n, 0n], [0n, 0n]], "Gateway is only asked to follow its transfers");
  assert.equal(logs.filter((line) => line.includes("nothing is drawn from Gateway until it can")).length, 1);
  assert.equal(defended.length, 2, "the defense step runs on both underfunded passes");

  chain.debtOfFails = false;
  await keeper.tick();
  assert.deepEqual(calls[3], [1_300n * USDC, 6_500n * USDC]);
  assert.ok(logs.some((line) => line.includes("the debt on every venue can be read again")));
});

test("warns about a position under the minimum that has no USDC debt, and does nothing", async () => {
  // 6,500 USD of debt in another asset on the venue: USDC cannot repay it.
  const position = { healthFactor: (12n * WAD) / 10n, debtUsd: 6_500n * WAD, debtOf: 0n };
  const chain = fakeChain({ position, balance: 0n });
  const shortfalls: bigint[] = [];
  const defended: Address[] = [];
  const { keeper, logs } = setUp(chain, {
    wallet: true,
    gateway: { fund: async (_owner, _account, shortfall) => void shortfalls.push(shortfall), isCovering: () => false },
    defense: { defend: async (owner) => (defended.push(owner), "raised") },
  });
  await keeper.tick();
  assert.ok(logs.some((line) => line.includes("health factor 1.200") && line.includes("WARNING, under the minimum with no USDC debt")));
  assert.ok(!logs.some((line) => line.includes("margin is fine")));
  assert.deepEqual(shortfalls, [0n]);
  assert.equal(defended.length, 0);
  assert.equal(chain.sent, 0);
});

test("still calls Gateway with no shortfall, so transfers on their way are followed", async () => {
  const chain = fakeChain({ debt: 4_000n, balance: 0n });
  const shortfalls: bigint[] = [];
  const { keeper } = setUp(chain, { gateway: { fund: async (_owner, _account, shortfall) => void shortfalls.push(shortfall), isCovering: () => false } });
  await keeper.tick();
  assert.deepEqual(shortfalls, [0n]);
});

test("logs a Gateway failure without stopping the sweep", async () => {
  const chain = fakeChain({ debt: 6_500n });
  const { keeper, logs } = setUp(chain, {
    wallet: true,
    gateway: {
      fund: async () => {
        throw new Error("Gateway unreachable");
      },
      isCovering: () => false,
    },
  });
  await keeper.tick();
  assert.equal(chain.sent, 1);
  assert.ok(logs.some((line) => line.includes("Gateway funding failed: Gateway unreachable")));
});

test("watches every venue: a Morpho position under the minimum needs Gateway even when Aave V4 is fine", async () => {
  const chain = fakeChain({ debt: 0n, secondVenueDebt: 6_500n, balance: 0n });
  const shortfalls: bigint[] = [];
  const { keeper, logs } = setUp(chain, { gateway: { fund: async (_owner, _account, shortfall) => void shortfalls.push(shortfall), isCovering: () => false } });
  await keeper.tick();
  // 6,500 of debt at HF 1.2 back to 1.5: 6,500 - 7,800 / 1.5 = 1,300 USDC.
  assert.deepEqual(shortfalls, [1_300n * USDC]);
  assert.ok(logs.some((line) => line.includes("health factor 1.200") && line.includes("under the minimum")));
});

test("under a simulated drop, sweeps for the venue that falls under the minimum", async () => {
  // Aave V4 at HF 3.9 stays above 1.25 after -40% (2.34); Morpho at 1.95 falls to 1.17.
  const chain = fakeChain({ debt: 2_000n, secondVenueDebt: 4_000n, simulatedDropBps: 4_000n });
  const { keeper, logs } = setUp(chain, { wallet: true });
  await keeper.tick();
  assert.ok(logs.some((line) => line.includes("[SIMULATION] health factor 1.170") && line.includes("under the minimum")));
  assert.equal(chain.sent, 1);
});

test("raises a defense alarm only once Gateway cannot cover an account with nothing to repay with", async () => {
  const chain = fakeChain({ debt: 6_500n, balance: 0n });
  const defended: Address[] = [];
  const gateway = { covering: true };
  const { keeper } = setUp(chain, {
    gateway: { fund: async () => {}, isCovering: () => gateway.covering },
    defense: { defend: async (owner) => (defended.push(owner), "raised") },
  });
  await keeper.tick();
  assert.equal(defended.length, 0, "Gateway is on it");
  gateway.covering = false;
  await keeper.tick();
  assert.deepEqual(defended.map((owner) => owner.toLowerCase()), [OWNER]);
});

test("raises no defense alarm while the margin is fine or the account can still be swept", async () => {
  const defended: Address[] = [];
  const defense: KeeperOptions["defense"] = { defend: async (owner) => (defended.push(owner), "raised") };
  await setUp(fakeChain({ debt: 4_000n, balance: 0n }), { defense }).keeper.tick();
  await setUp(fakeChain({ debt: 6_500n, balance: 100n * USDC }), { defense }).keeper.tick();
  assert.equal(defended.length, 0);
  // Without standing orders configured, the alarm is the next step after the sweep.
  await setUp(fakeChain({ debt: 6_500n, balance: 0n }), { defense }).keeper.tick();
  assert.equal(defended.length, 1);
});

test("sweeps the account when the alarm finds the position healthy once its balance is applied", async () => {
  const chain = fakeChain({ debt: 6_500n, balance: 0n });
  const { keeper } = setUp(chain, { wallet: true, defense: { defend: async () => "sweep" } });
  await keeper.tick();
  assert.equal(chain.sent, 1);
});
