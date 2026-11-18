/**
 * Server-side memo for public chain reads that every visitor shares (venue
 * rates, the current block), so a burst of visitors costs one RPC read per
 * period instead of one per page view.
 *
 * Concurrent callers share the read in flight. When a refresh fails, the last
 * good value is served for up to `staleMs`, so a public RPC that rate-limits
 * for a moment does not blank the page.
 *
 * @param freshMs How long a value is served without reading again.
 * @param staleMs How long a value may still be served when a refresh fails.
 * @param load The read.
 * @param now Clock, replaceable in tests.
 * @returns A function returning the cached value, or throwing the read's
 *   error when there is no value young enough to fall back on.
 */
export function memo<T>(freshMs: number, staleMs: number, load: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let last: { value: T; at: number } | undefined;
  let inFlight: Promise<T> | undefined;
  return async () => {
    if (last && now() - last.at < freshMs) return last.value;
    inFlight ??= load()
      .then((value) => {
        last = { value, at: now() };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    try {
      return await inFlight;
    } catch (error) {
      if (last && now() - last.at < staleMs) return last.value;
      throw error;
    }
  };
}
