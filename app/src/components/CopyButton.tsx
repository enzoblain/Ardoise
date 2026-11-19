"use client";

import { useEffect, useState } from "react";

/**
 * Copies a value to the clipboard and says so for two seconds. When the
 * browser refuses (no clipboard permission, insecure page), it says so too,
 * so the user knows to copy by hand.
 *
 * @param props.text The value to copy.
 * @param props.label What is copied, for screen readers ("address").
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const shown = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`${shown} ${label}`}
        className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
      >
        {shown}
      </button>
      {/* Screen readers hear the result, which the button's own label would not announce. */}
      <span role="status" className="sr-only">
        {state === "copied" ? `${label} copied` : state === "failed" ? `Could not copy the ${label}` : ""}
      </span>
    </>
  );
}
