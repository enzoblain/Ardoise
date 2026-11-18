import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { getAddress, isAddress, size, zeroAddress, type Address, type Hex } from "viem";

import { BURN_INTENT_DOMAIN, BURN_INTENT_TYPES, parseOrders, rejectReason, type GatewayNetwork, type StandingOrder } from "./gateway.js";
import { errorMessage } from "./keeper.js";

/**
 * Intake of Gateway standing orders (B4): the app sends the orders a user
 * signs, and the keeper keeps those it may relay in `GATEWAY_ORDERS_FILE`,
 * where `GatewayFunder` reads them.
 *
 * Anyone can post, so every order is checked before it is stored: its
 * recipient must be the depositor's own Ardoise account as the factory
 * reports it, every field must pass `rejectReason`, and the signature must
 * be the depositor's. A stored order can therefore only repay its signer's
 * debt, whoever posted it.
 *
 * Stored orders are bearer instruments: anyone holding one can submit it to
 * Gateway, which can only move the owner's reserve onto their own account
 * (repaying their debt, for Gateway's fee). The intake therefore never hands
 * signatures back out.
 */

/** Most orders accepted in one request, and kept per depositor. */
export const MAX_ORDERS_PER_REQUEST = 10;
export const MAX_ORDERS_PER_OWNER = 40;
const MAX_BODY_BYTES = 64 * 1024;
/** Requests allowed per client address per minute. */
const RATE_LIMIT = 30;

/** Chain reads and funder state the intake needs, replaceable in tests. */
export interface IntakeChecks {
  /** `factory.accountOf(owner)`, or `null` if the owner has no account. */
  accountOf(owner: Address): Promise<Address | null>;
  /** Whether `signature` is the depositor's over the burn intent (EOA or ERC-1271 on the source chain). */
  verifySignature(order: StandingOrder, depositor: Address): Promise<boolean>;
  /**
   * Whether the depositor is a deployed contract on the source chain (a
   * passkey smart account). An EOA delegated with EIP-7702 is not one: it
   * still signs as an EOA.
   */
  isContract(depositor: Address): Promise<boolean>;
  /** Current block of the source chain (Base), against which `maxBlockHeight` expires. */
  sourceBlockNumber(): Promise<bigint>;
  /** Whether the funder already used the order. */
  isUsed(order: StandingOrder): boolean;
}

/** A request the intake cannot accept as sent; its message is safe to return. */
export class IntakeInputError extends Error {}

/** What `GET /orders` returns per order: enough to show it, not to submit it. */
export interface OrderSummary {
  value: string;
  maxBlockHeight: string;
  salt: Hex;
}

/** Outcome of one posted order. */
export type IntakeResult =
  | { index: number; status: "accepted" | "duplicate" }
  | { index: number; status: "rejected"; reason: string };

/**
 * Orders that can still be used: not past their `maxBlockHeight` on the
 * source chain and not used by the funder.
 *
 * @param orders Stored orders.
 * @param sourceBlock Current source-chain block.
 * @param isUsed The funder's record of used orders.
 * @returns The live orders.
 */
export function liveOrders(
  orders: readonly StandingOrder[],
  sourceBlock: bigint,
  isUsed: (order: StandingOrder) => boolean,
): StandingOrder[] {
  return orders.filter((order) => BigInt(order.burnIntent.maxBlockHeight) >= sourceBlock && !isUsed(order));
}

/**
 * Checks posted orders: shape, duplicates and the per-owner cap first, then
 * the chain reads (account and signature) only for orders that passed. It
 * reads but never writes, so it can run outside the write queue.
 *
 * @param body Parsed JSON body: an array of standing orders.
 * @param live Live stored orders.
 * @param network Gateway environment.
 * @param checks Chain reads.
 * @returns The orders to store and one result per posted entry.
 * @throws {IntakeInputError} If `body` is not an array or holds too many orders.
 */
