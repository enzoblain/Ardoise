import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";

import { BURN_INTENT_DOMAIN, BURN_INTENT_TYPES, parseOrders, rejectReason, type GatewayNetwork, type StandingOrder } from "./gateway.js";

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
 */

/** Most orders accepted in one request, and kept per depositor. */
export const MAX_ORDERS_PER_REQUEST = 10;
export const MAX_ORDERS_PER_OWNER = 40;
const MAX_BODY_BYTES = 64 * 1024;
/** Requests allowed per client address per minute. */
const RATE_LIMIT = 30;

/** Chain reads the intake needs, replaceable in tests. */
export interface IntakeChecks {
  /** `factory.accountOf(owner)`, or `null` if the owner has no account. */
  accountOf(owner: Address): Promise<Address | null>;
  /** Whether `signature` is the depositor's over the burn intent (EOA or ERC-1271 on the source chain). */
  verifySignature(order: StandingOrder, depositor: Address): Promise<boolean>;
}

/** Outcome of one posted order. */
export type IntakeResult =
  | { index: number; status: "accepted" | "duplicate" }
  | { index: number; status: "rejected"; reason: string };

/**
 * Checks posted orders against the chain and merges the valid ones into the
 * stored list. Pure apart from the chain reads, so it can be unit-tested.
 *
 * @param body Parsed JSON body: an array of standing orders.
 * @param stored Orders already stored.
 * @param network Gateway environment.
 * @param checks Chain reads.
 * @returns The new stored list and one result per posted entry.
 * @throws If `body` is not an array or holds too many orders.
 */
export async function acceptOrders(
  body: unknown,
  stored: readonly StandingOrder[],
  network: GatewayNetwork,
  checks: IntakeChecks,
): Promise<{ orders: StandingOrder[]; results: IntakeResult[] }> {
  if (!Array.isArray(body)) throw new Error("expected a JSON array of standing orders");
  if (body.length > MAX_ORDERS_PER_REQUEST) throw new Error(`at most ${MAX_ORDERS_PER_REQUEST} orders per request`);

  const orders = [...stored];
  const keys = new Set(orders.map(orderKey));
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
    if (orders.filter((o) => orderKey(o).startsWith(`${owner.toLowerCase()}:`)).length >= MAX_ORDERS_PER_OWNER) {
      results.push({ index, status: "rejected", reason: `at most ${MAX_ORDERS_PER_OWNER} orders per owner` });
      continue;
    }
    orders.push(order);
    keys.add(orderKey(order));
    results.push({ index, status: "accepted" });
  }
  return { orders, results };
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
 * - `GET /orders?owner=0x…`: the stored orders of that depositor, so the
 *   app can show them. Orders hold no secret: they are signed for Gateway.
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
      options.log(`order intake: ${(error as Error).message}`);
      send(res, 500, { error: "internal error" });
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
      return send(res, 200, (await load(options.ordersFile)).filter((o) => orderKey(o).startsWith(prefix)));
    }
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      return send(res, 400, { error: (error as Error).message });
    }
    const run = queue.then(async () => {
      const { orders, results } = await acceptOrders(body, await load(options.ordersFile), options.network, options.checks);
      if (results.some((r) => r.status === "accepted")) await save(options.ordersFile, orders);
      return results;
    });
    queue = run.catch(() => undefined);
    let results: IntakeResult[];
    try {
      results = await run;
    } catch (error) {
      return send(res, 400, { error: (error as Error).message });
    }
    const accepted = results.filter((r) => r.status === "accepted").length;
    if (accepted > 0) options.log(`order intake: stored ${accepted} standing order(s)`);
    send(res, 200, { results });
  }

  server.listen(options.port, options.host);
  return server;
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
