import { verifyTypedData, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
// The keeper re-checks every order the app builds: use its own code here so
// the two never drift apart.
import {
  BURN_INTENT_DOMAIN,
  BURN_INTENT_TYPES,
  GATEWAY_TESTNET,
  parseOrders,
  rejectReason,
} from "../../../keeper/src/gateway";
import { burnIntentTypedData, gatewayBalance, orderSpec, signOrder, type StandingOrder } from "@/lib/gateway";

const OWNER: Address = "0xdf41621b35b0c3512d1177DE1423747900fC7a77";
const ACCOUNT: Address = "0x00000000000000000000000000000000000Ac0c1";
const intent = (spec: ReturnType<typeof orderSpec>) => ({ maxBlockHeight: "63618938", maxFee: "27333", spec });

afterEach(() => vi.unstubAllGlobals());

describe("standing orders built by the app", () => {
  it("pass the keeper's own checks", () => {
    const order: StandingOrder = { burnIntent: intent(orderSpec(OWNER, ACCOUNT, 5_000_000n)), signature: "0x1234" };
    expect(parseOrders(JSON.parse(JSON.stringify([order])))).toHaveLength(1);
    expect(rejectReason(order, OWNER, ACCOUNT, GATEWAY_TESTNET)).toBeNull();
  });

  it("can only pay the account they name", () => {
    const order: StandingOrder = { burnIntent: intent(orderSpec(OWNER, ACCOUNT, 5_000_000n)), signature: "0x1234" };
    expect(rejectReason(order, OWNER, "0x00000000000000000000000000000000000000e1", GATEWAY_TESTNET)).toMatch(/recipient/);
  });

  it("get a fresh salt each time", () => {
    expect(orderSpec(OWNER, ACCOUNT, 1n).salt).not.toBe(orderSpec(OWNER, ACCOUNT, 1n).salt);
    expect(orderSpec(OWNER, ACCOUNT, 1n).salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("are signed over the typed data the keeper verifies", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const burnIntent = intent(orderSpec(signer.address, ACCOUNT, 5_000_000n));
    const signature = await signer.signTypedData(burnIntentTypedData(burnIntent));
    const valid = await verifyTypedData({
      address: signer.address,
      signature,
      domain: BURN_INTENT_DOMAIN,
      types: BURN_INTENT_TYPES,
      primaryType: "BurnIntent",
      message: burnIntentTypedData(burnIntent).message,
    });
    expect(valid).toBe(true);
  });
});

describe("gatewayBalance", () => {
  it("reads Gateway's decimal balance as USDC units", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ token: "USDC", balances: [{ domain: 6, balance: "0.972770" }] }))),
    );
    expect(await gatewayBalance(OWNER)).toBe(972_770n);
  });

  it("fails clearly when Gateway refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad depositor" }), { status: 400 })));
    await expect(gatewayBalance(OWNER)).rejects.toThrow(/400: bad depositor/);
  });
});

describe("signOrder", () => {
  const estimate = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ body: [{ burnIntent: { maxBlockHeight: "63618938", maxFee: "27333" } }] }))),
    );

  it("marks a smart account's order for Gateway's ERC-1271 check, and the keeper still parses it", async () => {
    estimate();
    const order = await signOrder({ contractSigner: true, signTypedData: async () => "0x1234" }, orderSpec(OWNER, ACCOUNT, 5_000_000n), 2n);
    expect(order.contractSigner).toBe(true);
    expect(order.burnIntent.maxFee).toBe("54666");
    expect(parseOrders([order])).toHaveLength(1);
  });

  it("leaves a browser wallet's order unflagged", async () => {
    estimate();
    const order = await signOrder({ contractSigner: false, signTypedData: async () => "0x1234" }, orderSpec(OWNER, ACCOUNT, 5_000_000n));
    expect("contractSigner" in order).toBe(false);
  });
});
