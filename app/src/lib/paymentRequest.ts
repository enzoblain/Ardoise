import { getAddress, isAddress, parseUnits, type Address } from "viem";

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
  /** Random id of the request, so a payment made from it can reach the payee's waiting page. */
  id?: string;
  /** Set on the payee's own "Open as the payer" link: opening it does not start the payer's 30 s. */
  preview?: boolean;
}

/** Longest memo the pay screen accepts. */
export const MAX_MEMO_LENGTH = 120;

const AMOUNT = /^\d+(\.\d{1,6})?$/;
const REQUEST_ID = /^[a-z0-9]{8,32}$/;
// Bidirectional controls (for example U+202E) can make a memo display reversed
// text; they have no use in an invoice reference.
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Cleans a memo for a request: bidirectional controls removed, surrounding
 * spaces trimmed, cut to `MAX_MEMO_LENGTH` characters without splitting one
 * (an emoji stays whole).
 *
 * @param memo Memo as typed or read from a link.
 * @returns The cleaned memo, possibly empty.
 */
export function cleanMemo(memo: string): string {
  return Array.from(memo.replace(BIDI_CONTROLS, "").trim()).slice(0, MAX_MEMO_LENGTH).join("").trim();
}

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
  const memo = cleanMemo(request.memo ?? "");
  if (memo) url.searchParams.set("memo", memo);
  if (request.id) url.searchParams.set("id", request.id);
  if (request.preview) url.searchParams.set("preview", "1");
  return url.toString();
}

/**
 * Reads a request from the query string of `/app`. Anything invalid is
 * dropped rather than shown, since the link comes from someone else: a
 * request without a valid payee is no request, a bad amount or chain is
 * ignored, and the memo is cleaned with `cleanMemo`.
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
  const amount = first("amount")?.trim();
  const memo = cleanMemo(first("memo") ?? "");
  return {
    payee: getAddress(to),
    chain: first("chain") === "arc" ? "arc" : "base",
    amount: amount && isRequestAmount(amount) ? amount : undefined,
    memo: memo || undefined,
    id: REQUEST_ID.test(first("id") ?? "") ? first("id") : undefined,
    ...(first("preview") === "1" ? { preview: true } : {}),
  };
}

/**
 * Makes a random request id.
 *
 * @returns 16 lowercase letters and digits.
 */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

/**
 * Whether a payment matches a request: same payee and chain, and at least the
 * amount asked. Used before telling the payee a simulated payment was made,
 * since the payee address and chain stay editable on the pay screen.
 *
 * @param payment The payment as sent: payee, chain and amount in USDC units.
 * @param request The request the pay screen was opened from.
 * @returns Whether the payment pays the request.
 */
export function paysRequest(
  payment: { payee: string; chain: string; amount: bigint },
  request: PaymentRequest,
): boolean {
  if (payment.payee.toLowerCase() !== request.payee.toLowerCase() || payment.chain !== request.chain) return false;
  return request.amount === undefined || payment.amount >= parseUnits(request.amount, 6);
}
