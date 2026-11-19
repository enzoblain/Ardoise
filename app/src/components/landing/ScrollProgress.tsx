"use client";

import { useEffect } from "react";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Publishes how far each `[data-progress]` element has been scrolled, as two
 * CSS variables on the element, so that the intro's transitions can be
 * written in CSS:
 *
 * - `--enter`: 0 when the element's top is at the bottom of the viewport, 1
 *   once it has reached the top;
 * - `--p`: 0 when its top reaches the top of the viewport, 1 when its bottom
 *   reaches the bottom (the progress through a pinned section).
 *
 * Without JavaScript the variables keep their CSS defaults and the page is a
 * plain sequence of sections. Renders nothing.
 */
export function ScrollProgress() {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-progress]"));
    let frame = 0;

    const update = () => {
      frame = 0;
      const viewport = window.innerHeight;
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        element.style.setProperty("--enter", clamp((viewport - rect.top) / viewport).toFixed(4));
        element.style.setProperty("--p", clamp(-rect.top / Math.max(1, rect.height - viewport)).toFixed(4));
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return null;
}
