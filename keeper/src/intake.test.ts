import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pad, verifyTypedData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { GATEWAY_MAINNET, type StandingOrder } from "./gateway.js";
import {
  MAX_ORDERS_PER_OWNER,
  MAX_ORDERS_PER_REQUEST,
  acceptOrders,
  burnIntentTypedData,
  startIntake,
  type IntakeChecks,
} from "./intake.js";

/** Throwaway key made for this run, so that no key is written in the repository. */
const signer = privateKeyToAccount(generatePrivateKey());
const OWNER = signer.address;
const ACCOUNT: Address = "0x00000000000000000000000000000000000000c1";
const OTHER: Address = "0x00000000000000000000000000000000000000e1";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const b32 = (address: Address): Hex => pad(address.toLowerCase() as Address, { size: 32 });
let salt = 0;

async function signedOrder(overrides: Partial<StandingOrder["burnIntent"]["spec"]> = {}): Promise<StandingOrder> {
  salt += 1;
  const unsigned: StandingOrder = {
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
        value: "5000000",
        salt: pad(`0x${salt.toString(16)}`, { size: 32 }),
        hookData: "0x",
        ...overrides,
      },
    },
    signature: "0x",
  };
  return { ...unsigned, signature: await signer.signTypedData(burnIntentTypedData(unsigned)) };
}

/** Orders the fake funder has used, by salt. */
const used = new Set<string>();

/** Checks backed by a fixed account map, a local EIP-712 verification and Base at block 60M. */
const checks: IntakeChecks = {
  accountOf: async (owner) => (owner === OWNER ? ACCOUNT : null),
  verifySignature: (order, depositor) =>
    verifyTypedData({ address: depositor, signature: order.signature, ...burnIntentTypedData(order) }),
  isContract: async () => false,
  sourceBlockNumber: async () => 60_000_000n,
  isUsed: (order) => used.has(order.burnIntent.spec.salt),
};

test("a burn intent signed by the depositor verifies against the typed data the keeper rebuilds", async () => {
  const order = await signedOrder();
  assert.equal(await checks.verifySignature(order, OWNER), true);
  assert.equal(await checks.verifySignature({ ...order, burnIntent: { ...order.burnIntent, maxFee: "1" } }, OWNER), false);
});

test("accepts orders to the depositor's own account and skips duplicates", async () => {
  const order = await signedOrder();
  const first = await acceptOrders(JSON.parse(JSON.stringify([order])), [], GATEWAY_MAINNET, checks);
  assert.deepEqual(first.results, [{ index: 0, status: "accepted" }]);
  const again = await acceptOrders([order], first.orders, GATEWAY_MAINNET, checks);
  assert.deepEqual(again.results, [{ index: 0, status: "duplicate" }]);
  assert.equal(again.orders.length, 1);
});

test("flags a deployed smart account's orders for ERC-1271 from the chain, whatever the sender claims", async () => {
  const order = await signedOrder();
  const contractChecks: IntakeChecks = { ...checks, isContract: async () => true };
  const flagged = await acceptOrders([order], [], GATEWAY_MAINNET, contractChecks);
  assert.deepEqual(flagged.results, [{ index: 0, status: "accepted" }]);
  assert.equal(flagged.orders[0].contractSigner, true);
  const claimed = await acceptOrders([{ ...order, contractSigner: true }], [], GATEWAY_MAINNET, checks);
  assert.equal(claimed.orders[0].contractSigner, undefined);
});

test("refuses ERC-6492 signatures, which Gateway cannot check, before or after the deployment", async () => {
  const order = await signedOrder();
  // An ERC-6492 signature verifies for an undeployed account, but isValidSignature does not unwrap it.
  const wrapped = { ...order, signature: `${order.signature}${"00".repeat(64)}6492649264926492649264926492649264926492649264926492649264926492` as Hex };
  const verifying = { ...checks, verifySignature: async () => true };
  const before = await acceptOrders([wrapped], [], GATEWAY_MAINNET, verifying);
  assert.match((before.results[0] as { reason: string }).reason, /not deployed/);
  const after = await acceptOrders([wrapped], [], GATEWAY_MAINNET, { ...verifying, isContract: async () => true });
  assert.match((after.results[0] as { reason: string }).reason, /sign it again/);
  assert.equal(after.orders.length, 0);
});

