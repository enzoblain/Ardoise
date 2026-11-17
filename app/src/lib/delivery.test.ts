import { describe, expect, it } from "vitest";
import { parseIrisResponse } from "@/lib/delivery";

const BURN = "0x56b6cfcddd62fced03a9efb4e192f561f1e1a0ff0de0c3504464c8fea0255988";
const MINT = "0x0cbd3d556f547f82ef27ab41a209a66e350792c79cae420e5cb101aafb1b77e8";

// Trimmed from the real Iris answer for the 1 USDC Arc Testnet -> Base
// Sepolia transfer recorded in docs/roadmap.md (test 0.2).
function irisMessage(overrides: Record<string, unknown> = {}) {
  return {
    messages: [
      {
        status: "complete",
        decodedMessage: {
          destinationDomain: "6",
          decodedMessageBody: {
            mintRecipient: "0xdf41621b35b0c3512d1177de1423747900fc7a77",
            amount: "1000000",
            feeExecuted: "53036",
          },
        },
        delayReason: null,
        forwardState: "CONFIRMED",
        forwardTxHash: MINT,
        destinationMintTxHash: MINT,
        ...overrides,
      },
    ],
  };
}

describe("parseIrisResponse", () => {
  it("reports a delivered payment with its mint and amounts", () => {
    expect(parseIrisResponse(BURN, irisMessage())).toEqual({
      stage: "delivered",
      sourceTxHash: BURN,
      destinationDomain: 6,
      recipient: "0xdf41621b35b0c3512d1177de1423747900fc7a77",
      amount: "1",
      fee: "0.053036",
      received: "0.946964",
      mintTxHash: MINT,
      delayReason: undefined,
    });
  });

  it("reports not_found when Iris has no message yet", () => {
    expect(parseIrisResponse(BURN, null).stage).toBe("not_found");
    expect(parseIrisResponse(BURN, { messages: [] }).stage).toBe("not_found");
  });

  it("reports attesting until Circle signs", () => {
    const body = irisMessage({
      status: "pending_confirmations",
      forwardState: null,
      forwardTxHash: null,
      destinationMintTxHash: null,
    });
    expect(parseIrisResponse(BURN, body).stage).toBe("attesting");
  });

  it("reports delivering once attested but not minted", () => {
    const body = irisMessage({
      forwardState: "PENDING",
      forwardTxHash: null,
      destinationMintTxHash: null,
    });
    expect(parseIrisResponse(BURN, body).stage).toBe("delivering");
  });

  it("uses the forwarder transaction when no mint hash is reported", () => {
    const body = irisMessage({ destinationMintTxHash: null });
    expect(parseIrisResponse(BURN, body).mintTxHash).toBe(MINT);
  });

  it("reports failed when the forwarder fails", () => {
    const body = irisMessage({
      forwardState: "FAILED",
      forwardTxHash: null,
      destinationMintTxHash: null,
    });
    expect(parseIrisResponse(BURN, body).stage).toBe("failed");
  });
});
