import { Fraunces } from "next/font/google";
import { LogoMark } from "@/components/LogoMark";
import styles from "./Intro.module.css";
import { ScrollProgress } from "./ScrollProgress";
import { SoloVaultCard, VaultRing } from "./VaultRing";

/** Display typeface of the intro: the title and the chapter headings. */
const display = Fraunces({ subsets: ["latin"], weight: "300" });

/** Splits a heading into words that light up one after the other on scroll. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(" ").map((word, i) => (
        <span key={i} className={styles.word} style={{ "--i": i } as React.CSSProperties}>
          {word}{" "}
        </span>
      ))}
    </>
  );
}

/** The two corner labels at the top of a chapter. */
function ChapterLabels({ about, chapter }: { about: string; chapter: string }) {
  return (
    <p className={styles.labels}>
      <span>About {about}</span>
      <span>Chapter {chapter}</span>
    </p>
  );
}

/**
 * The four opening slides of the landing page, played like a presentation as
 * the visitor scrolls: the ring of vaults, borrowing against collateral,
 * paying from a phone, and the reserve the keeper repays with. The first
 * three share one pinned stage: the ring gathers into a single vault card,
 * which stays through the borrowing chapter and then settles into the phone
 * as the paying slide opens around it. The last one slides over as a sheet. The phone screens
 * are illustrations with example amounts; only the borrow rate is live.
 *
 * @param props.rate Live borrow rate, already formatted (for example
 * "3.10%"), or `null` when rates could not be read.
 */
export function Intro({ rate }: { rate: string | null }) {
  return (
    <div className={styles.intro}>
      <ScrollProgress />

      <section className={styles.act} data-progress>
        <div className={styles.stage}>
          <div className={styles.night}>
            <header className={styles.header}>
              <div>
                <h1 className={`${styles.title} ${display.className}`}>Ardoise</h1>
                <p className={styles.tagline}>
                  Post collateral, pay anyone in USDC, keep your assets. A bot guards the position on Arc mainnet.
                </p>
              </div>
              <LogoMark className={styles.mark} />
            </header>
            <div className={styles.ring}>
              <VaultRing rate={rate} />
            </div>
          </div>

          <div className={styles.day}>
            <ChapterLabels about="paying" chapter="02" />
            <p className={`${styles.ghost} ${display.className}`} aria-hidden="true">
              {rate ?? "USDC"}
            </p>
            <h2 className={`${styles.heading} ${styles.headingCenter} ${display.className}`}>
              <Words text="One payment. One line on your slate." />
            </h2>
            <div className={styles.phone}>
              <div className={styles.screen}>
                <p className={styles.appBar}>
                  <LogoMark size={16} />
                  Ardoise
                </p>
                <div className={styles.cardSlot} />
                <dl className={styles.rows}>
                  <div>
                    <dt>Pay</dt>
                    <dd>24.00 USDC · Base</dd>
                  </div>
                  <div>
                    <dt>Borrowed at</dt>
                    <dd>{rate ?? "best rate"}</dd>
                  </div>
                </dl>
                <p className={styles.cta}>Pay 24.00 USDC</p>
              </div>
            </div>
            <div className={styles.footnotes}>
              <p>
                <strong>Pick who you pay, on Arc or on Base.</strong> Ardoise borrows the amount against your collateral
                and delivers it in seconds.
              </p>
              <p>
                Every payment becomes one line you can repay whenever you want. Everything is in place on Arc mainnet.
              </p>
            </div>
          </div>

          <div className={styles.solo}>
            <SoloVaultCard rate={rate} />
          </div>
        </div>

        <div className={styles.chapterOne}>
          <ChapterLabels about="borrowing" chapter="01" />
          <h2 className={`${styles.heading} ${styles.headingStagger} ${display.className}`}>
            <span>Post collateral.</span>
            <span>Borrow at the</span>
            <span>best rate.</span>
          </h2>
          <p className={styles.noteRight}>
            Your bitcoin goes in as collateral and stays yours. Each payment borrows exactly its amount in USDC, from the
            cheapest lender Ardoise uses on Arc. Nothing is sold, swapped or bridged by hand.
          </p>
        </div>
      </section>

      <section className={`${styles.pinned} ${styles.sheet} ${styles.cover}`} data-progress>
        <div className={styles.pin}>
          <ChapterLabels about="protection" chapter="03" />
          <div className={styles.coverGrid}>
            <div className={styles.coverCopy}>
              <h2 className={`${styles.heading} ${display.className}`}>Add liquidity. Our bot covers your exposure.</h2>
              <p className={styles.lead}>
                Keep a reserve of USDC next to your position. When the market moves against you, the Ardoise keeper
                repays your debt with it before a liquidation can happen.
              </p>
              <ul className={styles.lines}>
                <li>The bot can only repay your own account.</li>
                <li>
                  Other currencies for the reserve <span className={styles.soon}>Soon</span>
                </li>
                <li>
                  Staking the reserve while it waits <span className={styles.soon}>Soon</span>
                </li>
              </ul>
            </div>
            <div className={styles.phoneWrap}>
              <div className={`${styles.phone} ${styles.phoneTilt}`}>
                <div className={`${styles.screen} ${styles.screenLight}`}>
                  <p className={styles.screenLabel}>Protection</p>
                  <div className={styles.gauge} aria-hidden="true">
                    <span />
                  </div>
                  <p className={styles.gaugeNote}>
                    Margin <strong>2.31</strong> · guard at 1.25
                  </p>
                  <dl className={styles.rows}>
                    <div>
                      <dt>Reserve</dt>
                      <dd>120.00 USDC</dd>
                    </div>
                    <div>
                      <dt>Keeper</dt>
                      <dd className={styles.good}>watching</dd>
                    </div>
                    <div>
                      <dt>Last repayment</dt>
                      <dd>0.40 USDC</dd>
                    </div>
                  </dl>
                  <p className={styles.cta}>Add to reserve</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Wraps the main page so that it slides over the last intro slide the way
 * the slides slide over one another.
 */
export function MainSheet({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${styles.sheet} ${styles.main}`} data-progress>
      <div className={styles.mainInner}>{children}</div>
    </div>
  );
}
