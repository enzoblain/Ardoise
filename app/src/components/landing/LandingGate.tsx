"use client";

import { createContext, useCallback, useContext, useState } from "react";
import styles from "./Intro.module.css";

/** Opens the main page from inside the intro. */
const EnterContext = createContext<() => void>(() => {});

/**
 * Shows the intro first and the main page only once the visitor asks for it.
 * After that the intro is gone: scrolling up stops at the top of the main
 * page. A click on a link to the landing page itself (the brand in the main
 * page's header) brings the intro back.
 *
 * @param props.intro The opening slides; an `AccessButton` inside them opens the main page.
 * @param props.children The main page.
 */
export function LandingGate({ intro, children }: { intro: React.ReactNode; children: React.ReactNode }) {
  const [entered, setEntered] = useState(false);

  const show = useCallback((main: boolean) => {
    setEntered(main);
    // Both views start from their top; `instant` skips any smooth scrolling.
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  const enter = useCallback(() => show(true), [show]);

  const backToIntro = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a");
    if (link?.getAttribute("href") !== "/") return;
    event.preventDefault();
    show(false);
  };

  return (
    <EnterContext.Provider value={enter}>
      <div hidden={entered}>{intro}</div>
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
