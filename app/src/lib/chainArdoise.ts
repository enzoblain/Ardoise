import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  isAddress,
  parseEventLogs,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  PaymentFailed,
  PaymentUnconfirmed,
  payeeToBytes32,
  type ArdoiseClient,
  type DebtLine,
  type Health,
  type PaymentError,
  type PaymentQuote,
  type PaymentRequest,
  type Venue,
  type VenueOption,
} from "@/lib/ardoise";
import { eventsFromJson, type AccountEventsJson } from "@/lib/accountEvents";
import { accountAbi, guardAbi, venueAbi } from "@/lib/contracts/abis";
import { network } from "@/lib/network";
import type { PasskeyWallet } from "@/lib/wallet";

const BPS = 10_000n;
// Public RPC endpoints reject wide `eth_getLogs` ranges; read history in slices.
const LOG_RANGE = 10_000n;

/** What the on-chain client needs. */
export interface ChainArdoiseOptions {
  publicClient: PublicClient<Transport, Chain>;
  /** Signs payments; `null` for a read-only view, or when `smartAccount` signs them. */
  walletClient: WalletClient<Transport, Chain, Account> | null;
  /** Sends payments from a passkey smart account instead of `walletClient`. */
  smartAccount?: Pick<PasskeyWallet, "submit" | "confirm">;
  /** Owner of the account and of the collateral position. */
  owner: Address;
  /** The owner's `ArdoiseAccount`. */
  account: Address;
  /** Known venues: named in the statement, and the borrowable ones offered for `payVia`. */
  venues: Venue[];
  /** First block to read the account's logs from (the factory's deployment). */
  fromBlock: bigint;
  /**
   * The app's `/api/account-events` route, which keeps the account's history
   * on the server; the client scans the chain itself only if it fails.
   */
  eventsUrl?: string;
  /**
   * Brings the wallet back to Arc before a payment is signed, for example
   * after the Protection panel moved it to Base; omitted for a read-only view.
   */
  ensureArc?: () => Promise<void>;
}

/**
 * `ArdoiseClient` backed by the deployed contracts: reads the account, its
 * venues and the guard, and sends `pay()` or `payVia()` from the owner's
 * wallet.
 *
 * Quotes read every borrowable venue (liquidity, guard, health after) and
 * `bestVenue`, follow the contract's own checks on the chosen one, then
 * simulate the call itself, so any
 * revert the reads cannot foresee (a missing Aave allowance, for example)
 * shows before the user signs.
 *
 * @param options Clients, owner, account and known venues.
 * @returns The client.
 */
