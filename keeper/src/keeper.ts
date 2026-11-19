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
import type { DefenseOutcome } from "./defense.js";
import {
  MIN_SWEEP_AMOUNT,
  applySimulatedDrop,
  debtLeftToFund,
  decide,
  type Decision,
  type Thresholds,
  type VenuePosition,
} from "./decision.js";

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
 * How long one pass waits for a `sweep()` receipt. Arc produces about two
 * blocks per second; waiting longer would only keep the other accounts from being
 * checked, and the pending transaction is picked up again on later passes.
 */
const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * Age after which a `sweep()` without receipt is treated as lost (dropped
 * from the mempool, replaced) and counted as a failed attempt, so that the
 * account is retried instead of staying on hold forever.
 */
const PENDING_DEADLINE_MS = 300_000;

/** Log topics about the guard as a whole, printed without an account prefix. */
const GLOBAL_TOPICS = new Set(["guard", "simulation"]);

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
  /**
   * Draws USDC from the owner's Gateway balance when the account lacks it
   * (B4), or `undefined` when no standing orders are configured.
   */
  gateway?: {
    fund(owner: Address, account: Address, shortfall: bigint, maxDraw: bigint): Promise<void>;
    /** Whether Gateway is still taking care of the account's shortfall. */
    isCovering(account: Address): boolean;
  };
  /**
   * Raises a CCTP defense alarm for the owner and relays it to Base (D2),
   * or `undefined` when `DEFENSE_ALARM_ADDRESS` is empty.
   */
  defense?: { defend(owner: Address): Promise<DefenseOutcome> };
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
 * `sweep()` is the only transaction it sends itself (the optional defense
 * relay adds the permissionless `raise(owner)` and CCTP's `receiveMessage`,
 * see `defense.ts`). It applies the account's
 * own USDC balance to the account's debt, so the keeper wallet holds no user
 * funds and has no right to borrow, withdraw or move anything. The keeper
 * wallet only pays gas, so the bookkeeping below avoids paying twice for the
 * same funds or paying again and again for a `sweep()` that fails. It does
 * not rule duplicates out: the pending transactions are only kept in memory,
 * so a second `sweep()` can be sent for the same funds after a restart, when
 * the RPC endpoint accepts a transaction but its answer is lost, or when a
 * transaction declared lost is in fact still waiting to be mined. The retry
 * delay bounds this to one transaction per delay, and a duplicate that is
 * mined costs its gas fee: `sweep()` then finds nothing left to repay.
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
      return { minHealthFactor, targetHealthFactor, simulatedDropBps: await this.readSimulatedDrop(guard) };
    } catch (error) {
      this.logOnce(guard, "guard", `guard ${guard} cannot be read, ignoring thresholds: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Reads the simulated price drop of the demo. It is an addition of
   * `MarginGuard`, not part of `IGuard`, so a guard without it means no
   * simulation. A failed read is treated the same way but is logged, since
   * during a demo it makes the keeper judge positions at the real price.
   */
  private async readSimulatedDrop(guard: Address): Promise<bigint> {
    try {
      const dropBps = await this.options.publicClient.readContract({
        address: guard,
        abi: guardAbi,
        functionName: "simulatedDropBps",
      });
      this.logOnce(
        guard,
        "simulation",
        dropBps === 0n
          ? "simulation off: positions are judged at the real collateral price"
          : `SIMULATION: collateral price -${formatUnits(dropBps, 2)}%, positions are judged as if it had dropped`,
      );
      return dropBps;
    } catch (error) {
      this.logOnce(
        guard,
        "simulation",
        `simulated drop of guard ${guard} cannot be read, assuming no simulation: ${errorMessage(error)}`,
      );
      return 0n;
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
          const [[positionHealth, , debtUsd], debt] = await Promise.all([
            publicClient.readContract({
              address: venue,
              abi: venueAbi,
              functionName: "health",
              args: [watched.owner],
            }),
            // Only the cap on Gateway draws needs this figure: a failed read
            // must not stop the sweep or the defense step.
            publicClient
              .readContract({
                address: venue,
                abi: venueAbi,
                functionName: "debtOf",
                args: [watched.owner],
              })
              .then(
                (amount) => {
                  this.logRecovery(watched.account, `debt:${venue}`, `the debt on venue ${venue} can be read again`);
                  return amount;
                },
                (error) => {
                  this.logOnce(
                    watched.account,
                    `debt:${venue}`,
                    `the debt on venue ${venue} cannot be read (${errorMessage(error)}): nothing is drawn from Gateway until it can`,
                  );
                  return null;
                },
              ),
          ]);
          return { healthFactor: positionHealth, debtUsd, debt };
        }),
      ),
    ]);

    const state = { usdcBalance, positions, thresholds };
    const decision = decide(state);
    const dropBps = thresholds?.simulatedDropBps ?? 0n;
    const lowest = positions
      .map((position) => applySimulatedDrop(position, dropBps).healthFactor)
      .reduce((min, value) => (value < min ? value : min), 2n ** 256n - 1n);
    const mayAttempt = this.canAttempt(watched.account);
    const onHold = decision.action === "sweep" && !mayAttempt ? " (on hold after an earlier attempt)" : "";
    const simulated = dropBps > 0n ? "[SIMULATION] " : "";
    this.logOnce(watched.account, "state", simulated + describe(decision, usdcBalance, lowest) + onHold);
    // A new sweep decision must be reported again even if it repeats an older one.
    if (decision.action !== "sweep" && !this.pending.has(watched.account)) {
      this.lastLogged.delete(`${watched.account}:sweep`);
    }
    // The state is read and logged even for an account on hold, so that a
    // margin warning is never hidden by an earlier failed attempt.
    // A sweep that restores a position under the guard's minimum is sent
    // whatever its size: the balance, or the debt it repays, can be under
    // the usual minimum.
    const minRepaid = decision.reason === "restore-margin" && decision.shortfall === 0n ? 1n : MIN_SWEEP_AMOUNT;
    if (decision.action === "sweep" && mayAttempt) await this.sweep(watched.account, minRepaid);
    // Called on every pass, shortfall or not, so transfers already on their
    // way are followed. USDC it brings lands on the account and is swept on
    // a later pass like any other balance.
    if (this.options.gateway !== undefined) {
      try {
        // Capped at the debt left once the balance is applied: USDC brought
        // beyond the debt would stay on the account, for good on accounts of
        // earlier factories (no withdrawal) and until the owner withdraws it
        // by hand on the current one.
        // Without a debt figure nothing is drawn, but the call is still made
        // so that transfers on their way are followed.
        const maxDraw = debtLeftToFund(state);
        await this.options.gateway.fund(watched.owner, watched.account, maxDraw === null ? 0n : decision.shortfall, maxDraw ?? 0n);
      } catch (error) {
        this.logOnce(watched.account, "gateway", `Gateway funding failed: ${errorMessage(error)}`);
      }
    }
    // Third step, only once the account has nothing to repay with and Gateway
    // cannot cover the shortfall (no order left, every order larger than the
    // debt left, reserve too low).
    if (
      this.options.defense !== undefined &&
      decision.reason === "underfunded" &&
      !(this.options.gateway?.isCovering(watched.account) ?? false)
    ) {
      const outcome = await this.options.defense.defend(watched.owner);
      // The alarm's own sweep would restore the position, but it is rolled
      // back with the `PositionHealthy` revert: sweep the account directly.
      // That balance can be under the usual minimum and still be all that
      // the position needs.
      if (outcome === "sweep" && this.canAttempt(watched.account)) await this.sweep(watched.account, 1n);
    }
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
      this.lastLogged.delete(`${account}:sweep`);
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
   * Simulates `sweep()`, sends it if it repays at least `minRepaid` (what
   * makes it worth its gas), and waits for it so that the next pass reads
   * the updated balance.
   */
  private async sweep(account: Address, minRepaid: bigint): Promise<void> {
    const { publicClient, walletClient, log } = this.options;
    const { request, result: expected } = await publicClient.simulateContract({
      address: account,
      abi: accountAbi,
      functionName: "sweep",
      account: walletClient?.account,
    });
    // The balance can exceed what sweep() applies, for example when the debt
    // is smaller or was taken outside Ardoise: decide on the simulated amount.
    if (expected < minRepaid) {
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
    this.options.log(GLOBAL_TOPICS.has(topic) ? message : `account ${subject}: ${message}`);
  }

  /** Logs a line about `subject` unless it repeats the last one on the same topic. */
  private logOnce(subject: Address, topic: string, message: string): void {
    const key = `${subject}:${topic}`;
    if (this.lastLogged.get(key) === message) return;
    this.lastLogged.set(key, message);
    this.options.log(GLOBAL_TOPICS.has(topic) ? message : `account ${subject}: ${message}`);
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
    case "unrepayable":
      return `${state}: WARNING, under the minimum with no USDC debt on that venue: the keeper cannot repay it`;
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