export async function checkOrders(
  body: unknown,
  live: readonly StandingOrder[],
  network: GatewayNetwork,
  checks: IntakeChecks,
): Promise<{ candidates: StandingOrder[]; results: IntakeResult[] }> {
  if (!Array.isArray(body)) throw new IntakeInputError("expected a JSON array of standing orders");
  if (body.length > MAX_ORDERS_PER_REQUEST) throw new IntakeInputError(`at most ${MAX_ORDERS_PER_REQUEST} orders per request`);

  const keys = new Set(live.map(orderKey));
  const perOwner = new Map<string, number>();
  for (const order of live) perOwner.set(ownerKey(order), (perOwner.get(ownerKey(order)) ?? 0) + 1);
  const candidates: StandingOrder[] = [];
  const results: IntakeResult[] = [];

  for (let index = 0; index < body.length; index++) {
    const [order] = parseOrders([body[index]]);
    if (order === undefined) {
      results.push({ index, status: "rejected", reason: "malformed order (addresses must be left-padded bytes32)" });
      continue;
    }
    if (keys.has(orderKey(order))) {
      results.push({ index, status: "duplicate" });
      continue;
    }
    const depositor = `0x${order.burnIntent.spec.sourceDepositor.slice(26)}`;
    if (!isAddress(depositor)) {
      results.push({ index, status: "rejected", reason: "depositor is not an address" });
      continue;
    }
    // Checked before any chain read, so a flood of orders for one owner
    // costs no RPC calls once the cap is reached.
    if ((perOwner.get(ownerKey(order)) ?? 0) >= MAX_ORDERS_PER_OWNER) {
      results.push({ index, status: "rejected", reason: `at most ${MAX_ORDERS_PER_OWNER} live orders per owner` });
      continue;
    }
    const owner = getAddress(depositor);
    const account = await checks.accountOf(owner);
    if (account === null) {
      results.push({ index, status: "rejected", reason: "the depositor has no Ardoise account" });
      continue;
    }
    const reason = rejectReason(order, owner, account, network);
    if (reason !== null) {
      results.push({ index, status: "rejected", reason });
      continue;
    }
    if (!(await checks.verifySignature(order, owner))) {
      results.push({ index, status: "rejected", reason: "the signature is not the depositor's" });
      continue;
    }
    // Gateway checks a smart account's signature with ERC-1271 only when the
    // order says so, and only on a deployed account: the flag is set here from
    // the chain rather than taken from the sender, and an account that is not
    // deployed yet (its signature then verifies only as ERC-6492) is refused.
    const contract = await checks.isContract(owner);
    if (!contract && size(order.signature) !== 65) {
      results.push({ index, status: "rejected", reason: "the depositor's smart account is not deployed on the source chain yet: deposit first" });
      continue;
    }
    candidates.push({ burnIntent: order.burnIntent, signature: order.signature, ...(contract ? { contractSigner: true as const } : {}) });
    keys.add(orderKey(order));
    perOwner.set(ownerKey(order), (perOwner.get(ownerKey(order)) ?? 0) + 1);
    results.push({ index, status: "accepted" });
  }
  return { candidates, results };
}

/**
 * The list to store: the live stored orders plus the new candidates that
 * are still not duplicates and within the per-owner cap (another request
 * may have been stored meanwhile).
 *
 * @param live Live stored orders, read again inside the write queue.
 * @param candidates Orders `checkOrders` accepted.
 * @returns The orders to write.
 */
export function mergeOrders(live: readonly StandingOrder[], candidates: readonly StandingOrder[]): StandingOrder[] {
  const merged = [...live];
  const keys = new Set(merged.map(orderKey));
  for (const order of candidates) {
    if (keys.has(orderKey(order))) continue;
    if (merged.filter((o) => ownerKey(o) === ownerKey(order)).length >= MAX_ORDERS_PER_OWNER) continue;
    merged.push(order);
    keys.add(orderKey(order));
  }
  return merged;
}

/**
 * Checks posted orders and merges them into the stored ones in one step, as
 * the server does across its two phases. Expired and used orders are dropped.
 *
 * @param body Parsed JSON body.
 * @param stored Orders stored so far.
 * @param network Gateway environment.
 * @param checks Chain reads and funder state.
 * @returns The new stored list and one result per posted entry.
 * @throws {IntakeInputError} On a malformed request.
 */
export async function acceptOrders(
  body: unknown,
  stored: readonly StandingOrder[],
  network: GatewayNetwork,
  checks: IntakeChecks,
): Promise<{ orders: StandingOrder[]; results: IntakeResult[] }> {
  const live = liveOrders(stored, await checks.sourceBlockNumber(), (o) => checks.isUsed(o));
  const { candidates, results } = await checkOrders(body, live, network, checks);
  return { orders: mergeOrders(live, candidates), results };
}

/**
 * Typed data of a burn intent as the depositor signed it, for signature
 * checks.
 *
 * @param order Standing order.
 * @returns Arguments for viem's `verifyTypedData`, without address and signature.
 */
export function burnIntentTypedData(order: StandingOrder) {
  const { burnIntent } = order;
  return {
    domain: BURN_INTENT_DOMAIN,
    types: BURN_INTENT_TYPES,
    primaryType: "BurnIntent" as const,
    message: {
      maxBlockHeight: BigInt(burnIntent.maxBlockHeight),
      maxFee: BigInt(burnIntent.maxFee),
      spec: { ...burnIntent.spec, value: BigInt(burnIntent.spec.value) },
    },
  };
}

