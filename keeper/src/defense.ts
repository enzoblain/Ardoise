import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  formatUnits,
  isHex,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";

import { defenseAlarmAbi, defenseRelayAbi } from "./abis.js";
import type { Fetch } from "./gateway.js";
import { errorMessage } from "./keeper.js";

/**
 * Relay of the CCTP-attested defense (task D2 in docs/roadmap.md), the
 * keeper's third defense step after `sweep()` and the Gateway standing orders.
 *
 * When a position is still under the guard's minimum and Gateway cannot
 * cover it, the relay calls the permissionless `DefenseAlarm.raise(owner)` on
 * Arc, waits for Circle's attestation of the message the alarm sent, and
 * delivers it with `MessageTransmitterV2.receiveMessage` on Base, where the
 * owner's `DefenseExecutor` policy burns USDC back to their Ardoise account.
 *
 * The relay decides nothing about funds: the alarm measures the shortfall on
 * chain, the message bytes are Circle's and are relayed unchanged, and the
 * executor only pays the account named in that attested message. The keeper
 * wallet only pays gas on both chains.
 *
 * See *CCTP-attested defense* in docs/api.md.
 */

/** CCTP V2 MessageTransmitterV2, at the same address on Arc and Base mainnet. */
export const MESSAGE_TRANSMITTER_V2: Address = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

/** Circle's attestation service (Iris) on mainnet. */
export const IRIS_MAINNET = "https://iris-api.circle.com";

/** CCTP domain of Arc, the source of every alarm. */
export const ARC_CCTP_DOMAIN = 26;

/** First wait between two Iris polls; doubles up to `MAX_POLL_DELAY_MS`. */
const FIRST_POLL_DELAY_MS = 2_000;
const MAX_POLL_DELAY_MS = 30_000;

/** Longest wait for one Iris request. */
const IRIS_TIMEOUT_MS = 10_000;

/**
 * `receiveMessage` transactions that reverted or were lost before the alarm
 * is given up on. Failed simulations spend no gas and do not count: they are
 * retried until the alarm expires.
 */
const MAX_FAILED_DELIVERIES = 5;

/**
 * Executor reverts that depend on the block a delivery lands in (pool price,
 * gas left, oracle age), not on the message: a transaction that reverted on
 * chain is put down to one of them, and not counted as a failed delivery,
 * when the next simulation fails with it.
 */
const TRANSIENT_REVERTS: ReadonlySet<string> = new Set(["SwapFailed", "SwapOutOfGas", "StalePrice"]);

/** First wait after a failed delivery attempt; doubles up to `MAX_RELAY_RETRY_MS`. */
const FIRST_RELAY_RETRY_MS = 5_000;
const MAX_RELAY_RETRY_MS = 60_000;

/** First wait after a failed `raise` (not a cooldown); doubles up to `MAX_RAISE_RETRY_MS`. */
const FIRST_RAISE_RETRY_MS = 60_000;
const MAX_RAISE_RETRY_MS = 3_600_000;

/**
 * Margin added to the gas estimate of `raise`: the alarm calls the account's
 * `sweep()` first and reverts with `SweepOutOfGas` when the forwarded gas
 * runs short, so a tight estimate would fail on chain.
 */
const RAISE_GAS_HEADROOM_PERCENT = 130n;

/**
 * Margin added to the gas estimate of `receiveMessage`, a complement to the
 * executor's own gas floor (PR #48: at least `MIN_SWAP_GAS`, 300k, before a
 * swap, plus a 63/64 check, else it reverts with `SwapOutOfGas`). Without
 * that floor, the swaps' `try/catch` lets `eth_estimateGas` settle on a limit
 * where the WETH swap is skipped and the alarm consumed; with it, a short
 * limit reverts instead, and the headroom keeps deliveries off that revert.
 * A `SwapOutOfGas` revert is retried like any other failure.
 */
const RELAY_GAS_HEADROOM_PERCENT = 150n;

/**
 * Age after which a sent transaction without receipt (`raise` or
 * `receiveMessage`) is treated as lost. Until then the relay keeps following
 * the same hash instead of sending again, and the owner stays on hold.
 */
