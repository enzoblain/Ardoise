import { isAddressEqual, type Address, type Chain, type Hex, type Log, type PublicClient, type Transport } from "viem";
import { factoryAbi } from "@/lib/contracts/abis";

// Public RPC endpoints reject wide `eth_getLogs` ranges; read history in
// slices, one at a time, which every public Arc endpoint tolerates best.
const LOG_RANGE = 10_000n;
/** Accounts kept in memory; the oldest scanned one is dropped beyond this. */
const MAX_ACCOUNTS = 200;

/** An account's logs and the time of their blocks, as the statement needs them. */
export interface AccountEvents {
  logs: Log[];
  blockTimes: Map<bigint, number>;
}

/** The same, in JSON: block numbers as decimal strings. */
export interface AccountEventsJson {
  logs: { address: Address; topics: Hex[]; data: Hex; blockNumber: string; transactionHash: Hex; logIndex: number }[];
  blockTimes: [string, number][];
}

interface Entry extends AccountEvents {
  /** Last block scanned; Arc's blocks are final once produced, so a scanned range is never read again. */
  scannedTo: bigint;
}

/**
 * Keeps each Ardoise account's event history on the server and reads only
 * the blocks produced since the last request, so every visitor of the app
 * shares one scan instead of each browser re-reading the chain from the
 * factory's deployment.
 *
 * @param client Arc client of the server.
 * @param factory The factory: an account is served only to its owner's request.
 * @param fromBlock First block to read (the factory's deployment).
 * @returns `read(owner, account)`, which resolves with the account's events,
 *   or `null` when `account` is not the factory's account of `owner`, so the
 *   store cannot be used to scan arbitrary contracts.
 */
export function createAccountEvents(client: PublicClient<Transport, Chain>, factory: Address, fromBlock: bigint) {
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<AccountEvents | null>>();

  async function scan(owner: Address, account: Address): Promise<AccountEvents | null> {
    const key = account.toLowerCase();
    const known = entries.get(key);
    if (!known) {
      const accountOf = await client.readContract({ address: factory, abi: factoryAbi, functionName: "accountOf", args: [owner] });
      if (!isAddressEqual(accountOf, account)) return null;
    }
    const entry: Entry = known ?? { logs: [], blockTimes: new Map(), scannedTo: fromBlock - 1n };
    const latest = await client.getBlockNumber();
    const ranges: [bigint, bigint][] = [];
    for (let from = entry.scannedTo + 1n; from <= latest; from += LOG_RANGE) {
      ranges.push([from, from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest]);
    }
    const fresh: Log[] = [];
    for (const [fromBlock, toBlock] of ranges) fresh.push(...(await client.getLogs({ address: account, fromBlock, toBlock })));
    const blockTimes = new Map(entry.blockTimes);
    for (const blockNumber of new Set(fresh.map((log) => log.blockNumber).filter((n): n is bigint => n !== null))) {
      if (!blockTimes.has(blockNumber)) blockTimes.set(blockNumber, Number((await client.getBlock({ blockNumber })).timestamp));
    }
    // Stored only once every read succeeded: a failed refresh leaves the last complete history.
    const next: Entry = { logs: [...entry.logs, ...fresh], blockTimes, scannedTo: latest > entry.scannedTo ? latest : entry.scannedTo };
    entries.delete(key);
    entries.set(key, next);
    if (entries.size > MAX_ACCOUNTS) entries.delete(entries.keys().next().value!);
    return next;
  }

  return {
    read(owner: Address, account: Address): Promise<AccountEvents | null> {
      const key = `${owner.toLowerCase()}:${account.toLowerCase()}`;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = scan(owner, account).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
  };
}

/**
 * Serializes account events for the API route.
 *
 * @param events Events from `read`.
 * @returns JSON-safe events.
 */
export function eventsToJson(events: AccountEvents): AccountEventsJson {
  return {
    logs: events.logs.map((log) => ({
      address: log.address,
      topics: log.topics as Hex[],
      data: log.data,
      blockNumber: (log.blockNumber ?? 0n).toString(),
      transactionHash: log.transactionHash ?? "0x",
      logIndex: log.logIndex ?? 0,
    })),
    blockTimes: [...events.blockTimes].map(([block, time]) => [block.toString(), time]),
  };
}

/**
 * Reads back what `eventsToJson` produced, in the browser.
 *
 * @param json Body of the API route.
 * @returns The events, with the fields the statement uses.
 */
export function eventsFromJson(json: AccountEventsJson): AccountEvents {
  return {
    logs: json.logs.map(
      (log) =>
        ({
          ...log,
          blockNumber: BigInt(log.blockNumber),
          blockHash: null,
          transactionIndex: null,
          removed: false,
        }) as unknown as Log,
    ),
    blockTimes: new Map(json.blockTimes.map(([block, time]) => [BigInt(block), time])),
  };
}
