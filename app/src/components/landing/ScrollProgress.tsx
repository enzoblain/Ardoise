"use client";

import { useEffect } from "react";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Share of the remaining distance covered each frame. */
const EASE = 0.14;

/**
 * Publishes how far each `[data-progress]` element has been scrolled, as the
 * CSS variable `--p` on the element, so that the intro's transitions can be
 * written in CSS: 0 when its top reaches the top of the viewport, 1 when its
 * bottom reaches the bottom (the progress through a pinned section).
 *
 * Without JavaScript the variable keeps its CSS default and the page is a
 * plain sequence of sections. Renders nothing.
 */
export function ScrollProgress() {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-progress]"));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Published values, eased towards the scroll position so the transitions
    // keep a little inertia instead of following the wheel step by step.
    const shown = elements.map(() => 0);
    let started = false;
    let frame = 0;

    const update = () => {
      frame = 0;
      const viewport = window.innerHeight;
      let moving = false;
      elements.forEach((element, i) => {
        const rect = element.getBoundingClientRect();
        const target = clamp(-rect.top / Math.max(1, rect.height - viewport));
        const gap = target - shown[i];
        // The first pass and reduced motion jump straight to the target.
        shown[i] = !started || still || Math.abs(gap) < 0.0004 ? target : shown[i] + gap * EASE;
        if (shown[i] !== target) moving = true;
        element.style.setProperty("--p", shown[i].toFixed(4));
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
