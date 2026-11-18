/**
 * Live session of a payment request, between the payee's waiting page and the
 * payer's pay screen. The app is hosted on Vercel, which cannot hold
 * WebSockets, so both pages talk through ntfy.sh, a public pub/sub service,
 * on a topic named after the request's random id. Messages carry a status
 * only: never an address or an amount. Money is never decided here: a real
 * payment is confirmed on chain (see `requestWatch.ts`).
 */

/** Public relay both pages publish to and subscribe from. */
export const RELAY_URL = "https://ntfy.sh";

/** Time the payer has to pay once they open the request. */
export const PAY_WINDOW_MS = 30_000;

/**
 * Time after the request closes during which a payment landing on chain still
 * counts as on time: a payment to Base is sent on Arc, then minted by Circle a
 * few seconds later, so a payer who clicked just before the end lands after it.
 */
export const DELIVERY_GRACE_MS = 60_000;

/** What happened in the session. */
export type SessionEvent =
  | { type: "joined" }
  | { type: "cancelled" }
  | { type: "expired" }
  | { type: "paid"; simulated: boolean };

/** Session state, derived from the events in the order the relay received them. */
export interface SessionState {
  /** When the first payer opened the request (relay time, ms). */
  joinedAt?: number;
  /** When the request was cancelled or expired (relay time, ms). */
  closedAt?: number;
  closedBy?: "cancelled" | "expired";
  /** Set once a payment is reported: by the payee for a real one, by the demo payer for a simulated one. */
  paid?: { simulated: boolean; at: number };
}

/**
 * Topic of a request on the relay.
 *
 * @param requestId The request's random id.
 * @returns The ntfy topic name.
 */
export function topicFor(requestId: string): string {
  return `ardoise-req-${requestId}`;
}

/**
 * Applies one event to the session. The first of each kind wins: a second
 * payer opening the link does not restart the 30 s, and nothing reopens a
 * closed request.
 *
 * @param state Current state.
 * @param event The event.
 * @param at When the relay received it, in ms.
 * @returns The new state.
 */
export function applyEvent(state: SessionState, event: SessionEvent, at: number): SessionState {
  switch (event.type) {
    case "joined":
      return state.joinedAt === undefined ? { ...state, joinedAt: at } : state;
    case "cancelled":
    case "expired":
      return state.closedAt === undefined ? { ...state, closedAt: at, closedBy: event.type } : state;
    case "paid":
      return state.paid === undefined ? { ...state, paid: { simulated: event.simulated, at } } : state;
  }
}

/**
 * When the payer's 30 s end, if they opened the request.
 *
 * @param state Session state.
 * @returns The deadline in ms, or `undefined` before anyone opens the request.
 */
export function deadlineOf(state: SessionState): number | undefined {
  return state.joinedAt === undefined ? undefined : state.joinedAt + PAY_WINDOW_MS;
}

/**
 * Whether the payer may still pay.
 *
 * @param state Session state.
 * @param now Current time, in ms.
 * @returns False once the request is cancelled, expired or its 30 s are over.
 */
export function canPay(state: SessionState, now: number): boolean {
  const deadline = deadlineOf(state);
  return state.closedAt === undefined && (deadline === undefined || now < deadline);
}

/**
 * Whether a payment that landed on chain at `landedAt` came in time.
 *
 * @param state Session state.
 * @param landedAt Block time of the payment, in ms.
 * @returns False if it landed more than `DELIVERY_GRACE_MS` after the request closed.
 */
export function landedInTime(state: SessionState, landedAt: number): boolean {
  // The request closed at the earliest of the cancel or expiry message and the
  // deadline: an expiry published late (a throttled tab) must not widen the grace.
  const deadline = deadlineOf(state);
  const ends = [state.closedAt, deadline].filter((t): t is number => t !== undefined);
  const closedAt = ends.length > 0 ? Math.min(...ends) : undefined;
  return closedAt === undefined || landedAt <= closedAt + DELIVERY_GRACE_MS;
}

