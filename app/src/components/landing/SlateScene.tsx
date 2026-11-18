"use client";

import { useEffect, useRef } from "react";
import styles from "./SlateScene.module.css";

/** Resting tilt, in degrees, so the slate reads as a 3D object at rest. */
const REST = { rx: 16, ry: -22 };
/** Extra tilt the pointer can add on each axis, in degrees. */
const RANGE = 12;
/** Share of the remaining distance covered each frame (smooths the tilt). */
const EASE = 0.08;

/**
 * The landing page's hero: the Ardoise slate in 3D. Its chalk lines write
 * themselves one per payment, the orange dot marks the payment being written,
 * and a ticket leaves the slate for another chain. The slate tilts towards the
 * pointer; with reduced motion it stays still and fully drawn.
 */
export function SlateScene() {
  const rig = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rig.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const target = { ...REST };
    const current = { ...REST };
    // 0 while the slate is at rest: frames only run while it is catching up
    // with the pointer, not forever.
    let frame = 0;

    const tick = () => {
      current.rx += (target.rx - current.rx) * EASE;
      current.ry += (target.ry - current.ry) * EASE;
      el.style.setProperty("--rx", `${current.rx.toFixed(2)}deg`);
      el.style.setProperty("--ry", `${current.ry.toFixed(2)}deg`);
      const settled = Math.abs(target.rx - current.rx) < 0.01 && Math.abs(target.ry - current.ry) < 0.01;
      frame = settled ? 0 : requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent) => {
      // Touch drags scroll the page; tilting on them would only add jank.
      if (e.pointerType !== "mouse") return;
      const x = e.clientX / window.innerWidth - 0.5;
      const y = e.clientY / window.innerHeight - 0.5;
      target.ry = REST.ry + x * 2 * RANGE;
      target.rx = REST.rx - y * 2 * RANGE;
      if (!frame) frame = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className={styles.stage} aria-hidden="true">
      <div className={styles.shadow} />
      <div className={styles.float}>
        <div ref={rig} className={styles.rig}>
          {[16, 13, 10, 7, 4].map((z) => (
            <div key={z} className={styles.slab} style={{ transform: `translateZ(-${z}px)` }} />
          ))}
          <div className={styles.face} />
          <div className={`${styles.line} ${styles.line1}`} />
          <div className={`${styles.line} ${styles.line2}`} />
          <div className={`${styles.line} ${styles.line3}`} />
          <div className={styles.dot} />
          <div className={styles.ticket}>0.40 USDC → Base</div>
        </div>
      </div>
    </div>
  );
}
