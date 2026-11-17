import { isAddress, pad, type Address, type Hex } from "viem";

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
  name: string;
  /** Yearly borrow rate (APR) in basis points. */
  rateBps: number;
  /** Borrowable USDC right now, 6 decimals. */
  available: bigint;
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
  | { code: "PaymentRefused"; allowed: bigint };

/** What `pay()` would do, computed before sending it. */
export interface PaymentQuote {
  /** `amount + maxFee`: what the account borrows. */
  borrow: bigint;
  /** `bestVenue(borrow)`, when one qualifies. */
  venue?: Venue;
  healthBefore: Health;
  /** Health factor after borrowing `borrow` on `venue`. */
  healthAfter?: bigint;
  /** Minimum health factor the guard allows after a payment. */
  minHealthFactor: bigint;
  /** Why `pay()` would revert, if it would. */
  error?: PaymentError;
}

/**
 * The account operations the app needs. A mock implements it until the
 * contracts are deployed (C1); the on-chain implementation comes with C4.
 */
export interface ArdoiseClient {
  /** True for the in-browser mock, so the UI can say the data is simulated. */
  readonly simulated: boolean;
  health(): Promise<Health>;
  /** `IGuard.minHealthFactor()`: lowest health factor a payment may leave. */
  minHealthFactor(): Promise<bigint>;
  caps(): Promise<Caps>;
  lines(): Promise<DebtLine[]>;
  quote(request: PaymentRequest): Promise<PaymentQuote>;
  /**
   * Sends the payment.
   * @returns The id of the new debt line.
   * @throws {PaymentFailed} With the contract error that refused it.
   */
  pay(request: PaymentRequest): Promise<bigint>;
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
