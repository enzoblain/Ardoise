import { isAddress, pad, type Address, type Hex, type Log } from "viem";

/**
 * App-side view of the contract interfaces in contracts/src/interfaces
 * (see docs/api.md). Units follow the contracts: USDC amounts in 6 decimals,
 * rates in basis points, health factors and USD values in WAD.
 */

export const WAD = 10n ** 18n;
/** `type(uint256).max`: the health factor of a position without debt. */
export const NO_DEBT_HEALTH = 2n ** 256n - 1n;
const USDC_TO_WAD = 10n ** 12n;

/** A lending venue, as `IVenue` exposes it. */
export interface Venue {
  id: string;
  /**
   * Address `Paid` events carry as `venue`: the `IVenue` adapter. A venue
   * with no adapter yet (Morpho, R5) uses its protocol contract and is shown
   * for comparison only.
   */
  address: Address;
  name: string;
  /** Yearly borrow rate (APR) in basis points. */
  rateBps: number;
  /** Borrowable USDC right now, 6 decimals. */
  available: bigint;
  /** False when the account cannot borrow there yet (no adapter); shown for comparison. Defaults to true. */
  borrowable?: boolean;
}

/** `IArdoise.health(venue)`. */
export interface Health {
  healthFactor: bigint;
  collateralUsd: bigint;
  debtUsd: bigint;
}

/** `IArdoise.caps()`. */
export interface Caps {
  perPayment: bigint;
  daily: bigint;
  spentToday: bigint;
}

/** `DebtLine` in IArdoise.sol. */
export interface DebtLine {
  id: bigint;
  venue: Venue;
  principal: bigint;
  repaid: bigint;
  accruedInterest: bigint;
  rateBps: number;
  destinationDomain: number;
  openedAt: number;
  payee: Hex;
  memo: string;
  /** Transaction of the payment, when it was sent on chain. */
  transactionHash?: Hex;
}

/** Arguments of `IArdoise.pay()`, with the payee as an EVM address. */
export interface PaymentRequest {
  amount: bigint;
  destinationDomain: number;
  payee: Address;
  maxFee: bigint;
  memo: string;
}

/** Contract errors `pay()` can revert with, by name. */
export type PaymentError =
  | { code: "InvalidPayee" }
  | { code: "CapExceeded"; remaining: bigint }
  | { code: "NoVenueAvailable" }
  | { code: "PaymentRefused"; allowed: bigint }
  /** No guard is set on the factory yet, so every payment reverts. */
  | { code: "GuardNotSet" }
  /** A payment on Arc carries no CCTP fee. */
  | { code: "FeeOnArc" }
  | { code: "ZeroAmount" }
  /** Any other revert (a missing Aave allowance, for example), with its message. */
  | { code: "Reverted"; message: string };

/** What `pay()` would do, computed before sending it. */
export interface PaymentQuote {
  /** `amount + maxFee`: what the account borrows. */
  borrow: bigint;
  /** `bestVenue(borrow)`, when one qualifies. */
  venue?: Venue;
  /** `health(venue)`: the position on the chosen venue before the payment. */
  healthBefore?: Health;
  /** Health factor on `venue` after borrowing `borrow`. */
  healthAfter?: bigint;
  /** Minimum health factor the guard allows after a payment; `null` without a guard. */
  minHealthFactor: bigint | null;
  /** Why `pay()` would revert, if it would. */
  error?: PaymentError;
}

/**
 * The account operations the app needs: the in-browser mock (`mockArdoise`)
 * for the demo account, the deployed contracts (`chainArdoise`) once a
 * wallet is connected.
 */
export interface ArdoiseClient {
  /** True for the in-browser mock, so the UI can say the data is simulated. */
  readonly simulated: boolean;
  /**
   * `IArdoise.health(venue)`: Aave V4 and Morpho are separate positions,
   * each with its own liquidation threshold.
   * @param venueId Venue to read.
   */
  health(venueId: string): Promise<Health>;
  /** `IGuard.minHealthFactor()`: lowest health factor a payment may leave; `null` while no guard is set. */
  minHealthFactor(): Promise<bigint | null>;
  /**
   * Simulated collateral price drop the guard applies for the demo, in basis
   * points; 0 when the simulation is off. `health()` and `quote()` already
   * reflect it, the way the guard judges positions.
   */
  simulatedDropBps(): Promise<number>;
  caps(): Promise<Caps>;
  lines(): Promise<DebtLine[]>;
  quote(request: PaymentRequest): Promise<PaymentQuote>;
  /**
   * The account's `Paid` and `LineRepaid` logs, with the time of each block
   * they were emitted in; the statement is built from them.
   * @returns `account` is the address that emitted the logs.
   */
  events(): Promise<{ account: Address; logs: Log[]; blockTimes: Map<bigint, number> }>;
  /**
   * Sends the payment.
   * @returns The debt line it opened (`IArdoise.line(lineId)`), with the
   *   payment's transaction when it was sent on chain.
   * @throws {PaymentFailed} With the contract error that refused it.
   * @throws {PaymentUnconfirmed} When the transaction was sent but its
   *   outcome could not be read.
   */
  pay(request: PaymentRequest): Promise<DebtLine>;
}

/**
 * Thrown by `ArdoiseClient.pay` when the payment was sent but its outcome
 * could not be confirmed. It may well have gone through: the UI must show
 * the transaction and not offer to pay again.
 */
export class PaymentUnconfirmed extends Error {
  constructor(
    readonly transactionHash: Hex,
    cause: string,
  ) {
    super(cause);
  }
}

/** Thrown by `ArdoiseClient.pay` with the contract error that refused it. */
export class PaymentFailed extends Error {
  constructor(readonly reason: PaymentError) {
    super(reason.code);
  }
}

/**
 * Share of the collateral's borrowing power still unused: 1 - 1 / health
 * factor. 0 means liquidation, 1 means no debt.
 *
 * @param healthFactor Health factor in WAD.
 * @returns The margin between 0 and 1.
 */
export function marginFromHealth(healthFactor: bigint): number {
  if (healthFactor >= NO_DEBT_HEALTH) return 1;
  if (healthFactor <= WAD) return 0;
  return 1 - Number((WAD * 1_000_000n) / healthFactor) / 1_000_000;
}

/**
 * Converts a USDC amount to a USD value in WAD, counting 1 USDC as 1 USD.
 *
 * @param usdc Amount in USDC units (6 decimals).
 * @returns The USD value in WAD.
 */
export function usdcToUsd(usdc: bigint): bigint {
  return usdc * USDC_TO_WAD;
}

/**
 * Converts a USD value in WAD to USDC units, rounding down.
 *
 * @param usd USD value in WAD.
 * @returns The amount in USDC units (6 decimals).
 */
export function usdToUsdc(usd: bigint): bigint {
  return usd / USDC_TO_WAD;
}

/**
 * Encodes a payee for `pay()`: CCTP-style bytes32, left-padded.
 *
 * @param payee EVM address of the payee.
 * @returns The payee as lowercase bytes32.
 * @throws If `payee` is not a valid address.
 */
export function payeeToBytes32(payee: Address): Hex {
  if (!isAddress(payee)) throw new Error(`Invalid payee ${payee}`);
  return pad(payee.toLowerCase() as Address, { size: 32 });
}
