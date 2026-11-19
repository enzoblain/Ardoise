import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { accountAbi } from "@/lib/contracts/abis";
import { parseWithdrawAmount, withdrawCall } from "@/lib/withdraw";

const balance = 12_500_000n; // 12.5 USDC

describe("parseWithdrawAmount", () => {
  it("reads an amount within the balance in USDC units", () => {
    expect(parseWithdrawAmount("3.25", balance)).toEqual({ ok: true, amount: 3_250_000n });
    expect(parseWithdrawAmount(" 7 ", balance)).toEqual({ ok: true, amount: 7_000_000n });
    expect(parseWithdrawAmount(".5", balance)).toEqual({ ok: true, amount: 500_000n });
  });

  it("accepts the whole balance", () => {
    expect(parseWithdrawAmount("12.5", balance)).toEqual({ ok: true, amount: balance });
  });

  it("refuses an empty or non-numeric amount", () => {
    expect(parseWithdrawAmount("", balance).ok).toBe(false);
    expect(parseWithdrawAmount(".", balance).ok).toBe(false);
    expect(parseWithdrawAmount("1,5", balance).ok).toBe(false);
    expect(parseWithdrawAmount("-1", balance).ok).toBe(false);
    expect(parseWithdrawAmount("1e3", balance).ok).toBe(false);
  });

  it("refuses more than six decimals", () => {
    expect(parseWithdrawAmount("0.0000001", balance)).toEqual({ ok: false, error: "USDC has at most 6 decimals." });
  });

  it("refuses zero, which withdraw() reverts with ZeroAmount", () => {
    expect(parseWithdrawAmount("0.000", balance)).toEqual({ ok: false, error: "Enter an amount above 0." });
  });

  it("refuses more than the balance, which withdraw() reverts with InsufficientBalance", () => {
    expect(parseWithdrawAmount("12.500001", balance)).toEqual({ ok: false, error: "The account holds 12.50 USDC." });
    expect(parseWithdrawAmount("1", 0n).ok).toBe(false);
  });
});

describe("withdrawCall", () => {
  it("calls withdraw(amount) on the account", () => {
    const account = "0x00000000000000000000000000000000000Ac0c1";
    const call = withdrawCall(account, 3_250_000n);
    expect(call.to).toBe(account);
    const decoded = decodeFunctionData({ abi: accountAbi, data: call.data });
    expect(decoded.functionName).toBe("withdraw");
    expect(decoded.args).toEqual([3_250_000n]);
  });
});
