"use client";

import { useEffect, useState } from "react";
import { applyEvent, clockOffset, publish, subscribe, type SessionState } from "@/lib/requestSession";

/** How long to wait for the relay before treating it as unavailable. */
const RELAY_TIMEOUT_MS = 6_000;

/** State of the connection to the relay. */
export type RelayStatus = "connecting" | "live" | "down";

/**
 * Follows a payment request's live session on the relay.
 *
 * @param requestId The request's id; nothing is followed while undefined.
 * @param join True on the payer's side: announces that the payer opened the
 *   request, which starts their 30 s.
 * @returns The session state, the relay's status, and the offset of the
 *   relay's clock from this device's (add it to `Date.now()`), so a device
 *   whose clock is off still counts the 30 s like the other side.
 */
export function useRequestSession(
  requestId: string | undefined,
  join: boolean,
): { state: SessionState; relay: RelayStatus; offset: number } {
  const [state, setState] = useState<SessionState>({});
  const [relay, setRelay] = useState<RelayStatus>("connecting");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setState({});
    setRelay("connecting");
    setOffset(0);
    if (!requestId) return;
    let announced = false;
    let bestOffset: number | undefined;
    const stop = subscribe(
      requestId,
      (event, at) => {
        setState((s) => applyEvent(s, event, at));
        const estimate = clockOffset(bestOffset, at, Date.now());
        if (estimate !== undefined && estimate !== bestOffset) {
          bestOffset = estimate;
          setOffset(estimate);
        }
      },
      (connected) => {
        setRelay(connected ? "live" : "down");
        if (connected && join && !announced) {
          announced = true;
          // The relay echoes it back with its own time, which both sides use as the start of the 30 s.
          publish(requestId, { type: "joined" }).catch(() => setRelay("down"));
        }
      },
    );
    // A relay that never answers must not block the payer: say it is down instead.
    const timeout = setTimeout(() => setRelay((r) => (r === "connecting" ? "down" : r)), RELAY_TIMEOUT_MS);
    return () => {
      stop();
      clearTimeout(timeout);
    };
  }, [requestId, join]);

  return { state, relay, offset };
}

/**
 * The current time on the relay's clock, refreshed on an interval, for countdowns.
 *
 * @param intervalMs How often to refresh, in ms.
 * @param active Whether to keep ticking; the time freezes when false.
 * @param offset Offset of the relay's clock, from `useRequestSession`.
 * @returns The current time in ms.
 */
export function useNow(intervalMs: number, active: boolean, offset: number): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active, offset]);
  return now;
}

/**
 * Whether a moment on the relay's clock has passed. Re-renders once, when it
 * does, instead of on every tick.
 *
 * @param at The moment, in ms on the relay's clock; never passes while undefined.
 * @param offset Offset of the relay's clock, from `useRequestSession`.
 * @returns Whether `at` is in the past.
 */
export function useReached(at: number | undefined, offset: number): boolean {
  const [reached, setReached] = useState(false);
  useEffect(() => {
    if (at === undefined) return setReached(false);
    const wait = at - (Date.now() + offset);
    setReached(wait <= 0);
    if (wait <= 0) return;
    const timer = setTimeout(() => setReached(true), wait);
    return () => clearTimeout(timer);
  }, [at, offset]);
  return reached;
}