const PENDING_DEADLINE_MS = 300_000;

/** Seconds added to a `TooSoon` time before retrying, so that Base's next block is past it. */
const TOO_SOON_MARGIN_S = 5;

/** Shortest wait after a `TooSoon` revert, whatever the local clock says. */
const MIN_TOO_SOON_WAIT_MS = 5_000;

/** What `defend` did for an owner on this pass. */
export type DefenseOutcome =
  /** An alarm was raised; its relay runs in the background. */
  | "raised"
  /** Nothing to do now: a relay is running, the alarm is cooling down, or a retry is scheduled. */
  | "waiting"
  /** `raise` found the position healthy once the account's balance is applied: call `sweep()`. */
  | "sweep"
  /** No keeper key: the alarm that would be raised was logged, nothing was sent. */
  | "dry-run"
  /** `raise` failed; it is tried again after a growing delay. */
  | "failed";

/** What the relay needs. */
export interface DefenseRelayOptions {
  /** Arc client: simulations, gas estimates and receipts of `raise`. */
  arcClient: PublicClient<Transport, Chain>;
  /** Arc wallet that sends `raise`, or `null` for a dry run. */
  arcWallet: WalletClient<Transport, Chain, Account> | null;
  /** Base client: simulations and receipts of `receiveMessage`. */
  baseClient: PublicClient<Transport, Chain>;
  /** Base wallet (same keeper key) that sends `receiveMessage`, or `null` for a dry run. */
  baseWallet: WalletClient<Transport, Chain, Account> | null;
  /** `DefenseAlarm` on Arc. */
  alarm: Address;
  log: (message: string) => void;
  /** MessageTransmitterV2 on Base. Defaults to `MESSAGE_TRANSMITTER_V2`. */
  messageTransmitter?: Address;
  /** Iris base URL. Defaults to `IRIS_MAINNET`. */
  irisUrl?: string;
  fetch?: Fetch;
  /** Clock in milliseconds, replaceable in tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Waits between polls and retries, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** An alarm read from its `AlarmRaised` event. */
interface Alarm {
  owner: Address;
  account: Address;
  amountNeeded: bigint;
  nonce: bigint;
  /** Unix time in seconds after which the executor ignores the alarm. */
  expiry: bigint;
  /** The `raise` transaction, which Iris indexes the message by. */
  txHash: Hash;
}

/** Circle's attested message, as Iris returns it. */
export interface AttestedMessage {
  message: Hex;
  attestation: Hex;
}

/** Per-owner state that keeps one alarm and one relay at a time. */
interface OwnerState {
  /** Background relay of the last alarm, while it runs. */
  relay?: Promise<void>;
  /** Unix time in seconds before which `raise` reverts with `CoolingDown`. */
  coolingUntil?: bigint;
  /** Consecutive failed `raise` attempts and the time (ms) before which not to retry. */
  failures?: { count: number; retryAt: number };
}

/**
 * Raises defense alarms and relays their attested messages to Base.
 *
 * State is kept in memory per owner: one relay at a time, no `raise` while
 * one runs or while the alarm's cooldown lasts. The alarm itself enforces
 * the cooldown on chain, so a restart cannot cause a second alarm for the
 * same shortfall, only lose the relay of one already raised (anyone can
 * relay it by hand from the `raise` transaction until it expires).
 */
export class DefenseRelay {
  private readonly owners = new Map<Address, OwnerState>();
  private readonly lastLogged = new Map<string, string>();
  /** Chain of Base transactions, so concurrent relays never race on the wallet's nonce. */
  private baseQueue: Promise<unknown> = Promise.resolve();
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly transmitter: Address;
  private readonly irisUrl: string;

  constructor(private readonly options: DefenseRelayOptions) {
    this.fetchImpl = options.fetch ?? (fetch as unknown as Fetch);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.transmitter = options.messageTransmitter ?? MESSAGE_TRANSMITTER_V2;
    this.irisUrl = options.irisUrl ?? IRIS_MAINNET;
  }

