import { getAddress, isAddress, type Address } from "viem";

/** Chains a payment request can ask to be paid on, as `PayoutChain.key`. */
export type RequestChain = "arc" | "base";

/**
 * A payment request: what a payee asks to be paid, shared as a link that opens
 * the pay screen already filled in. It is only a link: nothing is stored or
 * sent on chain until the payer pays.
 */
export interface PaymentRequest {
  /** Address that receives the USDC. */
  payee: Address;
  /** Chain the payee wants the USDC on. */
  chain: RequestChain;
  /** Amount in USDC as a decimal string (at most 6 decimals); absent to let the payer choose. */
  amount?: string;
  /** Text shown on the payer's statement, for example an invoice number. */
  memo?: string;
}

/** Longest memo the pay screen accepts. */
export const MAX_MEMO_LENGTH = 120;

const AMOUNT = /^\d+(\.\d{1,6})?$/;

/**
 * Checks an amount typed for a request.
 *
 * @param text Amount in USDC, as typed.
 * @returns Whether it is a positive amount with at most 6 decimals.
 */
export function isRequestAmount(text: string): boolean {
  return AMOUNT.test(text) && Number(text) > 0;
}

/**
 * Builds the link that opens the pay screen with this request filled in.
 *
 * @param origin Site origin, for example `https://ardoise-rust.vercel.app`.
 * @param request The request; `amount` and `memo` are left out when empty.
 * @returns An absolute URL to `/app` with the request in its query string.
 */
export function buildRequestUrl(origin: string, request: PaymentRequest): string {
  const url = new URL("/app", origin);
  url.searchParams.set("to", request.payee);
  url.searchParams.set("chain", request.chain);
  if (request.amount) url.searchParams.set("amount", request.amount);
  const memo = request.memo?.trim();
  if (memo) url.searchParams.set("memo", memo.slice(0, MAX_MEMO_LENGTH));
  return url.toString();
}

/**
 * Reads a request from the query string of `/app`. Anything invalid is
 * dropped rather than shown, since the link comes from someone else: a
 * request without a valid payee is no request, a bad amount or chain is
 * ignored, and the memo is cut to the length the pay screen accepts.
 *
 * @param params The page's search params, as Next.js passes them.
 * @returns The request, or `undefined` if the link carries none.
 */
export function parseRequest(params: Record<string, string | string[] | undefined>): PaymentRequest | undefined {
  const first = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const to = first("to");
  if (!to || !isAddress(to)) return undefined;
  const amount = first("amount");
  const memo = first("memo")?.trim().slice(0, MAX_MEMO_LENGTH);
  return {
    payee: getAddress(to),
    chain: first("chain") === "arc" ? "arc" : "base",
    amount: amount && isRequestAmount(amount) ? amount : undefined,
    memo: memo || undefined,
  };
}
