import { describe, expect, it } from "vitest";
import { PaymentFailed, WAD, marginFromHealth, type PaymentRequest, type Venue } from "@/lib/ardoise";
import { DEFAULT_MOCK, createMockArdoise } from "@/lib/mockArdoise";

const AAVE: Venue = { id: "aave-v4", address: "0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d", name: "Aave V4", rateBps: 310, available: 40_000_000n * 1_000_000n };
const MORPHO: Venue = { id: "morpho", address: "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD", name: "Morpho", rateBps: 398, available: 15_000_000n * 1_000_000n };
const PAYEE = "0xdf41621b35b0c3512d1177DE1423747900fC7a77";

function request(amount: number, overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return { amount: BigInt(amount) * 1_000_000n, destinationDomain: 6, payee: PAYEE, maxFee: 54_508n, memo: "test", ...overrides };
}

describe("mock Ardoise account", () => {
  it("borrows amount + maxFee from the cheapest venue and reports that venue's margin", async () => {
    const account = createMockArdoise([MORPHO, AAVE]);
    const quote = await account.quote(request(20));
    expect(quote.error).toBeUndefined();
    expect(quote.venue?.id).toBe("aave-v4");
    expect(quote.borrow).toBe(20_054_508n);
    expect(marginFromHealth(quote.healthBefore!.healthFactor)).toBeCloseTo(0.487, 3);
    expect(marginFromHealth(quote.healthAfter!)).toBeCloseTo(0.384, 3);
  });

  it("uses the Morpho position and its 86% threshold when Morpho is cheaper", async () => {
    const account = createMockArdoise([{ ...MORPHO, rateBps: 305 }, AAVE]);
    const quote = await account.quote(request(20));
    expect(quote.venue?.id).toBe("morpho");
    expect(marginFromHealth(quote.healthBefore!.healthFactor)).toBe(1);
    // 250 * 0.86 / 20.054508 = HF 10.72.
    expect(marginFromHealth(quote.healthAfter!)).toBeCloseTo(0.9067, 3);
    // Guard ceiling on Morpho: 250 * 0.86 / 1.25 = 172 USDC of debt.
    expect((await account.quote(request(100, { maxFee: 0n }))).error).toBeUndefined();
  });

  it("returns the debt line and updates that venue's position and the caps", async () => {
    const account = createMockArdoise([AAVE, MORPHO]);
    const line = await account.pay(request(20, { memo: "design work" }));
    expect(line).toMatchObject({ id: 3n, principal: 20_054_508n, rateBps: 310, destinationDomain: 6, memo: "design work" });
    expect(line.venue.id).toBe("aave-v4");
    expect(line.payee).toBe("0x000000000000000000000000df41621b35b0c3512d1177de1423747900fc7a77");
    expect((await account.lines()).at(-1)).toEqual(line);
    expect((await account.caps()).spentToday).toBe(20_054_508n);
    expect((await account.health("aave-v4")).debtUsd).toBe(100n * WAD + 20_054_508n * 10n ** 12n);
    expect((await account.health("morpho")).debtUsd).toBe(0n);
  });

  it("refuses a payment the guard does not allow on the chosen venue", async () => {
    const account = createMockArdoise([AAVE, MORPHO]);
    // Aave: $195 of borrowing power / 1.25 = $156 max debt, $100 already borrowed.
    const quote = await account.quote(request(60));
    expect(quote.venue?.id).toBe("aave-v4");
    expect(quote.error).toEqual({ code: "PaymentRefused", allowed: 56_000_000n });
    await expect(account.pay(request(60))).rejects.toBeInstanceOf(PaymentFailed);
    expect(await account.lines()).toHaveLength(2);
  });

  it("enforces the per-payment and daily caps", async () => {
    const account = createMockArdoise([AAVE], {
      ...DEFAULT_MOCK,
      positions: { "aave-v4": { collateralUsd: 10_000n * WAD, debtUsd: 0n, liquidationThreshold: (78n * WAD) / 100n } },
      history: [],
      dailyCap: 150_000_000n,
    });
    expect((await account.quote(request(100))).error?.code).toBe("CapExceeded");
    await account.pay(request(90));
    expect((await account.quote(request(60))).error).toEqual({ code: "CapExceeded", remaining: 59_945_492n });
  });

  it("falls back to another venue when the cheapest lacks liquidity or has no position", async () => {
    const dryAave = { ...AAVE, available: 1_000_000n };
    expect((await createMockArdoise([dryAave, MORPHO]).quote(request(20))).venue?.id).toBe("morpho");
    const noPosition = createMockArdoise([AAVE, MORPHO], { ...DEFAULT_MOCK, positions: { morpho: DEFAULT_MOCK.positions.morpho } });
    expect((await noPosition.quote(request(20))).venue?.id).toBe("morpho");
    expect((await createMockArdoise([dryAave]).quote(request(20))).error?.code).toBe("NoVenueAvailable");
  });

  it("seeds $100 of past debt on Aave from its history, outside today's cap", async () => {
    const account = createMockArdoise([AAVE, MORPHO]);
    expect((await account.health("aave-v4")).debtUsd).toBe(100n * WAD);
    expect((await account.caps()).spentToday).toBe(0n);
    const { logs } = await account.events();
    expect(logs).toHaveLength(2);
  });

  it("counts same-day history toward today's cap", async () => {
    const account = createMockArdoise([AAVE], {
      ...DEFAULT_MOCK,
      history: [{ ...DEFAULT_MOCK.history[1], daysAgo: 0 }],
    });
    expect((await account.caps()).spentToday).toBe(40_000_000n);
  });

  it("rejects an invalid or zero payee", async () => {
    const account = createMockArdoise([AAVE]);
    expect((await account.quote(request(5, { payee: "0x1234" }))).error?.code).toBe("InvalidPayee");
    expect(
      (await account.quote(request(5, { payee: "0x0000000000000000000000000000000000000000" }))).error?.code,
    ).toBe("InvalidPayee");
  });
});
