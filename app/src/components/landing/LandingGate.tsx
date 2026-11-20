"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import styles from "./Intro.module.css";

/** Opens the main page from inside the intro. */
const EnterContext = createContext<() => void>(() => {});

/** Session key set once the visitor has opened the main page. */
const ENTERED = "ardoise:entered";

/** Whether `href` is a link to the intro (`/?intro`, as the brand and "How it works" use). */
const isIntroLink = (href: string | null) => href === "/?intro";

/**
 * Shows the intro first and the main page only once the visitor asks for it
 * (Access at the end, or Skip intro at the top). The choice is kept for the
 * browser session, so coming back to `/` (the Back button from the app)
 * lands on the main page, at the section the link names if it has a hash.
 * `/?intro`, the brand and "How it works", brings the intro back.
 *
 * @param props.intro The opening slides; `AccessButton` and `SkipButton` inside them open the main page.
 * @param props.children The main page.
 */
export function LandingGate({ intro, children }: { intro: React.ReactNode; children: React.ReactNode }) {
  // Unknown until the session is read, so that a returning visitor does not see the intro flash.
  const [entered, setEntered] = useState<boolean>();

  const show = useCallback((main: boolean) => {
    setEntered(main);
    try {
      if (main) sessionStorage.setItem(ENTERED, "1");
      else sessionStorage.removeItem(ENTERED);
    } catch {
      // Storage can be blocked; the gate then only lasts for this page.
    }
    // Both views start from their top; `instant` skips any smooth scrolling.
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  const enter = useCallback(() => show(true), [show]);

  useEffect(() => {
    const wantsIntro = new URLSearchParams(window.location.search).has("intro");
    let seen = false;
    try {
      seen = sessionStorage.getItem(ENTERED) === "1";
    } catch {
      // Blocked storage: start from the intro.
    }
    setEntered(!wantsIntro && seen);
  }, []);

  // A link such as `/#stack` scrolls to its section once the main page is shown.
  useEffect(() => {
    if (!entered || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [entered]);

  const backToIntro = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link || !isIntroLink(link.getAttribute("href"))) return;
    event.preventDefault();
    show(false);
  };

  return (
    <EnterContext.Provider value={enter}>
      {/* Rendered on the server too, kept invisible until the session says which view to show. */}
      <div hidden={entered === true} style={entered === undefined ? { visibility: "hidden" } : undefined}>
        {intro}
      </div>
      {entered && (
        <div className={styles.mainEnter} onClickCapture={backToIntro}>
          {children}
        </div>
      )}
    </EnterContext.Provider>
  );
}

/** The button of the last intro slide that opens the main page. */
export function AccessButton() {
  const enter = useContext(EnterContext);
  return (
    <button type="button" className={styles.access} onClick={enter}>
      Access <span aria-hidden="true">→</span>
    </button>
  );
}

/** A small button at the top of the intro that skips straight to the main page. */
export function SkipButton() {
  const enter = useContext(EnterContext);
  return (
    <button type="button" className={styles.skip} onClick={enter}>
      Skip intro <span aria-hidden="true">→</span>
    </button>
  );
}
