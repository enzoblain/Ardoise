import { describe, expect, it } from "vitest";
import { missingSteps, type SetupState } from "@/lib/setup";

const ready: SetupState = {
  collateral: 6_270n,
  collateralEnabled: true,
  takerApproved: true,
  giverApproved: true,
  account: "0x00000000000000000000000000000000000Ac0c1",
  borrowAllowance: 60_000_000n,
  perPaymentCap: 10_000_000n,
};

describe("missingSteps", () => {
  it("is empty once every step is done", () => {
    expect(missingSteps(ready)).toEqual([]);
  });

  it("lists the missing steps in the order to run them", () => {
    expect(
      missingSteps({ ...ready, takerApproved: false, giverApproved: false, account: null, borrowAllowance: 0n }),
    ).toEqual(["approveTaker", "approveGiver", "createAccount", "approveBorrow"]);
  });

  it("asks to renew the allowance once it no longer covers a full payment", () => {
    expect(missingSteps({ ...ready, borrowAllowance: 3_000_000n })).toEqual(["approveBorrow"]);
    expect(missingSteps({ ...ready, borrowAllowance: 10_000_000n })).toEqual([]);
  });
});
