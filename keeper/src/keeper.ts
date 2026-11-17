import {
  formatUnits,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

import { accountAbi, erc20Abi, factoryAbi, guardAbi, venueAbi } from "./abis.js";
import { USDC_ADDRESS } from "./config.js";
import { decide, type Decision, type Thresholds, type VenuePosition } from "./decision.js";

/**
 * Largest block range asked in one `eth_getLogs` call. Public RPC endpoints
 * reject wide ranges, so the account history is read in slices.
 */
const LOG_RANGE = 10_000n;

/** An Ardoise account and the wallet that owns it and its collateral. */
interface WatchedAccount {
  owner: Address;
  account: Address;
}

export interface KeeperOptions {
  publicClient: PublicClient<Transport, Chain>;
  /** Wallet that sends `sweep()`, or `null` to only log what would be sent. */
  walletClient: WalletClient<Transport, Chain, Account> | null;
  factory: Address;
  /** First block to read `AccountCreated` logs from. */
  fromBlock: bigint;
  log: (message: string) => void;
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
 * funds and has no right to borrow, withdraw or move anything.
 */
export class Keeper {
  private readonly accounts = new Map<Address, WatchedAccount>();
  private nextLogBlock: bigint;
  /** Last decision logged per account, to log changes instead of every pass. */
  private readonly lastLogged = new Map<Address, string>();

  constructor(private readonly options: KeeperOptions) {
    this.nextLogBlock = options.fromBlock;
  }

  /**
   * One pass: picks up new accounts, then checks every known account and
   * sweeps those that need it, one transaction at a time.
   *
   * @throws If the factory, the guard or the log query cannot be read; the
   * caller retries on the next pass. A failure on a single account is logged
   * and does not stop the others.
   */
  async tick(): Promise<void> {
    const { publicClient, factory } = this.options;
    await this.discoverAccounts(await publicClient.getBlockNumber());
    if (this.accounts.size === 0) return;

    const [venues, guard] = await Promise.all([
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "venues" }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "guard" }),
    ]);
    const thresholds = await this.readThresholds(guard);

    for (const watched of this.accounts.values()) {
      try {
        await this.checkAccount(watched, venues, thresholds);
      } catch (error) {
        this.options.log(`account ${watched.account}: check failed: ${errorMessage(error)}`);
      }
    }
  }

  /** Reads `AccountCreated` logs from the last block read up to `latest`. */
  private async discoverAccounts(latest: bigint): Promise<void> {
    const { publicClient, factory, log } = this.options;
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
  }

  /** Reads the guard thresholds; `null` while the factory has no guard. */
  private async readThresholds(guard: Address): Promise<Thresholds | null> {
    if (guard === zeroAddress) return null;
    const { publicClient } = this.options;
    const [minHealthFactor, targetHealthFactor] = await Promise.all([
      publicClient.readContract({ address: guard, abi: guardAbi, functionName: "minHealthFactor" }),
      publicClient.readContract({ address: guard, abi: guardAbi, functionName: "targetHealthFactor" }),
    ]);
    return { minHealthFactor, targetHealthFactor };
  }

  /** Reads one account's state, decides, and sweeps if the decision says so. */
  private async checkAccount(
    watched: WatchedAccount,
    venues: readonly Address[],
    thresholds: Thresholds | null,
  ): Promise<void> {
    const { publicClient, log } = this.options;
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
    const summary = describe(decision, usdcBalance, lowest);
    if (decision.action === "sweep" || this.lastLogged.get(watched.account) !== summary) {
      log(`account ${watched.account}: ${summary}`);
      this.lastLogged.set(watched.account, summary);
    }
    if (decision.action === "sweep") await this.sweep(watched.account);
  }

  /**
   * Sends `sweep()` and waits for it, so that the next pass reads the
   * updated balance instead of sending a second transaction for the same
   * funds.
   */
  private async sweep(account: Address): Promise<void> {
    const { publicClient, walletClient, log } = this.options;
    const { request, result: expected } = await publicClient.simulateContract({
      address: account,
      abi: accountAbi,
      functionName: "sweep",
      account: walletClient?.account,
    });
    if (expected === 0n) {
      log(`account ${account}: sweep() would repay nothing, not sent`);
      return;
    }
    if (walletClient === null) {
      log(`account ${account}: sweep() would repay ${usdc(expected)}; not sent, no keeper key configured`);
      return;
    }
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(
      receipt.status === "success"
        ? `account ${account}: sweep() repaid about ${usdc(expected)} in ${hash}`
        : `account ${account}: sweep() reverted in ${hash}`,
    );
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

/** First line of an error, which for viem errors never includes the transport's headers. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}