  /**
   * Third defense step for one owner, called by the keeper on every pass
   * where the position is under the guard's minimum, the account holds
   * nothing to repay with and Gateway is not covering the shortfall.
   *
   * Simulates `raise(owner)` first. On success, sends it and starts the
   * relay in the background (Iris, then Base), so the keeper's pass is not
   * held up while Circle attests the message.
   *
   * @param owner Owner of the position.
   * @returns What was done; on `sweep`, the caller sweeps the account.
   */
  async defend(owner: Address): Promise<DefenseOutcome> {
    const state = this.state(owner);
    if (state.relay !== undefined) return "waiting";
    if (state.coolingUntil !== undefined && this.seconds() < state.coolingUntil) return "waiting";
    if (state.failures !== undefined && this.now() < state.failures.retryAt) return "waiting";

    const { arcClient, arcWallet, alarm } = this.options;
    let expectedNonce: bigint;
    try {
      ({ result: expectedNonce } = await arcClient.simulateContract({
        address: alarm,
        abi: defenseAlarmAbi,
        functionName: "raise",
        args: [owner],
        account: arcWallet?.account,
      }));
    } catch (error) {
      const reverted = revertOf(error);
      if (reverted?.errorName === "CoolingDown") {
        state.coolingUntil = reverted.args[0] as bigint;
        this.logOnce(owner, "alarm", `defense alarm cooling down until ${isoTime(state.coolingUntil)}`);
        return "waiting";
      }
      if (reverted?.errorName === "PositionHealthy") {
        this.logOnce(owner, "alarm", "defense alarm not needed: the balance on the account restores the position");
        return "sweep";
      }
      this.recordRaiseFailure(owner, `simulating raise() failed: ${reverted?.errorName ?? errorMessage(error)}`);
      return "failed";
    }

    if (arcWallet === null || this.options.baseWallet === null) {
      this.logOnce(owner, "alarm", `would raise defense alarm #${expectedNonce}; dry run, nothing sent`);
      return "dry-run";
    }

    let hash: Hash;
    try {
      const gas = await arcClient.estimateContractGas({
        address: alarm,
        abi: defenseAlarmAbi,
        functionName: "raise",
        args: [owner],
        account: arcWallet.account,
      });
      hash = await arcWallet.writeContract({
        address: alarm,
        abi: defenseAlarmAbi,
        functionName: "raise",
        args: [owner],
        gas: (gas * RAISE_GAS_HEADROOM_PERCENT) / 100n,
      });
    } catch (error) {
      this.recordRaiseFailure(owner, `sending raise() failed: ${revertOf(error)?.errorName ?? errorMessage(error)}`);
      return "failed";
    }
    state.failures = undefined;
    this.lastLogged.delete(`${owner}:alarm`);
    this.options.log(`owner ${owner}: defense alarm raise() sent in ${hash}`);
    state.relay = this.relay(owner, hash)
      .catch((error: unknown) => this.options.log(`owner ${owner}: defense relay stopped: ${errorMessage(error)}`))
      .finally(() => {
        state.relay = undefined;
      });
    return "raised";
  }

