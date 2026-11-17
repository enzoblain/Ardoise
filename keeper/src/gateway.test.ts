import assert from "node:assert/strict";
import { test } from "node:test";

import { pad, type Address, type Hex } from "viem";

import {
  GATEWAY_MAINNET,
  GatewayFunder,
  parseOrders,
  rejectReason,
  selectOrders,
  transferStatus,
  type Fetch,
  type StandingOrder,
} from "./gateway.js";

const OWNER: Address = "0x00000000000000000000000000000000000000a1";
const ACCOUNT: Address = "0x00000000000000000000000000000000000000c1";
const OTHER: Address = "0x00000000000000000000000000000000000000e1";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC = 1_000_000n;

const b32 = (address: Address): Hex => pad(address.toLowerCase() as Address, { size: 32 });
let saltCounter = 0;

/** A valid order from OWNER's Gateway balance on Base to ACCOUNT on Arc. */
function order(value: bigint, overrides: Partial<StandingOrder["burnIntent"]["spec"]> = {}): StandingOrder {
  saltCounter += 1;
  return {
    burnIntent: {
      maxBlockHeight: "62265703",
      maxFee: "30000",
      spec: {
        version: 1,
        sourceDomain: 6,
        destinationDomain: 26,
        sourceContract: b32(GATEWAY_MAINNET.walletContract),
        destinationContract: b32(GATEWAY_MAINNET.minterContract),
        sourceToken: b32(BASE_USDC),
        destinationToken: b32(GATEWAY_MAINNET.arcUsdc),
        sourceDepositor: b32(OWNER),
        destinationRecipient: b32(ACCOUNT),
        sourceSigner: b32(OWNER),
        destinationCaller: b32("0x0000000000000000000000000000000000000000"),
        value: value.toString(),
        salt: pad(`0x${saltCounter.toString(16)}`, { size: 32 }),
        hookData: "0x",
        ...overrides,
      },
    },
    signature: "0x1234",
  };
}

/** Fake Gateway API: records requests, answers transfers with ids and statuses from `statuses`. */
function fakeGateway(statuses: Record<string, string> = {}, refusal: string | null = null) {
  const submitted: StandingOrder[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    if (init?.method === "POST") {
      if (refusal !== null) return { ok: false, status: 400, json: async () => ({ message: refusal }) };
      const [sent] = JSON.parse(init.body!) as StandingOrder[];
      submitted.push(sent);
      return { ok: true, status: 201, json: async () => ({ transferId: `t${submitted.length}` }) };
    }
    const id = url.split("/").pop()!;
    return { ok: true, status: 200, json: async () => ({ status: statuses[id] ?? "pending", transactionHash: "0xabc" }) };
  };
  return { submitted, fetchImpl };
}

function funder(fetchImpl: Fetch, orders: StandingOrder[], dryRun = false) {
  const logs: string[] = [];
  const clock = { now: 0 };
  const instance = new GatewayFunder({
    network: GATEWAY_MAINNET,
    loadOrders: async () => orders,
    log: (message) => logs.push(message),
    dryRun,
    fetch: fetchImpl,
    now: () => clock.now,
    requestTimeoutMs: 20,
  });
  return { instance, logs, clock };
}

test("accepts an order from the owner's Base balance to the owner's account on Arc", () => {
  assert.equal(rejectReason(order(5n * USDC), OWNER, ACCOUNT, GATEWAY_MAINNET), null);
});

test("rejects 20-byte addresses in bytes32 fields, which are ambiguous once encoded", () => {
  const plain = order(5n * USDC, { destinationRecipient: ACCOUNT });
  assert.match(rejectReason(plain, OWNER, ACCOUNT, GATEWAY_MAINNET) ?? "accepted", /recipient/);
  assert.deepEqual(parseOrders([plain]), []);
});

test("ignores the checksum case of addresses instead of throwing", () => {
  const mixed = order(5n * USDC, { destinationRecipient: `0x000000000000000000000000${"aBcD".repeat(10)}` });
  assert.match(rejectReason(mixed, OWNER, ACCOUNT, GATEWAY_MAINNET) ?? "accepted", /recipient/);
});

