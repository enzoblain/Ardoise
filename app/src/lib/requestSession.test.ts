import { describe, expect, it } from "vitest";
import {
  DELIVERY_GRACE_MS,
  PAY_WINDOW_MS,
  applyEvent,
  canPay,
  clockOffset,
  deadlineOf,
  landedInTime,
  parseFrame,
  payerMayPay,
  topicFor,
  type SessionEvent,
  type SessionState,
} from "./requestSession";

const T = 1_800_000_000_000;
const replay = (events: Array<[SessionEvent, number]>): SessionState =>
  events.reduce<SessionState>((s, [e, at]) => applyEvent(s, e, at), {});

describe("applyEvent", () => {
  it("keeps the first payer's opening, so a second one does not restart the 30 s", () => {
    const state = replay([
      [{ type: "joined" }, T],
      [{ type: "joined" }, T + 20_000],
    ]);
    expect(deadlineOf(state)).toBe(T + PAY_WINDOW_MS);
  });

  it("closes once, with the first cause", () => {
    const state = replay([
      [{ type: "cancelled" }, T],
      [{ type: "expired" }, T + 5_000],
    ]);
    expect(state).toEqual({ closedAt: T, closedBy: "cancelled" });
  });

  it("records a payment", () => {
    expect(replay([[{ type: "paid", simulated: true }, T]]).paid).toEqual({ simulated: true, at: T });
  });
});

describe("canPay", () => {
  it("allows paying before anyone opened the request and during the 30 s", () => {
    expect(canPay({}, T)).toBe(true);
    expect(canPay({ joinedAt: T }, T + PAY_WINDOW_MS - 1)).toBe(true);
  });

  it("refuses after the 30 s, or once cancelled", () => {
    expect(canPay({ joinedAt: T }, T + PAY_WINDOW_MS)).toBe(false);
    expect(canPay({ closedAt: T, closedBy: "cancelled" }, T)).toBe(false);
  });
});

describe("landedInTime", () => {
  it("accepts a payment delivered shortly after the payer's deadline", () => {
    expect(landedInTime({ joinedAt: T }, T + PAY_WINDOW_MS + DELIVERY_GRACE_MS)).toBe(true);
  });

  it("flags a payment that lands well after the request closed", () => {
    expect(landedInTime({ joinedAt: T }, T + PAY_WINDOW_MS + DELIVERY_GRACE_MS + 1)).toBe(false);
    expect(landedInTime({ closedAt: T, closedBy: "cancelled" }, T + DELIVERY_GRACE_MS + 1)).toBe(false);
  });

  it("counts the grace from the deadline when the expiry message came late", () => {
    const state = { joinedAt: T, closedAt: T + PAY_WINDOW_MS + 600_000, closedBy: "expired" as const };
    expect(landedInTime(state, T + PAY_WINDOW_MS + DELIVERY_GRACE_MS + 1)).toBe(false);
  });

  it("accepts any payment to a request nobody opened and nobody closed", () => {
    expect(landedInTime({}, T + 3_600_000)).toBe(true);
  });
});

describe("parseFrame", () => {
  const frame = (message: string, event = "message") => JSON.stringify({ event, time: T / 1000, message });

  it("reads our events with the relay's time", () => {
    expect(parseFrame(frame('{"type":"joined"}'))).toEqual({ event: { type: "joined" }, at: T });
    expect(parseFrame(frame('{"type":"paid","simulated":true}'))).toEqual({ event: { type: "paid", simulated: true }, at: T });
  });

  it("treats a paid event without a strict true as real", () => {
    expect(parseFrame(frame('{"type":"paid","simulated":"yes"}'))?.event).toEqual({ type: "paid", simulated: false });
  });

  it("ignores keepalives, unknown types and garbage", () => {
    expect(parseFrame(frame("", "keepalive"))).toBeUndefined();
    expect(parseFrame(frame('{"type":"refund"}'))).toBeUndefined();
    expect(parseFrame(frame("not json"))).toBeUndefined();
    expect(parseFrame("{")).toBeUndefined();
  });
});

describe("topicFor", () => {
  it("names the topic after the request id", () => {
    expect(topicFor("abc12345")).toBe("ardoise-req-abc12345");
  });
});

describe("payerMayPay", () => {
  it("never reopens a closed request, even when the relay drops", () => {
    expect(payerMayPay("down", { closedAt: T, closedBy: "cancelled" }, T)).toBe(false);
  });

  it("keeps the 30 s once the request is opened, even when the relay drops", () => {
    expect(payerMayPay("down", { joinedAt: T }, T + PAY_WINDOW_MS)).toBe(false);
    expect(payerMayPay("down", { joinedAt: T }, T + 1_000)).toBe(true);
  });

  it("waits while connecting, and fails open only if the relay was never reached", () => {
    expect(payerMayPay("connecting", {}, T)).toBe(false);
    expect(payerMayPay("down", {}, T)).toBe(true);
    expect(payerMayPay("live", {}, T)).toBe(true);
  });
});

describe("clockOffset", () => {
  it("estimates the offset from an event that just arrived", () => {
    expect(clockOffset(T + 2_000, T)).toBe(2_000);
    expect(clockOffset(T - 30_000, T)).toBe(-30_000);
  });

  it("ignores replayed events", () => {
    expect(clockOffset(T - 3_600_000, T)).toBeUndefined();
  });
});