/**
 * Whether the payer's screen lets them pay. It only fails open, without a time
 * limit, when the relay was never reachable: once the session is known to be
 * opened or closed, losing the connection must not reopen it.
 *
 * @param relay State of the connection to the relay.
 * @param state Session state received so far.
 * @param now Current time, in ms, on the relay's clock.
 * @returns Whether the Pay button may be enabled.
 */
export function payerMayPay(relay: "connecting" | "live" | "down", state: SessionState, now: number): boolean {
  if (state.closedAt !== undefined) return false;
  if (state.joinedAt !== undefined) return canPay(state, now);
  return relay !== "connecting";
}

/**
 * Updates the estimate of how far the relay's clock is ahead of this device's,
 * from an event that just arrived. An event can only be received after the
 * relay stamped it, so each one gives a lower bound of the offset, and a
 * replayed one (a reload within the minute) gives a much lower one: keeping the
 * largest estimate ignores replays and approaches the true offset with the
 * first live event. Events more than a minute old are ignored outright; ntfy
 * rounds times to the second.
 *
 * @param best The estimate so far, or `undefined` before any.
 * @param at The event's relay time, in ms.
 * @param receivedAt When this device received it, in ms.
 * @returns The offset to add to `Date.now()`, or `undefined` while none is known.
 */
export function clockOffset(best: number | undefined, at: number, receivedAt: number): number | undefined {
  const estimate = at - receivedAt;
  if (Math.abs(estimate) >= 60_000) return best;
  return best === undefined ? estimate : Math.max(best, estimate);
}

/**
 * Reads one frame from the relay's WebSocket.
 *
 * @param frame The frame's text.
 * @returns The event and the relay's time in ms, or `undefined` for keepalives
 *   and anything that is not one of our events.
 */
export function parseFrame(frame: string): { event: SessionEvent; at: number } | undefined {
  try {
    const outer = JSON.parse(frame) as { event?: string; time?: number; message?: string };
    if (outer.event !== "message" || typeof outer.time !== "number" || typeof outer.message !== "string") return undefined;
    const inner = JSON.parse(outer.message) as { type?: string; simulated?: unknown };
    const at = outer.time * 1000;
    switch (inner.type) {
      case "joined":
      case "cancelled":
      case "expired":
        return { event: { type: inner.type }, at };
      case "paid":
        return { event: { type: "paid", simulated: inner.simulated === true }, at };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Publishes an event to the request's topic.
 *
 * @param requestId The request's random id.
 * @param event The event.
 * @throws If the relay cannot be reached.
 */
export async function publish(requestId: string, event: SessionEvent): Promise<void> {
  const res = await fetch(`${RELAY_URL}/${topicFor(requestId)}`, { method: "POST", body: JSON.stringify(event) });
  if (!res.ok) throw new Error(`relay answered ${res.status}`);
}

/**
 * Follows the request's topic: first the events already sent (the relay keeps
 * them for 12 hours), then new ones as they come. Reconnects after a drop.
 *
 * @param requestId The request's random id.
 * @param onEvent Called with each event and the relay's time in ms.
 * @param onStatus Called with `true` once connected, `false` when the connection drops.
 * @returns A function that stops following.
 */
export function subscribe(
  requestId: string,
  onEvent: (event: SessionEvent, at: number) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout>;
  const url = `${RELAY_URL.replace(/^http/, "ws")}/${topicFor(requestId)}/ws?since=all`;
  const connect = () => {
    socket = new WebSocket(url);
    socket.onopen = () => onStatus(true);
    socket.onmessage = (e) => {
      const parsed = typeof e.data === "string" ? parseFrame(e.data) : undefined;
      if (parsed) onEvent(parsed.event, parsed.at);
    };
    socket.onclose = () => {
      if (stopped) return;
      onStatus(false);
      retry = setTimeout(connect, 2_000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  };
}
