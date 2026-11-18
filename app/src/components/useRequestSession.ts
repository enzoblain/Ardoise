"use client";

import { useEffect, useState } from "react";
import { applyEvent, publish, subscribe, type SessionState } from "@/lib/requestSession";

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
 * @returns The session state and the relay's status.
 */
export function useRequestSession(requestId: string | undefined, join: boolean): { state: SessionState; relay: RelayStatus } {
  const [state, setState] = useState<SessionState>({});
  const [relay, setRelay] = useState<RelayStatus>("connecting");

  useEffect(() => {
    setState({});
    setRelay("connecting");
    if (!requestId) return;
    let announced = false;
    const stop = subscribe(
      requestId,
      (event, at) => setState((s) => applyEvent(s, event, at)),
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

  return { state, relay };
}

/**
 * The current time, refreshed on an interval, for countdowns.
 *
 * @param intervalMs How often to refresh, in ms.
 * @param active Whether to keep ticking; the time freezes when false.
 * @returns The current time in ms.
 */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
