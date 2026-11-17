import {
  TransactionReceiptNotFoundError,
  formatUnits,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

import { accountAbi, erc20Abi, factoryAbi, guardAbi, venueAbi } from "./abis.js";
import { USDC_ADDRESS } from "./config.js";
import { MIN_SWEEP_AMOUNT, decide, type Decision, type Thresholds, type VenuePosition } from "./decision.js";

/**
 * Largest block range asked in one `eth_getLogs` call. Public RPC endpoints
 * reject wide ranges, so the account history is read in slices.
 */
const LOG_RANGE = 10_000n;

/**
 * Blocks read again on every pass, about two minutes of Arc blocks. Behind a
 * load-balanced RPC endpoint, a node that has not seen the newest blocks yet
 * answers with no logs; reading them again on the next passes keeps an
 * account created there from being missed for good.
 */
const RESCAN_BLOCKS = 240n;

/** Wait after a first failed `sweep()` on an account; doubles on every further failure. */
const FIRST_RETRY_DELAY_MS = 60_000;

/** Longest wait between two attempts on an account that keeps failing. */
const MAX_RETRY_DELAY_MS = 3_600_000;

/**
 * How long one pass waits for a `sweep()` receipt. Arc confirms in about a
 * second; waiting longer would only keep the other accounts from being
 * checked, and the pending transaction is picked up again on later passes.
 */
const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * Age after which a `sweep()` without receipt is treated as lost (dropped
 * from the mempool, replaced) and counted as a failed attempt, so that the
 * account is retried instead of staying on hold forever.
 */
const PENDING_DEADLINE_MS = 300_000;

/** An Ardoise account and the wallet that owns it and its collateral. */
interface WatchedAccount {
  owner: Address;
  account: Address;
}

/** What the keeper needs to run: chain access, the factory to watch and a log sink. */
export interface KeeperOptions {
  /** Client used for every read, simulation and receipt. */
  publicClient: PublicClient<Transport, Chain>;
  /** Wallet that sends `sweep()`, or `null` to only log what would be sent. */
  walletClient: WalletClient<Transport, Chain, Account> | null;
  /** Ardoise factory whose accounts are watched. */
  factory: Address;
  /** First block to read `AccountCreated` logs from. */
  fromBlock: bigint;
  /** Receives one line per event worth telling the operator. */
  log: (message: string) => void;
  /** Clock in milliseconds, replaceable in tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Overrides `RECEIPT_TIMEOUT_MS`, for tests. */
  receiptTimeoutMs?: number;
}

/** Formats a USDC amount in base units for the logs. */
function usdc(amount: bigint): string {
  return `${formatUnits(amount, 6)} USDC`;
}

/** Formats a WAD health factor for the logs; no debt means no health factor. */
function healthFactor(value: bigint): string {
  return value > 10n ** 36n ? "no debt" : Number(formatUnits(value, 18)).toFixed(3);
}

/**
 * Repay-only keeper: finds the Ardoise accounts of a factory and calls the
 * public `IArdoise.sweep()` on those that hold USDC and have debt.
 *
 * `sweep()` is the only transaction it ever sends. It applies the account's
 * own USDC balance to the account's debt, so the keeper wallet holds no user
 * funds and has no right to borrow, withdraw or move anything. The keeper
 * wallet only pays gas, so the bookkeeping below avoids paying twice for the
 * same funds or paying again and again for a `sweep()` that fails. One case
 * remains: if the RPC endpoint accepts a transaction but the answer is lost,
 * the keeper has no hash to track and may send a second one after the retry
 * delay; that costs one extra gas fee at most.
 */
export class Keeper {
  private readonly accounts = new Map<Address, WatchedAccount>();
  private nextLogBlock: bigint;
  /** Last line logged per account and topic, to log changes instead of every pass. */
  private readonly lastLogged = new Map<string, string>();
  /** `sweep()` transactions sent and not yet seen in a block. */
  private readonly pending = new Map<Address, { hash: Hash; sentAt: number }>();
  /** Consecutive failed `sweep()` attempts and the time before which not to retry. */
  private readonly failures = new Map<Address, { count: number; retryAt: number }>();
  private readonly now: () => number;

  constructor(private readonly options: KeeperOptions) {
    this.nextLogBlock = options.fromBlock;
    this.now = options.now ?? Date.now;
  }

  /**
   * One pass: picks up new accounts, then checks every known account and
   * sweeps those that need it, one transaction at a time.
   *
   * @throws If the factory's venue list or guard address cannot be read; the
   * caller retries on the next pass. A failed log query, an unreadable guard
   * or a failure on a single account is logged and does not stop the rest.
   */
  async tick(): Promise<void> {
    const { publicClient, factory, log } = this.options;
    try {
      await this.discoverAccounts(await publicClient.getBlockNumber());
    } catch (error) {
      // Repayments on the accounts already known matter more than new accounts.
      log(`reading new accounts failed, retrying on the next pass: ${errorMessage(error)}`);
    }
    if (this.accounts.size === 0) return;

    const [venues, guard] = await Promise.all([
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "venues" }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "guard" }),
    ]);
    const thresholds = await this.readThresholds(guard);

    for (const watched of this.accounts.values()) {
      try {
        await this.checkAccount(watched, venues, thresholds);
        this.logRecovery(watched.account, "error", "check works again");
      } catch (error) {
        this.logOnce(watched.account, "error", `check failed: ${errorMessage(error)}`);
      }
    }
  }

  /** Reads `AccountCreated` logs from the last block read up to `latest`. */
  private async discoverAccounts(latest: bigint): Promise<void> {
    const { publicClient, factory, log, fromBlock } = this.options;
    while (this.nextLogBlock <= latest) {
      const toBlock = this.nextLogBlock + LOG_RANGE - 1n < latest ? this.nextLogBlock + LOG_RANGE - 1n : latest;
      const events = await publicClient.getContractEvents({
        address: factory,
        abi: factoryAbi,
        eventName: "AccountCreated",
        fromBlock: this.nextLogBlock,
        toBlock,
        strict: true,
      });
      for (const event of events) {
        const { owner, account } = event.args;
        if (!this.accounts.has(account)) {
          this.accounts.set(account, { owner, account });
          log(`watching account ${account} of ${owner}`);
        }
      }
      this.nextLogBlock = toBlock + 1n;
    }
    const rescanFrom = latest + 1n - RESCAN_BLOCKS;
    this.nextLogBlock = rescanFrom > fromBlock ? rescanFrom : fromBlock;
  }

  /**
   * Reads the guard thresholds. Returns `null` while the factory has no guard
   * or when the guard cannot be read: the thresholds only label a decision
   * and size the reported shortfall, so a broken guard must not stop sweeps.
   */
  private async readThresholds(guard: Address): Promise<Thresholds | null> {
    if (guard === zeroAddress) return null;
    const { publicClient } = this.options;
    try {
      const [minHealthFactor, targetHealthFactor] = await Promise.all([
        publicClient.readContract({ address: guard, abi: guardAbi, functionName: "minHealthFactor" }),
        publicClient.readContract({ address: guard, abi: guardAbi, functionName: "targetHealthFactor" }),
      ]);
      this.logRecovery(guard, "guard", `guard ${guard} can be read again`);
      return { minHealthFactor, targetHealthFactor };
    } catch (error) {
      this.logOnce(guard, "guard", `guard ${guard} cannot be read, ignoring thresholds: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Reads one account's state, decides, and sweeps if the decision says so. */
  private async checkAccount(
    watched: WatchedAccount,
    venues: readonly Address[],
    thresholds: Thresholds | null,
  ): Promise<void> {
    const { publicClient } = this.options;
    await this.followPending(watched.account);
    const [usdcBalance, positions] = await Promise.all([
      publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [watched.account],
      }),
      Promise.all(
        venues.map(async (venue): Promise<VenuePosition> => {
          const [positionHealth, , debtUsd] = await publicClient.readContract({
            address: venue,
            abi: venueAbi,
            functionName: "health",
            args: [watched.owner],
          });
          return { healthFactor: positionHealth, debtUsd };
        }),
      ),
    ]);

    const decision = decide({ usdcBalance, positions, thresholds });
    const lowest = positions.reduce(
      (min, position) => (position.healthFactor < min ? position.healthFactor : min),
      2n ** 256n - 1n,
    );
    this.logOnce(watched.account, "state", describe(decision, usdcBalance, lowest));
    // The state is read and logged even for an account on hold, so that a
    // margin warning is never hidden by an earlier failed attempt.
    if (decision.action === "sweep" && this.canAttempt(watched.account)) await this.sweep(watched.account);
  }

  /**
   * Follows up on the `sweep()` sent for an account on an earlier pass:
   * records its outcome once it has a receipt, and gives up on it after
   * `PENDING_DEADLINE_MS`, since a transaction dropped from the mempool
   * never gets one.
   */
  private async followPending(account: Address): Promise<void> {
    const sent = this.pending.get(account);
    if (sent === undefined) return;
    try {
      const receipt = await this.options.publicClient.getTransactionReceipt({ hash: sent.hash });
      this.settle(account, sent.hash, receipt.status === "success");
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      if (this.now() - sent.sentAt < PENDING_DEADLINE_MS) {
        this.logOnce(account, "sweep", `sweep() ${sent.hash} still pending, waiting for it`);
        return;
      }
      this.pending.delete(account);
      this.recordFailure(account, `sweep() ${sent.hash} has no receipt after 5 min, treating it as lost`);
    }
  }

  /**
   * Tells whether a new `sweep()` may be attempted on an account: not while
   * an earlier one is still pending (a second transaction would pay gas for
   * the same funds), and not before the retry delay after a failure.
   */
  private canAttempt(account: Address): boolean {
    if (this.pending.has(account)) return false;
    const failure = this.failures.get(account);
    return failure === undefined || this.now() >= failure.retryAt;
  }

  /**
   * Simulates `sweep()`, sends it if it repays enough to be worth its gas,
   * and waits for it so that the next pass reads the updated balance.
   */
  private async sweep(account: Address): Promise<void> {
    const { publicClient, walletClient, log } = this.options;
    const { request, result: expected } = await publicClient.simulateContract({
      address: account,
      abi: accountAbi,
      functionName: "sweep",
      account: walletClient?.account,
    });
    // The balance can exceed what sweep() applies, for example when the debt
    // is smaller or was taken outside Ardoise: decide on the simulated amount.
    if (expected < MIN_SWEEP_AMOUNT) {
      this.logOnce(account, "sweep", `sweep() would repay only ${usdc(expected)}, not sent`);
      return;
    }
    if (walletClient === null) {
      this.logOnce(account, "sweep", `sweep() would repay ${usdc(expected)}; not sent, no keeper key configured`);
      return;
    }

    let hash: Hash;
    try {
      hash = await walletClient.writeContract(request);
    } catch (error) {
      this.recordFailure(account, `sending sweep() failed: ${errorMessage(error)}`);
      return;
    }
    this.pending.set(account, { hash, sentAt: this.now() });
    log(`account ${account}: sweep() sent in ${hash}, expected to repay ${usdc(expected)}`);
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: this.options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS,
      });
      this.settle(account, hash, receipt.status === "success");
    } catch (error) {
      // Still pending: the account stays on hold until `followPending`
      // sees the receipt or gives up on it.
      log(`account ${account}: sweep() ${hash} not confirmed yet: ${errorMessage(error)}`);
    }
  }

  /** Records the outcome of a `sweep()` transaction that reached a block. */
  private settle(account: Address, hash: Hash, success: boolean): void {
    this.pending.delete(account);
    this.lastLogged.delete(`${account}:sweep`);
    if (success) {
      this.failures.delete(account);
      this.options.log(`account ${account}: sweep() confirmed in ${hash}`);
    } else {
      this.recordFailure(account, `sweep() reverted in ${hash}`);
    }
  }

  /**
   * Puts an account on hold after a failed attempt, doubling the wait each
   * time, so that a `sweep()` that keeps failing cannot empty the keeper
   * wallet in gas.
   */
  private recordFailure(account: Address, what: string): void {
    const count = (this.failures.get(account)?.count ?? 0) + 1;
    const delay = Math.min(FIRST_RETRY_DELAY_MS * 2 ** (count - 1), MAX_RETRY_DELAY_MS);
    this.failures.set(account, { count, retryAt: this.now() + delay });
    this.options.log(`account ${account}: ${what}; next attempt in ${Math.round(delay / 60_000)} min`);
  }

  /** Logs that `subject` works again if a failure was logged on this topic, and forgets it. */
  private logRecovery(subject: Address, topic: string, message: string): void {
    if (!this.lastLogged.delete(`${subject}:${topic}`)) return;
    this.options.log(topic === "guard" ? message : `account ${subject}: ${message}`);
  }

  /** Logs a line about `subject` unless it repeats the last one on the same topic. */
  private logOnce(subject: Address, topic: string, message: string): void {
    const key = `${subject}:${topic}`;
    if (this.lastLogged.get(key) === message) return;
    this.lastLogged.set(key, message);
    this.options.log(topic === "guard" ? message : `account ${subject}: ${message}`);
  }
}

/** One log line for a decision. */
function describe(decision: Decision, usdcBalance: bigint, lowestHealthFactor: bigint): string {
  const state = `health factor ${healthFactor(lowestHealthFactor)}, balance ${usdc(usdcBalance)}`;
  const missing = decision.shortfall > 0n ? `, ${usdc(decision.shortfall)} missing to reach the target` : "";
  switch (decision.reason) {
    case "restore-margin":
      return `${state}: under the minimum, sweeping the balance${missing}`;
    case "repay-idle-balance":
      return `${state}: sweeping the idle balance into the debt`;
    case "underfunded":
      return `${state}: under the minimum but nothing to repay with${missing}`;
    case "no-debt":
      return `${state}: no debt, nothing to do`;
    case "no-balance":
      return `${state}: margin is fine, nothing to repay with`;
    case "dust":
      return `${state}: balance too small to be worth a transaction`;
  }
}

/**
 * Message of an error, cut to its first line: viem puts the request details,
 * including the RPC URL (which may embed a key), on the following lines.
 *
 * @param error Anything thrown.
 * @returns A one-line message safe to log.
 */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}