/** What the HTTP server needs. */
export interface IntakeServerOptions {
  port: number;
  /** Interface to listen on; `127.0.0.1` keeps it local unless exposed on purpose. */
  host: string;
  ordersFile: string;
  /** Only this origin may call the intake from a browser (the app's). */
  allowedOrigin: string;
  network: GatewayNetwork;
  checks: IntakeChecks;
  log: (message: string) => void;
}

/**
 * Starts the intake server.
 *
 * - `POST /orders` with a JSON array of standing orders: checks and stores
 *   them, answers one result per entry.
 * - `GET /orders?owner=0x…`: a summary (value, expiry, salt) of that
 *   depositor's live orders, without signatures.
 *
 * Errors from chain reads or the file are answered with a generic 503 and
 * logged on one line: their full text can include an RPC URL with a key.
 *
 * @param options Server settings.
 * @returns The listening server.
 */
export function startIntake(options: IntakeServerOptions): Server {
  // Writes are chained so two requests never write the file at once.
  let queue: Promise<unknown> = Promise.resolve();
  const hits = new Map<string, { count: number; since: number }>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.log(`order intake: ${errorMessage(error)}`);
      send(res, 503, { error: "could not check the orders, try again" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("access-control-allow-origin", options.allowedOrigin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("vary", "origin");
    if (req.method === "OPTIONS") return send(res, 204);

    const client = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const hit = hits.get(client);
    if (hit === undefined || now - hit.since > 60_000) hits.set(client, { count: 1, since: now });
    else if (++hit.count > RATE_LIMIT) return send(res, 429, { error: "too many requests" });

    const url = new URL(req.url ?? "/", "http://intake");
    if (url.pathname !== "/orders") return send(res, 404, { error: "not found" });

    if (req.method === "GET") {
      const owner = url.searchParams.get("owner") ?? "";
      if (!isAddress(owner)) return send(res, 400, { error: "owner must be an address" });
      const prefix = `${owner.toLowerCase()}:`;
      const live = liveOrders(await load(options.ordersFile), await options.checks.sourceBlockNumber(), (o) =>
        options.checks.isUsed(o),
      );
      const summaries: OrderSummary[] = live
        .filter((o) => orderKey(o).startsWith(prefix))
        .map((o) => ({ value: o.burnIntent.spec.value, maxBlockHeight: o.burnIntent.maxBlockHeight, salt: o.burnIntent.spec.salt }));
      return send(res, 200, summaries);
    }
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "body is not JSON or is too large" });
    }
    const isUsed = (o: StandingOrder) => options.checks.isUsed(o);
    let checked: Awaited<ReturnType<typeof checkOrders>>;
    try {
      // Chain reads happen here, outside the write queue, so a slow or
      // abusive request does not hold back the others' writes.
      const live = liveOrders(await load(options.ordersFile), await options.checks.sourceBlockNumber(), isUsed);
      checked = await checkOrders(body, live, options.network, options.checks);
    } catch (error) {
      if (error instanceof IntakeInputError) return send(res, 400, { error: error.message });
      throw error;
    }
    const { candidates, results } = checked;
    if (candidates.length > 0) {
      const write = queue.then(async () => {
        const live = liveOrders(await load(options.ordersFile), await options.checks.sourceBlockNumber(), isUsed);
        await save(options.ordersFile, mergeOrders(live, candidates));
      });
      queue = write.catch(() => undefined);
      await write;
    }
    const accepted = results.filter((r) => r.status === "accepted").length;
    if (accepted > 0) options.log(`order intake: stored ${accepted} standing order(s)`);
    send(res, 200, { results });
  }

  server.listen(options.port, options.host);
  return server;
}

function ownerKey(order: StandingOrder): string {
  return order.burnIntent.spec.sourceDepositor.slice(26).toLowerCase();
}

function orderKey(order: StandingOrder): string {
  const spec = order.burnIntent.spec;
  return `0x${spec.sourceDepositor.slice(26).toLowerCase()}:${spec.salt.toLowerCase()}`;
}

async function load(file: string): Promise<StandingOrder[]> {
  try {
    return parseOrders(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Written to a temporary file then renamed, so the funder never reads a half-written file.
async function save(file: string, orders: readonly StandingOrder[]): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(orders, null, 2)}\n`);
  await rename(temporary, file);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** Zero address check for `accountOf` results. */
export function accountOrNull(account: Hex): Address | null {
  return account.toLowerCase() === zeroAddress ? null : getAddress(account);
}
