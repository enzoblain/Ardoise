import { describe, expect, it } from "vitest";
import { memo } from "@/lib/cache";

describe("memo", () => {
  it("serves one read to concurrent callers and reuses it while fresh", async () => {
    let t = 0;
    let reads = 0;
    const cached = memo(1_000, 10_000, async () => ++reads, () => t);
    expect(await Promise.all([cached(), cached(), cached()])).toEqual([1, 1, 1]);
    t = 999;
    expect(await cached()).toBe(1);
    t = 1_000;
    expect(await cached()).toBe(2);
  });

  it("falls back on the last value while it is not too stale, then throws", async () => {
    let t = 0;
    let fail = false;
    const cached = memo(1_000, 5_000, async () => {
      if (fail) throw new Error("rate limited");
      return "rates";
    }, () => t);
    expect(await cached()).toBe("rates");
    fail = true;
    t = 4_999;
    expect(await cached()).toBe("rates");
    t = 5_000;
    await expect(cached()).rejects.toThrow("rate limited");
  });

  it("throws when the first read fails, and reads again on the next call", async () => {
    let calls = 0;
    const cached = memo(1_000, 5_000, async () => {
      if (++calls === 1) throw new Error("down");
      return calls;
    });
    await expect(cached()).rejects.toThrow("down");
    expect(await cached()).toBe(2);
  });
});
