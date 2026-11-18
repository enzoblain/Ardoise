import { describe, expect, it } from "vitest";
import { MAX_MEMO_LENGTH, buildRequestUrl, cleanMemo, isRequestAmount, newRequestId, parseRequest } from "./paymentRequest";

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
    const request = { payee: PAYEE, chain: "arc" as const, amount: "0.4", memo: "Café & co #3 = 50% + tip? ✓", id: newRequestId() };
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
    expect(parseRequest({ to: PAYEE, amount: "-3", chain: "solana", id: "<script>" })).toEqual({
      payee: PAYEE,
      chain: "base",
      amount: undefined,
      memo: undefined,
      id: undefined,
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

describe("parseRequest, untrusted input", () => {
  it("rejects a mixed-case address with a wrong checksum", () => {
    expect(parseRequest({ to: PAYEE.replace("DE14", "de14") })).toBeUndefined();
  });

  it("accepts an amount with surrounding spaces", () => {
    expect(parseRequest({ to: PAYEE, amount: " 12.5 " })?.amount).toBe("12.5");
  });

  it("drops a memo that is empty once trimmed", () => {
    expect(parseRequest({ to: PAYEE, memo: "   " })?.memo).toBeUndefined();
  });
});

describe("cleanMemo", () => {
  it("removes bidirectional controls", () => {
    expect(cleanMemo("Invoice \u202egnp.exe")).toBe("Invoice gnp.exe");
  });

  it("never splits a character at the cut", () => {
    const memo = cleanMemo("a".repeat(MAX_MEMO_LENGTH - 1) + "💸💸");
    expect(Array.from(memo)).toHaveLength(MAX_MEMO_LENGTH);
    expect(memo.endsWith("💸")).toBe(true);
  });
});

describe("newRequestId", () => {
  it("makes ids that parseRequest accepts, different each time", () => {
    const a = newRequestId();
    expect(parseRequest({ to: PAYEE, id: a })?.id).toBe(a);
    expect(newRequestId()).not.toBe(a);
  });
});
