import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  numberToHex,
  parseAbi,
  zeroHash,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { arc, base } from "viem/chains";

import { defenseAlarmAbi, defenseRelayAbi } from "./abis.js";
import { DefenseRelay, MESSAGE_TRANSMITTER_V2, fetchAttestation, type DefenseOutcome } from "./defense.js";
import type { Fetch } from "./gateway.js";

const ALARM: Address = "0x00000000000000000000000000000000000000d1";
const OWNER: Address = "0x00000000000000000000000000000000000000a1";
const ACCOUNT: Address = "0x00000000000000000000000000000000000000a2";
const KEEPER: Address = "0x00000000000000000000000000000000000000b1";
const RAISE_TX: Hash = `0x${"aa".repeat(32)}`;
const RELAY_TX: Hash = `0x${"bb".repeat(32)}`;
const MESSAGE: Hex = `0x${"12".repeat(148)}`;
const ATTESTATION: Hex = `0x${"34".repeat(130)}`;

/** Start of every test, in seconds; the alarm is valid 900 s from there. */
const START = 1_800_000_000n;
const EXPIRY = START + 900n;
const NONCE = 7n;

type Revert = { errorName: string; args: readonly unknown[] } | Error;

/** Scripted answers of Arc, Base and Iris, and what the relay did with them. */
interface Fake {
  /** Revert of the `raise` simulation, or `null` for success. */
  raiseRevert: Revert | null;
  /** Reverts of successive `receiveMessage` simulations; success once empty. */
  relayReverts: Revert[];
  /** Successive Iris answers; the last one repeats. */
  iris: ({ status: number; body?: unknown })[];
  irisUrls: string[];
  raiseSimulations: number;
  raisesSent: number;
  relaysSent: { message: Hex; attestation: Hex }[];
  /** Status of the Base receipt. */
  relayReceipt: "success" | "reverted";
  /** Receipt queries answered "not found" before the receipt shows, on each chain. */
  arcReceiptMissing: number;
  baseReceiptMissing: number;
  /** Gas limit of each `receiveMessage` sent. */
  relayGas: bigint[];
}

function fake(overrides: Partial<Fake> = {}): Fake {
  return {
    raiseRevert: null,
    relayReverts: [],
    iris: [{ status: 200, body: complete() }],
    irisUrls: [],
    raiseSimulations: 0,
    raisesSent: 0,
    relaysSent: [],
    relayReceipt: "success",
    arcReceiptMissing: 0,
    baseReceiptMissing: 0,
    relayGas: [],
    ...overrides,
  };
}

function complete() {
  return { messages: [{ message: MESSAGE, attestation: ATTESTATION, status: "complete", eventNonce: "0x1" }] };
}

function pending() {
  return { messages: [{ message: MESSAGE, attestation: "PENDING", status: "pending_confirmations" }] };
}

/** An RPC error carrying a revert, as nodes return it. */
function rpcRevert(revert: Revert, abi: Parameters<typeof encodeErrorResult>[0]["abi"]): Error {
  if (revert instanceof Error) return revert;
  const data = encodeErrorResult({ abi, errorName: revert.errorName, args: revert.args } as Parameters<typeof encodeErrorResult>[0]);
  return Object.assign(new Error("execution reverted"), { code: 3, data });
}

const errorStringAbi = parseAbi(["error Error(string)"]);

function receipt(hash: Hash, status: "success" | "reverted", logs: unknown[]) {
  return {
    transactionHash: hash,
    status: status === "success" ? "0x1" : "0x0",
    blockNumber: "0x10",
    blockHash: zeroHash,
    transactionIndex: "0x0",
    from: KEEPER,
    to: ALARM,
    contractAddress: null,
    cumulativeGasUsed: "0x1",
    gasUsed: "0x1",
    effectiveGasPrice: "0x1",
    logs,
    logsBloom: `0x${"00".repeat(256)}`,
    type: "0x2",
  };
}

