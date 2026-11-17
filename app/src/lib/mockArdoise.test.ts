import { describe, expect, it } from "vitest";
import { PaymentFailed, WAD, marginFromHealth, type PaymentRequest, type Venue } from "@/lib/ardoise";
import { createMockArdoise } from "@/lib/mockArdoise";

const AAVE: Venue = { id: "aave-v4", name: "Aave V4", rateBps: 310, available: 40_000_000n * 1_000_000n };
const MORPHO: Venue = { id: "morpho", name: "Morpho", rateBps: 398, available: 15_000_000n * 1_000_000n };
const PAYEE = "0xdf41621b35b0c3512d1177DE1423747900fC7a77";

function request(amount: number, overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return { amount: BigInt(amount) * 1_000_000n, destinationDomain: 6, payee: PAYEE, maxFee: 54_508n, memo: "test", ...overrides };
}

describe("mock Ardoise account", () => {
  it("borrows amount + maxFee from the cheapest venue and lowers the margin", async () => {
    const account = createMockArdoise([MORPHO, AAVE]);
    const quote = await account.quote(request(20));
    expect(quote.error).toBeUndefined();
    expect(quote.venue?.id).toBe("aave-v4");
    expect(quote.borrow).toBe(20_054_508n);
    expect(marginFromHealth(quote.healthBefore.healthFactor)).toBeCloseTo(0.487, 3);
    expect(marginFromHealth(quote.healthAfter!)).toBeCloseTo(0.384, 3);
  });

  it("records a debt line and updates health and caps on pay", async () => {
    const account = createMockArdoise([AAVE]);
    const id = await account.pay(request(20, { memo: "design work" }));
    expect(id).toBe(1n);
    const [line] = await account.lines();
    expect(line).toMatchObject({ principal: 20_054_508n, rateBps: 310, destinationDomain: 6, memo: "design work" });
    expect(line.payee).toBe("0x000000000000000000000000df41621b35b0c3512d1177de1423747900fc7a77");
    expect((await account.caps()).spentToday).toBe(20_054_508n);
    expect((await account.health()).debtUsd).toBe(100n * WAD + 20_054_508n * 10n ** 12n);
  });

  it("refuses a payment the guard does not allow, with the allowed amount", async () => {
    const account = createMockArdoise([AAVE]);
    // $195 of borrowing power / 1.25 = $156 max debt, $100 already borrowed.
    const quote = await account.quote(request(60));
    expect(quote.error).toEqual({ code: "PaymentRefused", allowed: 56_000_000n });
    await expect(account.pay(request(60))).rejects.toBeInstanceOf(PaymentFailed);
    expect(await account.lines()).toHaveLength(0);
  });

  it("enforces the per-payment and daily caps", async () => {
    const account = createMockArdoise([AAVE], {
      collateralUsd: 10_000n * WAD,
      debtUsd: 0n,
      liquidationThreshold: (78n * WAD) / 100n,
      minHealthFactor: (125n * WAD) / 100n,
      perPaymentCap: 100_000_000n,
      dailyCap: 150_000_000n,
    });
    expect((await account.quote(request(100))).error?.code).toBe("CapExceeded");
    await account.pay(request(90));
    expect((await account.quote(request(60))).error).toEqual({ code: "CapExceeded", remaining: 59_945_492n });
  });

  it("falls back to another venue when the cheapest lacks liquidity", async () => {
    const dryAave = { ...AAVE, available: 1_000_000n };
    const account = createMockArdoise([dryAave, MORPHO]);
    expect((await account.quote(request(20))).venue?.id).toBe("morpho");
    const none = createMockArdoise([dryAave]);
    expect((await none.quote(request(20))).error?.code).toBe("NoVenueAvailable");
  });

  it("rejects an invalid or zero payee", async () => {
    const account = createMockArdoise([AAVE]);
    expect((await account.quote(request(5, { payee: "0x1234" }))).error?.code).toBe("InvalidPayee");
    expect(
      (await account.quote(request(5, { payee: "0x0000000000000000000000000000000000000000" }))).error?.code,
    ).toBe("InvalidPayee");
  });
});