export function createChainArdoise(options: ChainArdoiseOptions): ArdoiseClient {
  const { publicClient, owner, account, venues } = options;
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  const venueByAddress = (address: Address): Venue =>
    venues.find((v) => v.address.toLowerCase() === address.toLowerCase()) ?? {
      id: address,
      address,
      name: address,
      rateBps: 0,
      available: 0n,
    };
  const venueById = (id: string): Venue => {
    const venue = venues.find((v) => v.id === id);
    if (!venue) throw new Error(`Unknown venue ${id}`);
    return venue;
  };

  async function guardAddress(): Promise<Address | null> {
    const guard = await read<Address>(account, accountAbi, "guard");
    return guard === zeroAddress ? null : guard;
  }

  async function simulatedDropBps(guard: Address | null): Promise<bigint> {
    if (guard === null) return 0n;
    try {
      return await read<bigint>(guard, guardAbi, "simulatedDropBps");
    } catch {
      // A guard without the demo simulation judges at the real price.
      return 0n;
    }
  }

  async function health(venue: Venue, guard: Address | null, dropBps: bigint): Promise<Health> {
    const [healthFactor, collateralUsd, debtUsd] = await read<[bigint, bigint, bigint]>(account, accountAbi, "health", [
      venue.address,
    ]);
    if (dropBps === 0n || guard === null) return { healthFactor, collateralUsd, debtUsd };
    // Under the demo's simulated drop, show the position as the guard judges it.
    const simulated = await read<bigint>(guard, guardAbi, "simulatedHealth", [venue.address, owner]);
    return { healthFactor: simulated, collateralUsd: (collateralUsd * (BPS - dropBps)) / BPS, debtUsd };
  }

  // One venue's figures for `borrow`; a venue that cannot answer shows as unusable.
  async function venueOption(venue: Venue, borrow: bigint, guard: Address | null, dropBps: bigint): Promise<VenueOption> {
    const liquidityOk = venue.available >= borrow;
    try {
      const [healthBefore, rawAfter, allowed] = await Promise.all([
        health(venue, guard, dropBps),
        read<bigint>(venue.address, venueAbi, "healthAfter", [owner, borrow]),
        guard === null ? Promise.resolve(null) : read<bigint>(guard, guardAbi, "checkMargin", [owner, venue.address, borrow]),
      ]);
      const healthAfter = guard === null || dropBps === 0n ? rawAfter : (rawAfter * (BPS - dropBps)) / BPS;
      return { venue, liquidityOk, allowed, healthBefore, healthAfter };
    } catch {
      return { venue, liquidityOk, allowed: 0n };
    }
  }

  async function quote(request: PaymentRequest): Promise<PaymentQuote> {
    const borrow = request.amount + request.maxFee;
    const guard = await guardAddress();
    const borrowable = venues.filter((v) => v.borrowable !== false);
    const [dropBps, minHealthFactor] = await Promise.all([
      simulatedDropBps(guard),
      guard === null ? Promise.resolve(null) : read<bigint>(guard, guardAbi, "minHealthFactor"),
    ]);
    const [options, recommended] = await Promise.all([
      Promise.all(borrowable.map((v) => venueOption(v, borrow, guard, dropBps))),
      read<Address>(account, accountAbi, "bestVenue", [borrow]).then(venueByAddress, () => undefined),
    ]);
    const chosen = request.venueId === undefined ? recommended : venueById(request.venueId);
    const option = chosen && options.find((o) => o.venue.id === chosen.id);
    const base: PaymentQuote = {
      borrow,
      minHealthFactor,
      options,
      recommended,
      venue: chosen,
      healthBefore: option?.healthBefore,
      healthAfter: option?.healthAfter,
    };

    // Errors in the order pay() and payVia() check them.
    if (request.amount === 0n) return { ...base, error: { code: "ZeroAmount" } };
    if (request.destinationDomain === network.arc.cctpDomain && request.maxFee > 0n) {
      return { ...base, error: { code: "FeeOnArc" } };
    }
    if (!isAddress(request.payee) || request.payee === zeroAddress) {
      return { ...base, error: { code: "InvalidPayee" } };
    }
    const [perPayment, daily, spentToday] = await read<[bigint, bigint, bigint]>(account, accountAbi, "caps");
    const remaining = perPayment < daily - spentToday ? perPayment : daily > spentToday ? daily - spentToday : 0n;
    if (borrow > remaining) return { ...base, error: { code: "CapExceeded", remaining } };

    if (!chosen) return { ...base, error: { code: "NoVenueAvailable" } };
    if (!option) return { ...base, error: { code: "UnknownVenue" } };
    if (!option.liquidityOk) return { ...base, error: { code: "NoVenueAvailable" } };
    if (guard === null) return { ...base, error: { code: "GuardNotSet" } };
    if (option.allowed !== null && option.allowed < borrow) {
      return { ...base, error: { code: "PaymentRefused", allowed: option.allowed } };
    }

    // The reads cover the contract's own checks; simulating the call catches
    // the rest (venue allowance, CCTP), as it would revert on chain.
    try {
      const call = payCall(request);
      // One call per function, so viem types each one's arguments.
      if (call.functionName === "pay") await publicClient.simulateContract({ ...call, account: owner });
      else await publicClient.simulateContract({ ...call, account: owner });
    } catch (error) {
      return { ...base, error: toPaymentError(error) };
    }
    return base;
  }

  // `payVia` on the chosen venue, or `pay()` when the request names none.
  function payCall(request: PaymentRequest) {
    const args = payArgs(request);
    return request.venueId === undefined
      ? ({ address: account, abi: accountAbi, functionName: "pay", args } as const)
      : ({
          address: account,
          abi: accountAbi,
          functionName: "payVia",
          args: [venueById(request.venueId).address, ...args],
        } as const);
  }

  function toLine(raw: RawLine, transactionHash?: Hex): DebtLine {
    return {
      id: raw.id,
      venue: venueByAddress(raw.venue),
      principal: raw.principal,
      repaid: raw.repaid,
      accruedInterest: raw.accruedInterest,
      rateBps: Number(raw.rateBps),
      destinationDomain: Number(raw.destinationDomain),
      openedAt: Number(raw.openedAt),
      payee: raw.payee,
      memo: raw.memo,
      transactionHash,
    };
  }

  return {
    simulated: false,

    async health(venueId) {
      const guard = await guardAddress();
      return health(venueById(venueId), guard, await simulatedDropBps(guard));
    },

    async minHealthFactor() {
      const guard = await guardAddress();
      return guard === null ? null : read<bigint>(guard, guardAbi, "minHealthFactor");
    },

    async simulatedDropBps() {
      return Number(await simulatedDropBps(await guardAddress()));
    },

    async caps() {
      const [perPayment, daily, spentToday] = await read<[bigint, bigint, bigint]>(account, accountAbi, "caps");
      return { perPayment, daily, spentToday };
    },

    async lines() {
      return (await read<RawLine[]>(account, accountAbi, "lines")).map((raw) => toLine(raw));
    },

    quote,

    async events() {
      if (options.eventsUrl) {
        try {
          const res = await fetch(`${options.eventsUrl}?owner=${options.owner}&account=${account}`);
          if (res.ok) return { account, ...eventsFromJson((await res.json()) as AccountEventsJson) };
        } catch {
          // Falls back to reading the chain from the browser.
        }
      }
      const latest = await publicClient.getBlockNumber();
      const logs: Log[] = [];
      for (let from = options.fromBlock; from <= latest; from += LOG_RANGE) {
        const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
        logs.push(...(await publicClient.getLogs({ address: account, fromBlock: from, toBlock: to })));
      }
      const blockTimes = new Map<bigint, number>();
      for (const blockNumber of new Set(logs.map((log) => log.blockNumber).filter((n): n is bigint => n !== null))) {
        const block = await publicClient.getBlock({ blockNumber });
        blockTimes.set(blockNumber, Number(block.timestamp));
      }
      return { account, logs, blockTimes };
    },

    async pay(request) {
      const { walletClient, smartAccount } = options;
      if (walletClient === null && !smartAccount) throw new Error("Connect the owner's wallet to pay.");
      await options.ensureArc?.();
      let sent: Hex;
      try {
        const call = payCall(request);
        const signer = { account: walletClient!.account, chain: walletClient!.chain };
        if (smartAccount) sent = await smartAccount.submit([{ to: account, data: encodeFunctionData(call) }]);
        // One call per function, so viem types each one's arguments.
        else if (call.functionName === "pay") sent = await walletClient!.writeContract({ ...call, ...signer });
        else sent = await walletClient!.writeContract({ ...call, ...signer });
      } catch (error) {
        const reason = toPaymentError(error);
        if (reason.code !== "Reverted") throw new PaymentFailed(reason);
        throw error;
      }
      // From here the payment is on its way: any failure to read its outcome
      // must not look like a payment that can be retried.
      let hash = sent;
      if (smartAccount) {
        let operation: Awaited<ReturnType<typeof smartAccount.confirm>>;
        try {
          operation = await smartAccount.confirm(sent);
        } catch (error) {
          throw new PaymentUnconfirmed(sent, (error as Error).message.split("\n")[0], true);
        }
        hash = operation.transactionHash;
        if (!operation.success) throw new PaymentFailed({ code: "Reverted", message: `User operation ${sent} reverted` });
      }
      let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash });
      } catch (error) {
        throw new PaymentUnconfirmed(hash, (error as Error).message.split("\n")[0]);
      }
      if (receipt.status !== "success") throw new PaymentFailed({ code: "Reverted", message: `Transaction ${hash} reverted` });
      // A bundler transaction may carry other accounts' operations: keep this account's event.
      const [paid] = parseEventLogs({
        abi: accountAbi,
        eventName: "Paid",
        logs: receipt.logs.filter((log) => log.address.toLowerCase() === account.toLowerCase()),
      });
      if (!paid) throw new PaymentUnconfirmed(hash, "the transaction carries no Paid event");
      // Built from the event and the receipt's block rather than read back
      // with line(): a load-balanced RPC node may not have that block yet.
      let openedAt = Math.floor(Date.now() / 1000);
      try {
        openedAt = Number((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
      } catch {
        // The block time only dates the line; the local clock is close enough.
      }
      return toLine(
        {
          id: paid.args.lineId,
          venue: paid.args.venue,
          principal: paid.args.borrowed,
          repaid: 0n,
          accruedInterest: 0n,
          rateBps: paid.args.rateBps,
          destinationDomain: paid.args.destinationDomain,
          openedAt,
          payee: paid.args.payee,
          memo: paid.args.memo,
        },
        hash,
      );
    },
  };
}