  /**
   * Waits for every relay running now, so that tests can check their outcome.
   *
   * @returns Resolves once they have all ended; never rejects.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.owners.values()].map((state) => state.relay));
  }

  /** Background part: the `raise` receipt, Circle's attestation, then delivery on Base. */
  private async relay(owner: Address, hash: Hash): Promise<void> {
    const { arcClient, alarm, log } = this.options;
    // The owner stays on hold (`state.relay` is set) while the hash is followed,
    // so a slow `raise` is never sent a second time.
    const receipt = await this.followReceipt(arcClient, owner, hash);
    if (receipt === null) {
      this.recordRaiseFailure(owner, `raise() ${hash} has no receipt after 5 min, treating it as lost`);
      return;
    }
    if (receipt.status !== "success") {
      this.recordRaiseFailure(owner, `raise() reverted in ${hash}`);
      return;
    }
    const [event] = parseEventLogs({ abi: defenseAlarmAbi, eventName: "AlarmRaised", logs: receipt.logs }).filter(
      (entry) => entry.address.toLowerCase() === alarm.toLowerCase(),
    );
    if (event === undefined) throw new Error(`no AlarmRaised event in ${hash}`);
    const alarmRaised: Alarm = { ...event.args, txHash: hash };
    // The cooldown starts with the alarm; reading it saves a doomed simulation per pass.
    this.state(owner).coolingUntil = await arcClient
      .readContract({ address: alarm, abi: defenseAlarmAbi, functionName: "cooldown", args: [owner] })
      .catch(() => alarmRaised.expiry);
    log(
      `owner ${owner}: defense alarm #${alarmRaised.nonce} raised for ${formatUnits(alarmRaised.amountNeeded, 6)} USDC ` +
        `to account ${alarmRaised.account}, valid until ${isoTime(alarmRaised.expiry)}`,
    );

    const attested = await this.waitForAttestation(alarmRaised);
    if (attested === null) return;
    await this.deliver(alarmRaised, attested);
  }

