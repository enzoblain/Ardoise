import { describe, expect, it } from "vitest";
import { MAX_MEMO_LENGTH, buildRequestUrl, isRequestAmount, parseRequest } from "./paymentRequest";

const PAYEE = "0xdf41621b35b0c3512d1177DE1423747900fC7a77" as const;
const ORIGIN = "https://ardoise-rust.vercel.app";

describe("buildRequestUrl", () => {
  it("puts the request in the query string of /app", () => {
    const url = new URL(buildRequestUrl(ORIGIN, { payee: PAYEE, chain: "base", amount: "20.5", memo: "Invoice #42" }));
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/app`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ to: PAYEE, chain: "base", amount: "20.5", memo: "Invoice #42" });
  });

  it("leaves out an empty amount and memo", () => {
    const url = new URL(buildRequestUrl(ORIGIN, { payee: PAYEE, chain: "arc", memo: "  " }));
    expect([...url.searchParams.keys()]).toEqual(["to", "chain"]);
  });

  it("round-trips through parseRequest", () => {
    const request = { payee: PAYEE, chain: "arc" as const, amount: "0.4", memo: "Café & co" };
    const url = new URL(buildRequestUrl(ORIGIN, request));
    expect(parseRequest(Object.fromEntries(url.searchParams))).toEqual(request);
  });
});

describe("parseRequest", () => {
  it("returns nothing without a valid payee", () => {
    expect(parseRequest({})).toBeUndefined();
    expect(parseRequest({ to: "0x123", amount: "20" })).toBeUndefined();
  });

  it("drops an invalid amount and defaults to Base", () => {
    expect(parseRequest({ to: PAYEE, amount: "-3", chain: "solana" })).toEqual({
      payee: PAYEE,
      chain: "base",
      amount: undefined,
      memo: undefined,
    });
  });

  it("checksums the payee and takes the first of repeated values", () => {
    const request = parseRequest({ to: [PAYEE.toLowerCase(), "0x0"], chain: ["arc"] });
    expect(request?.payee).toBe(PAYEE);
    expect(request?.chain).toBe("arc");
  });

  it("cuts the memo to what the pay screen accepts", () => {
    const request = parseRequest({ to: PAYEE, memo: "x".repeat(500) });
    expect(request?.memo).toHaveLength(MAX_MEMO_LENGTH);
  });
});

describe("isRequestAmount", () => {
  it("accepts positive amounts with up to 6 decimals", () => {
    expect(isRequestAmount("20")).toBe(true);
    expect(isRequestAmount("0.000001")).toBe(true);
    expect(isRequestAmount("0")).toBe(false);
    expect(isRequestAmount("1.1234567")).toBe(false);
    expect(isRequestAmount("1e3")).toBe(false);
  });
});