/** `DebtLine` as viem decodes it from `line()` / `lines()`. */
interface RawLine {
  id: bigint;
  venue: Address;
  principal: bigint;
  repaid: bigint;
  accruedInterest: bigint;
  rateBps: number | bigint;
  destinationDomain: number | bigint;
  openedAt: number | bigint;
  payee: Hex;
  memo: string;
}

function payArgs(request: PaymentRequest) {
  return [
    request.amount,
    request.destinationDomain,
    payeeToBytes32(request.payee),
    request.maxFee,
    request.memo,
  ] as const;
}

/**
 * Maps a failed call to the contract error it reverted with.
 *
 * @param error What viem threw.
 * @returns The matching `PaymentError`, or `Reverted` with viem's short
 *   message for anything else (including a rejected signature).
 */
export function toPaymentError(error: unknown): PaymentError {
  const reverted =
    error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
  if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
    const args = (reverted.data.args ?? []) as readonly unknown[];
    switch (reverted.data.errorName) {
      case "InvalidPayee":
        return { code: "InvalidPayee" };
      case "CapExceeded":
        return { code: "CapExceeded", remaining: args[1] as bigint };
      case "NoVenueAvailable":
        return { code: "NoVenueAvailable" };
      case "UnknownVenue":
        return { code: "UnknownVenue" };
      case "PaymentRefused":
        return { code: "PaymentRefused", allowed: args[1] as bigint };
      case "GuardNotSet":
        return { code: "GuardNotSet" };
      case "FeeOnArc":
        return { code: "FeeOnArc" };
      case "ZeroAmount":
        return { code: "ZeroAmount" };
      default:
        return { code: "Reverted", message: reverted.data.errorName };
    }
  }
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  return { code: "Reverted", message };
}