  /**
   * Polls Iris until Circle has attested the alarm's message, with a growing
   * delay, and gives up when the alarm expires: past its expiry, the
   * executor would only consume it without acting.
   *
   * @returns The message and attestation, or `null` once the alarm expired.
   */
  private async waitForAttestation(alarm: Alarm): Promise<AttestedMessage | null> {
    let delay = FIRST_POLL_DELAY_MS;
    for (;;) {
      if (this.seconds() >= alarm.expiry) {
        this.options.log(`owner ${alarm.owner}: defense alarm #${alarm.nonce} expired before Circle attested it, giving up`);
        return null;
      }
      try {
        const attested = await fetchAttestation(this.irisUrl, alarm.txHash, this.fetchImpl);
        if (attested !== null) {
          this.options.log(`owner ${alarm.owner}: defense alarm #${alarm.nonce} attested by Circle`);
          return attested;
        }
      } catch (error) {
        this.logOnce(alarm.owner, "iris", `reading the attestation failed, retrying: ${errorMessage(error)}`);
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
    }
  }

  /**
   * Delivers the attested message on Base, simulating each attempt first and
   * sending it with gas headroom. A `TooSoon` revert (the owner's last burn
   * is too recent) is retried at the time it names while the alarm is valid;
   * a message already delivered ends the relay. Other failed simulations
   * spend no gas and are retried with a growing delay until the alarm
   * expires: that covers `SwapFailed`, the executor's revert when the pool
   * price is outside the owner's slippage bound, so the alarm is delivered
   * as soon as the pool is back in line with the oracle. Transactions that
   * revert or are lost are retried up to `MAX_FAILED_DELIVERIES` times,
   * except a revert that the next simulation explains with one of
   * `TRANSIENT_REVERTS` (the pool moved between simulation and inclusion):
   * giving up on those would drop an alarm that is still deliverable. A
   * reverted `receiveMessage` leaves the CCTP nonce unused, so the same
   * bytes can be delivered on a later attempt.
   */
  private async deliver(alarm: Alarm, attested: AttestedMessage): Promise<void> {
    const { baseClient, baseWallet, log } = this.options;
    // `defend` only raises with both wallets set; this keeps the types honest.
    if (baseWallet === null) return;
    const prefix = `owner ${alarm.owner}: defense alarm #${alarm.nonce}`;
    const call = {
      address: this.transmitter,
      abi: defenseRelayAbi,
      functionName: "receiveMessage",
      args: [attested.message, attested.attestation],
      account: baseWallet.account,
    } as const;
    let failedDeliveries = 0;
    /** The last transaction reverted on chain and no simulation has run since. */
    let revertedLast = false;
    let lastFailure = "";
    let delay = FIRST_RELAY_RETRY_MS;
    const givenUp = () => {
      if (failedDeliveries < MAX_FAILED_DELIVERIES) return false;
      log(`${prefix}: delivery on Base failed ${failedDeliveries} times (${lastFailure}), giving up`);
      return true;
    };
    const retryLater = async (what: string) => {
      log(`${prefix}: delivery on Base failed (${what}), retrying in ${Math.round(delay / 1000)} s`);
      await this.sleep(delay);
      delay = Math.min(delay * 2, MAX_RELAY_RETRY_MS);
    };
    for (;;) {
      if (this.seconds() >= alarm.expiry) {
        log(`${prefix} expired before it could be delivered on Base, giving up`);
        return;
      }
      let hash: Hash;
      try {
        const { request } = await baseClient.simulateContract(call);
        // The delivery would pass now: the last revert stays counted.
        revertedLast = false;
        if (givenUp()) return;
        const gas = await baseClient.estimateContractGas(call);
        hash = await this.onBase(() =>
          baseWallet.writeContract({ ...request, gas: (gas * RELAY_GAS_HEADROOM_PERCENT) / 100n }),
        );
      } catch (error) {
        const reverted = revertOf(error);
        if (reverted?.errorName === "AlarmAlreadyUsed" || (reverted?.errorName === "Error" && /nonce already used/i.test(String(reverted.args[0])))) {
          log(`${prefix} already delivered on Base, nothing left to do`);
          return;
        }
        if (reverted?.errorName === "TooSoon") {
          const nextAllowed = (reverted.args[1] as bigint) + BigInt(TOO_SOON_MARGIN_S);
          if (nextAllowed >= alarm.expiry) {
            log(`${prefix}: the owner's last defense is too recent until ${isoTime(nextAllowed)}, after the alarm expires; giving up`);
            return;
          }
          log(`${prefix}: the owner's last defense is too recent, delivering again at ${isoTime(nextAllowed)}`);
          // A floor, so a keeper clock ahead of Base's blocks cannot spin on simulations.
          await this.sleep(Math.max(MIN_TOO_SOON_WAIT_MS, Number(nextAllowed) * 1000 - this.now()));
          continue;
        }
        if (revertedLast && reverted !== null && TRANSIENT_REVERTS.has(reverted.errorName)) failedDeliveries -= 1;
        revertedLast = false;
        if (givenUp()) return;
        // Nothing was mined: no gas spent, so keep trying while the alarm is valid.
        await retryLater(reverted?.errorName ?? errorMessage(error));
        continue;
      }

      log(`${prefix}: receiveMessage() sent on Base in ${hash}`);
      // Following the same hash, instead of simulating again, keeps a slow
      // transaction from being sent twice.
      const receipt = await this.followReceipt(baseClient, alarm.owner, hash);
      if (receipt?.status === "success") {
        log(`${prefix} delivered on Base in ${hash}: ${outcomeOf(receipt.logs, alarm.nonce)}`);
        return;
      }
      failedDeliveries += 1;
      revertedLast = receipt !== null;
      lastFailure = receipt === null ? `no receipt for ${hash} after 5 min` : `receiveMessage() reverted in ${hash}`;
      // After a revert, the next simulation decides whether it counts.
      if (!revertedLast && givenUp()) return;
      await retryLater(lastFailure);
    }
  }

  /**
   * Follows a sent transaction until it has a receipt, polling with a
   * growing delay; RPC errors are retried the same way.
   *
   * @returns The receipt, or `null` after `PENDING_DEADLINE_MS` without one.
   */
  private async followReceipt(
    client: PublicClient<Transport, Chain>,
    owner: Address,
    hash: Hash,
  ): Promise<TransactionReceipt | null> {
    const deadline = this.now() + PENDING_DEADLINE_MS;
    let delay = FIRST_POLL_DELAY_MS;
    for (;;) {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) {
          this.logOnce(owner, "receipt", `reading the receipt of ${hash} failed, retrying: ${errorMessage(error)}`);
        }
      }
      if (this.now() >= deadline) return null;
      await this.sleep(delay);
      delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
    }
  }

  /** Runs a Base transaction after the ones already queued. */
  private onBase<T>(send: () => Promise<T>): Promise<T> {
    const result = this.baseQueue.then(send);
    this.baseQueue = result.catch(() => undefined);
    return result;
  }