test("rejects orders that would send funds anywhere but the owner's account", () => {
  const cases: [Partial<StandingOrder["burnIntent"]["spec"]>, RegExp][] = [
    [{ destinationRecipient: b32(OTHER) }, /recipient/],
    [{ sourceDepositor: b32(OTHER) }, /depositor/],
    [{ destinationDomain: 6 }, /not Arc/],
    [{ sourceDomain: 3 }, /source domain/],
    [{ sourceContract: b32(OTHER) }, /GatewayWallet/],
    [{ destinationContract: b32(OTHER) }, /GatewayMinter/],
    [{ sourceToken: b32(OTHER) }, /source token/],
    [{ destinationToken: b32(OTHER) }, /destination token/],
    [{ destinationCaller: b32(OTHER) }, /caller/],
    [{ hookData: "0x01" }, /hook/],
    [{ value: "0" }, /zero/],
    [{ version: 2 }, /version/],
    [{ destinationRecipient: `0x${"ff".repeat(32)}` }, /recipient/],
  ];
  for (const [overrides, reason] of cases) {
    assert.match(rejectReason(order(USDC, overrides), OWNER, ACCOUNT, GATEWAY_MAINNET) ?? "accepted", reason);
  }
});

test("picks the smallest order covering the shortfall, else the fewest, else all of them", () => {
  const small = order(2n * USDC);
  const medium = order(5n * USDC);
  const large = order(10n * USDC);
  assert.deepEqual(selectOrders([small, medium, large], 4n * USDC), [medium]);
  assert.deepEqual(selectOrders([small, order(100n * USDC)], 1n * USDC), [small]);
  assert.deepEqual(selectOrders([small, medium, large], 12n * USDC), [large, medium]);
  assert.deepEqual(selectOrders([small, medium], 50n * USDC), [medium, small]);
  assert.deepEqual(selectOrders([small], 0n), []);
});

test("parses orders and skips malformed entries without dropping the others", () => {
  const valid = order(USDC);
  assert.deepEqual(parseOrders(JSON.parse(JSON.stringify([valid]))), [valid]);
  assert.throws(() => parseOrders({}), /array/);
  const skipped: number[] = [];
  const badValue = { ...valid, burnIntent: { ...valid.burnIntent, maxFee: "1e5" } };
  const parsed = parseOrders([{ ...valid, signature: "nope" }, valid, badValue], (index) => skipped.push(index));
  assert.deepEqual(parsed, [valid]);
  assert.deepEqual(skipped, [0, 2]);
});

test("maps Gateway statuses", async () => {
  const { fetchImpl } = fakeGateway({ a: "confirmed", b: "finalized", c: "failed", d: "expired", e: "attested" });
  assert.equal((await transferStatus("a", GATEWAY_MAINNET, fetchImpl)).state, "delivered");
  assert.equal((await transferStatus("b", GATEWAY_MAINNET, fetchImpl)).state, "delivered");
  assert.equal((await transferStatus("c", GATEWAY_MAINNET, fetchImpl)).state, "failed");
  assert.equal((await transferStatus("d", GATEWAY_MAINNET, fetchImpl)).state, "failed");
  assert.equal((await transferStatus("e", GATEWAY_MAINNET, fetchImpl)).state, "pending");
});

test("submits orders for a shortfall, waits while they are on their way, then can fund again", async () => {
  const orders = [order(5n * USDC), order(5n * USDC), order(5n * USDC)];
  const statuses: Record<string, string> = {};
  const gateway = fakeGateway(statuses);
  const { instance, logs } = funder(gateway.fetchImpl, orders);

  await instance.fund(OWNER, ACCOUNT, 8n * USDC);
  assert.equal(gateway.submitted.length, 2);
  assert.ok(logs.some((line) => line.includes("drawing 5 USDC from Gateway, transfer t1")));

  // Still on its way: the same shortfall must not draw again.
  await instance.fund(OWNER, ACCOUNT, 8n * USDC);
  assert.equal(gateway.submitted.length, 2);

  // Delivered during this pass: the shortfall was computed before the USDC
  // arrived, so nothing new is drawn on this pass.
  statuses.t1 = "confirmed";
  statuses.t2 = "confirmed";
  await instance.fund(OWNER, ACCOUNT, 8n * USDC);
  assert.ok(logs.some((line) => line.includes("delivered on Arc in 0xabc")));
  assert.equal(gateway.submitted.length, 2);

  // The next pass decides on the fresh balance and uses the last unused order.
  await instance.fund(OWNER, ACCOUNT, 3n * USDC);
  assert.equal(gateway.submitted.length, 3);
  assert.equal(new Set(gateway.submitted.map((o) => o.burnIntent.spec.salt)).size, 3);

  statuses.t3 = "confirmed";
  await instance.fund(OWNER, ACCOUNT, 3n * USDC);
  await instance.fund(OWNER, ACCOUNT, 3n * USDC);
  assert.ok(logs.some((line) => line.includes("no standing order available")));
});

