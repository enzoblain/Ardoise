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
function fakeGateway(statuses: Record<string, string> = {}, refuse = false) {
  const submitted: StandingOrder[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    if (init?.method === "POST") {
      if (refuse) return { ok: false, status: 400, json: async () => ({ message: "Insufficient balance" }) };
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
  const instance = new GatewayFunder({
    network: GATEWAY_MAINNET,
    loadOrders: async () => orders,
    log: (message) => logs.push(message),
    dryRun,
    fetch: fetchImpl,
  });
  return { instance, logs };
}

test("accepts an order from the owner's Base balance to the owner's account on Arc", () => {
  assert.equal(rejectReason(order(5n * USDC), OWNER, ACCOUNT, GATEWAY_MAINNET), null);
});

test("accepts plain 20-byte addresses, as Gateway echoes them", () => {
  const plain = order(5n * USDC, { destinationRecipient: ACCOUNT, sourceDepositor: OWNER });
  assert.equal(rejectReason(plain, OWNER, ACCOUNT, GATEWAY_MAINNET), null);
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

test("picks the fewest orders that cover the shortfall, or all of them when they fall short", () => {
  const small = order(2n * USDC);
  const medium = order(5n * USDC);
  const large = order(10n * USDC);
  assert.deepEqual(selectOrders([small, medium, large], 4n * USDC), [large]);
  assert.deepEqual(selectOrders([small, medium, large], 12n * USDC), [large, medium]);
  assert.deepEqual(selectOrders([small, medium], 50n * USDC), [medium, small]);
  assert.deepEqual(selectOrders([small], 0n), []);
});

test("parses orders and rejects malformed entries", () => {
  const valid = order(USDC);
  assert.deepEqual(parseOrders(JSON.parse(JSON.stringify([valid]))), [valid]);
  assert.throws(() => parseOrders({}), /array/);
  assert.throws(() => parseOrders([{ ...valid, signature: "nope" }]), /order 0/);
  const badValue = { ...valid, burnIntent: { ...valid.burnIntent, maxFee: "1e5" } };
  assert.throws(() => parseOrders([valid, badValue]), /order 1/);
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

  statuses.t1 = "confirmed";
  statuses.t2 = "confirmed";
  await instance.fund(OWNER, ACCOUNT, 3n * USDC);
  assert.ok(logs.some((line) => line.includes("delivered on Arc in 0xabc")));
  // A new shortfall after delivery uses the last unused order, never a used one.
  assert.equal(gateway.submitted.length, 3);
  assert.equal(new Set(gateway.submitted.map((o) => o.burnIntent.spec.salt)).size, 3);

  statuses.t3 = "confirmed";
  await instance.fund(OWNER, ACCOUNT, 3n * USDC);
  assert.ok(logs.some((line) => line.includes("no standing order left")));
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

test("logs a refused order and does not retry it", async () => {
  const gateway = fakeGateway({}, true);
  const { instance, logs } = funder(gateway.fetchImpl, [order(5n * USDC)]);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  await instance.fund(OWNER, ACCOUNT, 5n * USDC);
  assert.ok(logs.some((line) => line.includes("Insufficient balance")));
  assert.ok(logs.some((line) => line.includes("no standing order left")));
});