function log(address: Address, topics: Hex[], data: Hex) {
  return {
    address,
    topics,
    data,
    blockNumber: "0x10",
    blockHash: zeroHash,
    transactionHash: zeroHash,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

function setUp(state: Fake, options: { wallet?: boolean } = { wallet: true }) {
  const clock = { now: Number(START) * 1000 };
  const sleeps: number[] = [];

  const arcClient = createPublicClient({
    chain: arc,
    pollingInterval: 1,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params: any }) {
          switch (method) {
            case "eth_chainId":
              return numberToHex(arc.id);
            case "eth_blockNumber":
              return "0x10";
            case "eth_estimateGas":
              return "0x30d40";
            case "eth_call": {
              const { functionName } = decodeFunctionData({ abi: defenseAlarmAbi, data: params[0].data });
              if (functionName === "cooldown") {
                return encodeFunctionResult({ abi: defenseAlarmAbi, functionName, result: START + 1_800n });
              }
              state.raiseSimulations += 1;
              if (state.raiseRevert !== null) throw rpcRevert(state.raiseRevert, defenseAlarmAbi);
              return encodeFunctionResult({ abi: defenseAlarmAbi, functionName: "raise", result: NONCE });
            }
            case "eth_getTransactionByHash":
              return null;
            case "eth_getTransactionReceipt":
              if (state.arcReceiptMissing > 0) {
                state.arcReceiptMissing -= 1;
                return null;
              }
              return receipt(RAISE_TX, "success", [
                log(
                  ALARM,
                  encodeEventTopics({ abi: defenseAlarmAbi, eventName: "AlarmRaised", args: { owner: OWNER, account: ACCOUNT } }) as Hex[],
                  encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }, { type: "uint64" }], [1_300_000n, NONCE, EXPIRY]),
                ),
              ]);
            default:
              throw new Error(`unexpected Arc RPC method ${method}`);
          }
        },
      },
      { retryCount: 0 },
    ),
  });

  const baseClient = createPublicClient({
    // Widened as index.ts does: Base's OP-stack formatters make a narrower client type.
    chain: base as Chain,
    pollingInterval: 1,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method }: { method: string }) {
          switch (method) {
            case "eth_chainId":
              return numberToHex(base.id);
            case "eth_blockNumber":
              return "0x20";
            case "eth_call": {
              const revert = state.relayReverts.shift();
              if (revert !== undefined) throw rpcRevert(revert, [...defenseRelayAbi, ...errorStringAbi]);
              return encodeFunctionResult({ abi: defenseRelayAbi, functionName: "receiveMessage", result: true });
            }
            case "eth_getTransactionByHash":
              return null;
            case "eth_estimateGas":
              return numberToHex(200_000n);
            case "eth_getTransactionReceipt":
              if (state.baseReceiptMissing > 0) {
                state.baseReceiptMissing -= 1;
                return null;
              }
              return receipt(RELAY_TX, state.relayReceipt, [
                log(
                  "0x00000000000000000000000000000000000000e1",
                  encodeEventTopics({
                    abi: defenseRelayAbi,
                    eventName: "DefenseExecuted",
                    args: { owner: OWNER, account: ACCOUNT, nonce: NONCE },
                  }) as Hex[],
                  encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1_330_000n, 30_000n]),
                ),
              ]);
            default:
              throw new Error(`unexpected Base RPC method ${method}`);
          }
        },
      },
      { retryCount: 0 },
    ),
  });

  const arcWallet = {
    account: { address: KEEPER, type: "json-rpc" },
    writeContract: async (request: { functionName: string; args: readonly unknown[] }) => {
      assert.equal(request.functionName, "raise");
      assert.deepEqual(request.args, [OWNER]);
      state.raisesSent += 1;
      return RAISE_TX;
    },
  } as unknown as WalletClient<Transport, Chain, Account>;

  const baseWallet = {
    account: { address: KEEPER, type: "json-rpc" },
    writeContract: async (request: { address: Address; functionName: string; args: readonly [Hex, Hex]; gas: bigint }) => {
      assert.equal(request.address, MESSAGE_TRANSMITTER_V2);
      state.relayGas.push(request.gas);
      assert.equal(request.functionName, "receiveMessage");
      state.relaysSent.push({ message: request.args[0], attestation: request.args[1] });
      return RELAY_TX;
    },
  } as unknown as WalletClient<Transport, Chain, Account>;

  const fetchImpl: Fetch = async (url) => {
    state.irisUrls.push(url);
    const answer = state.iris.length > 1 ? state.iris.shift()! : state.iris[0];
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body ?? null };
  };

  const logs: string[] = [];
  const relay = new DefenseRelay({
    arcClient,
    arcWallet: options.wallet ? arcWallet : null,
    baseClient,
    baseWallet: options.wallet ? baseWallet : null,
    alarm: ALARM,
    log: (message) => logs.push(message),
    fetch: fetchImpl,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  return { relay, logs, clock, sleeps };
}

test("raises the alarm, waits for Circle's attestation and relays the message unchanged to Base", async () => {
  const state = fake({ iris: [{ status: 404 }, { status: 200, body: pending() }, { status: 200, body: complete() }] });
  const { relay, logs, sleeps } = setUp(state);
  const outcome: DefenseOutcome = await relay.defend(OWNER);
  assert.equal(outcome, "raised");
  await relay.idle();

  assert.equal(state.raisesSent, 1);
  assert.equal(state.irisUrls[0], `https://iris-api.circle.com/v2/messages/26?transactionHash=${RAISE_TX}`);
  assert.deepEqual(sleeps, [2_000, 4_000], "polled again with a growing delay");
  assert.deepEqual(state.relaysSent, [{ message: MESSAGE, attestation: ATTESTATION }]);
  assert.ok(logs.some((line) => line.includes("alarm #7 raised for 1.3 USDC")));
  assert.ok(logs.some((line) => line.includes("delivered on Base") && line.includes("burned 1.33 USDC")));
});

test("does not raise again while a relay runs or during the alarm's cooldown", async () => {
  const state = fake({ iris: [{ status: 404 }, { status: 200, body: complete() }] });
  const { relay, clock } = setUp(state);
  assert.equal(await relay.defend(OWNER), "raised");
  assert.equal(await relay.defend(OWNER), "waiting", "relay running");
  await relay.idle();
  assert.equal(await relay.defend(OWNER), "waiting", "cooldown read after the raise");
  assert.equal(state.raiseSimulations, 1);
  assert.equal(state.raisesSent, 1);

  clock.now = Number(START + 1_800n) * 1000;
  state.raiseRevert = { errorName: "PositionHealthy", args: [OWNER] };
  assert.equal(await relay.defend(OWNER), "sweep", "simulated again once the cooldown is over");
});

test("waits for the time a CoolingDown revert names, without sending anything", async () => {
  const state = fake({ raiseRevert: { errorName: "CoolingDown", args: [START + 600n] } });
  const { relay, logs, clock } = setUp(state);
  assert.equal(await relay.defend(OWNER), "waiting");
  assert.equal(await relay.defend(OWNER), "waiting");
  assert.equal(state.raiseSimulations, 1, "no simulation before nextAllowed");
  assert.equal(state.raisesSent, 0);
  assert.equal(logs.filter((line) => line.includes("cooling down until")).length, 1);

  clock.now = Number(START + 600n) * 1000;
  state.raiseRevert = null;
  assert.equal(await relay.defend(OWNER), "raised");
  await relay.idle();
});

test("asks for a sweep when the alarm finds the position healthy once the balance is applied", async () => {
  const state = fake({ raiseRevert: { errorName: "PositionHealthy", args: [OWNER] } });
  const { relay } = setUp(state);
  assert.equal(await relay.defend(OWNER), "sweep");
  assert.equal(state.raisesSent, 0);
});

test("holds raise after another revert, with a growing delay", async () => {
  const state = fake({ raiseRevert: { errorName: "ExecutorNotSet", args: [] } });
  const { relay, logs, clock } = setUp(state);
  assert.equal(await relay.defend(OWNER), "failed");
  assert.ok(logs.some((line) => line.includes("ExecutorNotSet") && line.includes("in 1 min")));
  assert.equal(await relay.defend(OWNER), "waiting");
  clock.now += 60_000;
  assert.equal(await relay.defend(OWNER), "failed");
  assert.ok(logs.some((line) => line.includes("in 2 min")));
  assert.equal(state.raiseSimulations, 2);
});

test("only logs the alarm it would raise in a dry run", async () => {
  const state = fake();
  const { relay, logs } = setUp(state, { wallet: false });
  assert.equal(await relay.defend(OWNER), "dry-run");
  assert.equal(state.raisesSent, 0);
  assert.ok(logs.some((line) => line.includes("would raise defense alarm #7")));
});

test("gives up polling Iris once the alarm expires", async () => {
  const state = fake({ iris: [{ status: 200, body: pending() }] });
  const { relay, logs, clock } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.ok(clock.now >= Number(EXPIRY) * 1000);
  assert.ok(logs.some((line) => line.includes("expired before Circle attested it")));
  assert.equal(state.relaysSent.length, 0);
});

test("keeps polling Iris through a rate limit", async () => {
  const state = fake({ iris: [{ status: 429 }, { status: 200, body: complete() }] });
  const { relay, logs } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.ok(logs.some((line) => line.includes("Iris answered 429")));
  assert.equal(state.relaysSent.length, 1);
});

test("relays again at the time a TooSoon revert names while the alarm is valid", async () => {
  const nextAllowed = START + 300n;
  const state = fake({ relayReverts: [{ errorName: "TooSoon", args: [OWNER, nextAllowed] }] });
  const { relay, logs, clock } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.ok(logs.some((line) => line.includes("too recent, delivering again")));
  assert.ok(clock.now >= Number(nextAllowed) * 1000);
  assert.equal(state.relaysSent.length, 1);
});

test("waits at least 5 s after TooSoon when the local clock is already past nextAllowed", async () => {
  const state = fake({ relayReverts: [{ errorName: "TooSoon", args: [OWNER, START - 60n] }] });
  const { relay, sleeps } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(state.relaysSent.length, 1);
});

test("retries a SwapOutOfGas revert like any other failure", async () => {
  const state = fake({ relayReverts: [{ errorName: "SwapOutOfGas", args: [] }] });
  const { relay, logs, sleeps } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.ok(logs.some((line) => line.includes("failed (SwapOutOfGas), retrying in 5 s")));
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(state.relaysSent.length, 1);
});

test("gives up when TooSoon names a time after the alarm expires", async () => {
  const state = fake({ relayReverts: [{ errorName: "TooSoon", args: [OWNER, EXPIRY] }] });
  const { relay, logs } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.ok(logs.some((line) => line.includes("after the alarm expires; giving up")));
  assert.equal(state.relaysSent.length, 0);
});

test("treats an alarm or message already delivered as done", async () => {
  for (const revert of [
    { errorName: "AlarmAlreadyUsed", args: [NONCE] },
    { errorName: "Error", args: ["Nonce already used"] },
  ]) {
    const state = fake({ relayReverts: [revert] });
    const { relay, logs, sleeps } = setUp(state);
    await relay.defend(OWNER);
    await relay.idle();
    assert.ok(logs.some((line) => line.includes("already delivered on Base")), revert.errorName);
    assert.equal(state.relaysSent.length, 0);
    assert.deepEqual(sleeps, []);
  }
});

test("retries a failed delivery with a growing delay, then gives up", async () => {
  const state = fake({ relayReverts: [new Error("Base RPC unreachable"), { errorName: "StalePrice", args: [ALARM] }] });
  const { relay, logs, sleeps } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.deepEqual(sleeps, [5_000, 10_000]);
  assert.ok(logs.some((line) => line.includes("failed (StalePrice), retrying in 10 s")));
  assert.equal(state.relaysSent.length, 1);

  const failing = fake({ relayReceipt: "reverted" });
  const second = setUp(failing);
  await second.relay.defend(OWNER);
  await second.relay.idle();
  assert.equal(failing.relaysSent.length, 5);
  assert.ok(second.logs.some((line) => line.includes("failed 5 times") && line.includes("giving up")));
});

test("sends receiveMessage with gas headroom over the estimate", async () => {
  const state = fake();
  const { relay } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  // 200,000 estimated, +50%: a swap skipped for lack of gas would consume the alarm.
  assert.deepEqual(state.relayGas, [300_000n]);
});

test("keeps following a slow raise, holding the owner, and relays it once mined", async () => {
  const state = fake({ arcReceiptMissing: 4 });
  const { relay, logs } = setUp(state);
  assert.equal(await relay.defend(OWNER), "raised");
  assert.equal(await relay.defend(OWNER), "waiting", "on hold while the raise is pending");
  await relay.idle();
  assert.equal(state.raiseSimulations, 1);
  assert.equal(state.raisesSent, 1);
  assert.ok(logs.some((line) => line.includes("alarm #7 raised")));
  assert.equal(state.relaysSent.length, 1);
});

test("treats a raise without receipt after the deadline as lost and holds the owner", async () => {
  const state = fake({ arcReceiptMissing: Number.POSITIVE_INFINITY });
  const { relay, logs } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.ok(logs.some((line) => line.includes("no receipt after 5 min, treating it as lost")));
  assert.equal(await relay.defend(OWNER), "waiting", "held after the loss");
  assert.equal(state.raisesSent, 1);
  assert.equal(state.relaysSent.length, 0);
});

test("follows a slow receiveMessage instead of sending it again", async () => {
  const state = fake({ baseReceiptMissing: 4 });
  const { relay, logs } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.equal(state.relaysSent.length, 1);
  assert.ok(logs.some((line) => line.includes("delivered on Base")));
});

test("retries failed simulations on Base until the alarm expires, without a cap", async () => {
  const stale = { errorName: "StalePrice", args: [ALARM] };
  const state = fake({ relayReverts: Array.from({ length: 8 }, () => stale) });
  const { relay, sleeps } = setUp(state);
  await relay.defend(OWNER);
  await relay.idle();
  assert.equal(state.relaysSent.length, 1, "delivered after 8 failed simulations");
  assert.deepEqual(sleeps, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);

  const never = fake({ relayReverts: Array.from({ length: 1_000 }, () => stale) });
  const second = setUp(never);
  await second.relay.defend(OWNER);
  await second.relay.idle();
  assert.equal(never.relaysSent.length, 0);
  assert.ok(second.logs.some((line) => line.includes("expired before it could be delivered on Base")));
});

test("reads Iris answers", async () => {
  const answer = (status: number, body?: unknown): Fetch => async () => ({ ok: status === 200, status, json: async () => body });
  assert.equal(await fetchAttestation("https://iris", RAISE_TX, answer(404)), null);
  assert.equal(await fetchAttestation("https://iris", RAISE_TX, answer(200, pending())), null);
  assert.equal(await fetchAttestation("https://iris", RAISE_TX, answer(200, { messages: [] })), null);
  assert.deepEqual(await fetchAttestation("https://iris", RAISE_TX, answer(200, complete())), {
    message: MESSAGE,
    attestation: ATTESTATION,
  });
  await assert.rejects(fetchAttestation("https://iris", RAISE_TX, answer(500)), /Iris answered 500/);
  await assert.rejects(
    fetchAttestation("https://iris", RAISE_TX, answer(200, { messages: [{ status: "complete", attestation: "PENDING" }] })),
    /without its bytes/,
  );
});