test("rejects orders that do not pay the depositor's account, are forged or come from someone without an account", async () => {
  const toOther = await signedOrder({ destinationRecipient: b32(OTHER) });
  const forged = { ...(await signedOrder()), signature: (await signedOrder()).signature };
  const stranger = await signedOrder({ sourceDepositor: b32(OTHER), sourceSigner: b32(OTHER) });
  const { orders, results } = await acceptOrders([toOther, forged, stranger, { nope: 1 }], [], GATEWAY_MAINNET, checks);
  assert.equal(orders.length, 0);
  assert.deepEqual(
    results.map((r) => (r.status === "rejected" ? r.reason : r.status)),
    [
      "recipient is not the Ardoise account",
      "the signature is not the depositor's",
      "the depositor has no Ardoise account",
      "malformed order (addresses must be left-padded bytes32)",
    ],
  );
});

test("refuses oversized requests", async () => {
  const many = Array.from({ length: MAX_ORDERS_PER_REQUEST + 1 }, () => ({}));
  await assert.rejects(acceptOrders(many, [], GATEWAY_MAINNET, checks), /at most/);
  await assert.rejects(acceptOrders({}, [], GATEWAY_MAINNET, checks), /JSON array/);
});

test("serves the intake over HTTP: stores accepted orders, lists them per owner, allows only the app's origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ardoise-intake-"));
  const ordersFile = join(dir, "gateway-orders.json");
  const server = startIntake({
    port: 0,
    host: "127.0.0.1",
    ordersFile,
    allowedOrigin: "http://localhost:3000",
    network: GATEWAY_MAINNET,
    checks,
    log: () => {},
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/orders`;
  try {
    const order = await signedOrder();
    const posted = await fetch(url, { method: "POST", body: JSON.stringify([order]) });
    assert.equal(posted.status, 200);
    assert.equal(posted.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.deepEqual(await posted.json(), { results: [{ index: 0, status: "accepted" }] });
    assert.equal(JSON.parse(await readFile(ordersFile, "utf8")).length, 1);

    // Listed without the signature: a listed order cannot be submitted by whoever reads it.
    const listed = await fetch(`${url}?owner=${OWNER}`);
    assert.deepEqual(await listed.json(), [
      { value: "5000000", maxBlockHeight: "62265703", salt: order.burnIntent.spec.salt },
    ]);
    assert.deepEqual(await (await fetch(`${url}?owner=${OTHER}`)).json(), []);
    assert.equal((await fetch(`${url}?owner=nope`)).status, 400);
    assert.equal((await fetch(url, { method: "POST", body: "{not json" })).status, 400);
    assert.equal((await fetch(url.replace("/orders", "/other"))).status, 404);
  } finally {
    server.close();
  }
});

test("drops expired and used orders, so they neither count nor show", async () => {
  const expired = await signedOrder();
  expired.burnIntent.maxBlockHeight = "59999999";
  const spent = await signedOrder();
  used.add(spent.burnIntent.spec.salt);
  const fresh = await signedOrder();
  const { orders } = await acceptOrders([fresh], [expired, spent], GATEWAY_MAINNET, checks);
  assert.deepEqual(orders, [fresh]);
});

test("enforces the per-owner cap on live orders before any chain read", async () => {
  const stored = await Promise.all(Array.from({ length: MAX_ORDERS_PER_OWNER }, () => signedOrder()));
  let reads = 0;
  const counting: IntakeChecks = { ...checks, accountOf: async (owner) => (reads++, checks.accountOf(owner)) };
  const { results } = await acceptOrders([await signedOrder()], stored, GATEWAY_MAINNET, counting);
  assert.equal(results[0].status, "rejected");
  assert.equal(reads, 0);
});

test("answers a chain failure with a generic 503 that leaks no RPC URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ardoise-intake-"));
  const logs: string[] = [];
  const server = startIntake({
    port: 0,
    host: "127.0.0.1",
    ordersFile: join(dir, "gateway-orders.json"),
    allowedOrigin: "http://localhost:3000",
    network: GATEWAY_MAINNET,
    checks: {
      ...checks,
      accountOf: async () => {
        throw new Error("HTTP request failed.\nURL: https://rpc.example/v2/secret-key\nStatus: 500");
      },
    },
    log: (message) => logs.push(message),
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/orders`;
  try {
    const res = await fetch(url, { method: "POST", body: JSON.stringify([await signedOrder()]) });
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(!text.includes("secret-key"));
    assert.ok(logs.every((line) => !line.includes("secret-key")));
  } finally {
    server.close();
  }
});
