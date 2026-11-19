"use client";

import { useEffect } from "react";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Share of the remaining distance covered each frame. */
const EASE = 0.14;

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
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Published values, eased towards the scroll position so the transitions
    // keep a little inertia instead of following the wheel step by step.
    const shown = elements.map(() => ({ enter: 0, p: 0 }));
    let started = false;
    let frame = 0;

    const update = () => {
      frame = 0;
      const viewport = window.innerHeight;
      let moving = false;
      elements.forEach((element, i) => {
        const rect = element.getBoundingClientRect();
        const target = {
          enter: clamp((viewport - rect.top) / viewport),
          p: clamp(-rect.top / Math.max(1, rect.height - viewport)),
        };
        const current = shown[i];
        for (const key of ["enter", "p"] as const) {
          const gap = target[key] - current[key];
          // The first pass and reduced motion jump straight to the target.
          current[key] = !started || still || Math.abs(gap) < 0.0004 ? target[key] : current[key] + gap * EASE;
          if (current[key] !== target[key]) moving = true;
          element.style.setProperty(`--${key}`, current[key].toFixed(4));
        }
      });
      started = true;
      if (moving) schedule();
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