  /** Holds `raise` for an owner after a failure, doubling the wait each time. */
  private recordRaiseFailure(owner: Address, what: string): void {
    const state = this.state(owner);
    const count = (state.failures?.count ?? 0) + 1;
    const delay = Math.min(FIRST_RAISE_RETRY_MS * 2 ** (count - 1), MAX_RAISE_RETRY_MS);
    state.failures = { count, retryAt: this.now() + delay };
    this.lastLogged.delete(`${owner}:alarm`);
    this.options.log(`owner ${owner}: ${what}; next defense alarm attempt in ${Math.round(delay / 60_000)} min`);
  }

  private state(owner: Address): OwnerState {
    let state = this.owners.get(owner);
    if (state === undefined) {
      state = {};
      this.owners.set(owner, state);
    }
    return state;
  }

  private seconds(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  private logOnce(owner: Address, topic: string, message: string): void {
    const key = `${owner}:${topic}`;
    if (this.lastLogged.get(key) === message) return;
    this.lastLogged.set(key, message);
    this.options.log(`owner ${owner}: ${message}`);
  }
}

/**
 * Reads Circle's attestation of the message sent in an Arc transaction.
 *
 * Iris answers `GET /v2/messages/{sourceDomain}?transactionHash=` with
 * `{ messages: [{ message, attestation, status, ... }] }`, and 404 until it
 * has seen the transaction. A message is ready once its `status` is
 * `complete`; before that its attestation reads `PENDING`. A `raise`
 * transaction sends exactly one message.
 *
 * API reference: https://developers.circle.com/api-reference/cctp/all/get-messages-v2
 *
 * @param irisUrl Iris base URL.
 * @param txHash The `raise` transaction on Arc.
 * @param fetchImpl HTTP client.
 * @returns The message and attestation once complete, `null` while pending.
 * @throws When Iris answers with another error (rate limit, server error)
 *   or a malformed body; the caller polls again.
 */
export async function fetchAttestation(irisUrl: string, txHash: Hash, fetchImpl: Fetch): Promise<AttestedMessage | null> {
  const res = await fetchImpl(`${irisUrl}/v2/messages/${ARC_CCTP_DOMAIN}?transactionHash=${txHash}`, {
    signal: AbortSignal.timeout(IRIS_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Iris answered ${res.status}`);
  const body = (await res.json()) as { messages?: { message?: unknown; attestation?: unknown; status?: unknown }[] } | null;
  if (!Array.isArray(body?.messages)) throw new Error("Iris answered without a messages list");
  const [entry] = body.messages;
  if (entry === undefined || entry.status !== "complete") return null;
  if (!isHex(entry.message) || !isHex(entry.attestation)) throw new Error("Iris marked the message complete without its bytes");
  return { message: entry.message, attestation: entry.attestation };
}

/** The decoded custom error of a revert, if `error` is one. */
function revertOf(error: unknown): { errorName: string; args: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError) || reverted.data === undefined) return null;
  return { errorName: reverted.data.errorName, args: reverted.data.args ?? [] };
}

/** What the executor did with an alarm, from the logs of the delivery. */
function outcomeOf(logs: Parameters<typeof parseEventLogs>[0]["logs"], nonce: bigint): string {
  for (const event of parseEventLogs({ abi: defenseRelayAbi, logs })) {
    if (event.eventName === "DefenseExecuted" && event.args.nonce === nonce) {
      return `executor burned ${formatUnits(event.args.amount, 6)} USDC to account ${event.args.account} (fee at most ${formatUnits(event.args.maxFee, 6)} USDC)`;
    }
    if (event.eventName === "AlarmIgnored" && event.args.nonce === nonce) {
      return `executor ignored it (${IGNORE_REASONS[event.args.reason] ?? `reason ${event.args.reason}`})`;
    }
  }
  return "no executor event found";
}

/** `DefenseExecutor.IgnoreReason`, in declaration order. */
const IGNORE_REASONS = ["alarm expired", "no policy on Base", "funds on Base do not exceed the fee"];

function isoTime(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}
