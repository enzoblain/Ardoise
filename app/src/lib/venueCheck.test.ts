import { decodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { accountAbi } from "@/lib/contracts/abis";
import { MAINNET_DEPLOYMENT as deployment } from "@/lib/contracts/deployments";
import { compareVenues, expectedVenues, revokeVenueCall, venuesBlockSetup } from "@/lib/venueCheck";

const aave = deployment.aaveAdapter;
const morpho = deployment.morphoAdapter!;
const rogue: Address = "0x000000000000000000000000000000000000bad1";

describe("expectedVenues", () => {
  it("lists the Aave V4 and Morpho adapters", () => {
    expect(expectedVenues(deployment)).toEqual([aave, morpho]);
  });

  it("lists only Aave V4 when the factory has no Morpho venue", () => {
    expect(expectedVenues({ ...deployment, morphoAdapter: null })).toEqual([aave]);
  });
});

describe("compareVenues", () => {
  const expected = [aave, morpho];

  it("finds nothing when the account accepted exactly the adapters, in any order or case", () => {
    expect(compareVenues([morpho.toLowerCase() as Address, aave], expected)).toEqual({ unexpected: [], missing: [] });
  });

  it("reports an accepted venue that is not an adapter", () => {
    expect(compareVenues([aave, rogue, morpho], expected)).toEqual({ unexpected: [rogue], missing: [] });
  });

  it("reports an adapter the account did not accept", () => {
    expect(compareVenues([aave], expected)).toEqual({ unexpected: [], missing: [morpho] });
    expect(compareVenues([], expected)).toEqual({ unexpected: [], missing: [aave, morpho] });
  });

  it("reports both at once, each venue once", () => {
    expect(compareVenues([rogue, rogue.toUpperCase().replace("0X", "0x") as Address, morpho], expected)).toEqual({
      unexpected: [rogue],
      missing: [aave],
    });
  });
});

describe("venuesBlockSetup", () => {
  it("blocks while the report is unknown", () => {
    expect(venuesBlockSetup(undefined)).toBe(true);
  });

  it("blocks when an unexpected venue is accepted", () => {
    expect(venuesBlockSetup({ unexpected: [rogue], missing: [] })).toBe(true);
  });

  it("does not block for a missing venue alone", () => {
    expect(venuesBlockSetup({ unexpected: [], missing: [morpho] })).toBe(false);
    expect(venuesBlockSetup({ unexpected: [], missing: [] })).toBe(false);
  });
});

describe("revokeVenueCall", () => {
  it("calls revokeVenue(venue) on the account", () => {
    const account: Address = "0x00000000000000000000000000000000000Ac0c1";
    const call = revokeVenueCall(account, rogue);
    expect(call.to).toBe(account);
    const decoded = decodeFunctionData({ abi: accountAbi, data: call.data });
    expect(decoded.functionName).toBe("revokeVenue");
    expect(decoded.args).toEqual([rogue]);
  });
});