test("does nothing without a shortfall and ignores orders for other accounts or with a bad field", async () => {
  const foreign = order(5n * USDC, { destinationRecipient: b32(OTHER) });
  const wrongDepositor = order(5n * USDC, { sourceDepositor: b32(OTHER) });
  const gateway = fakeGateway();
  const { instance, logs } = funder(gateway.fetchImpl, [foreign, wrongDepositor]);

  await instance.fund(OWNER, ACCOUNT, 0n);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.equal(gateway.submitted.length, 0);
  assert.ok(logs.some((line) => line.includes("depositor is not the account owner")));
  assert.ok(!logs.some((line) => line.includes(foreign.burnIntent.spec.salt)));
});

test("submits nothing in a dry run", async () => {
  const gateway = fakeGateway();
  const { instance, logs } = funder(gateway.fetchImpl, [order(5n * USDC)], true);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.equal(gateway.submitted.length, 0);
  assert.ok(logs.some((line) => line.includes("dry run")));
});

test("retries an order refused for a lack of balance after a delay, and drops a spent one", async () => {
  const gateway = fakeGateway({}, "Insufficient balance");
  const { instance, logs, clock } = funder(gateway.fetchImpl, [order(5n * USDC)]);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.ok(logs.some((line) => line.includes("Insufficient balance") && line.includes("retrying in 1 min")));
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.ok(logs.some((line) => line.includes("no standing order available")), "on hold within the delay");

  const spent = fakeGateway({}, "Salt has already been used");
  const second = funder(spent.fetchImpl, [order(5n * USDC)]);
  await second.instance.fund(OWNER, ACCOUNT, 5n * USDC);
  second.clock.now = 10 * 3_600_000;
  await second.instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.ok(second.logs.some((line) => line.includes("already used")));
  assert.ok(second.logs.some((line) => line.includes("no standing order available")));

  clock.now = 60_000;
  const before = logs.length;
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.ok(logs.slice(before).some((line) => line.includes("Insufficient balance")), "retried after the delay");
});

test("does not hang when Gateway never answers", async () => {
  const hanging: Fetch = (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  const { instance, logs } = funder(hanging, [order(5n * USDC)]);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.ok(logs.some((line) => line.includes("not used") && line.includes("retrying")));
});

test("gives up on a transfer that is never delivered", async () => {
  const gateway = fakeGateway();
  const { instance, logs, clock } = funder(gateway.fetchImpl, [order(5n * USDC), order(5n * USDC)]);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  clock.now = 31 * 60_000;
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.ok(logs.some((line) => line.includes("not delivered after 30 min")));
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.equal(gateway.submitted.length, 2);
});

test("keeps two owners' orders apart even with the same salt", async () => {
  const OTHER_ACCOUNT: Address = "0x00000000000000000000000000000000000000c2";
  const salt = pad("0x77", { size: 32 });
  const mine = order(5n * USDC, { salt });
  const theirs = order(5n * USDC, { salt, sourceDepositor: b32(OTHER), destinationRecipient: b32(OTHER_ACCOUNT) });
  const gateway = fakeGateway();
  const { instance } = funder(gateway.fetchImpl, [mine, theirs]);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  await instance.fund(OTHER, OTHER_ACCOUNT, 5n * USDC);
  assert.equal(gateway.submitted.length, 2);
});
