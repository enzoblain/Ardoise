import { Fraunces } from "next/font/google";
import { LogoMark } from "@/components/LogoMark";
import styles from "./Intro.module.css";
import { AccessButton } from "./LandingGate";
import { ScrollProgress } from "./ScrollProgress";
import { VaultRing } from "./VaultRing";

/** Display typeface of the intro: the title and the chapter headings. */
const display = Fraunces({ subsets: ["latin"], weight: "300" });

/** One step of a payment, shown on the second chapter. */
export interface IntroStep {
  title: string;
  text: string;
}

/** A link to a proof on a block explorer. */
export interface IntroLink {
  label: string;
  href: string;
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

/** One field of the payment slip; `step` is the payment step that fills it in. */
function SlipField({ label, value, step }: { label: string; value: string; step: 1 | 2 | 3 }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={styles[`fill${step}`]}>{value}</dd>
    </div>
  );
}

/**
 * The opening slides of the landing page, played like a presentation as the
 * visitor scrolls, on one pinned stage:
 *
 * 1. the ring of collateral vaults;
 * 2. chapter 01, borrowing, which scrolls over the stage;
 * 3. chapter 02, the three steps of a payment, with a payment slip that is
 *    filled in as the steps go by;
 * 4. chapter 03, protection: the colour opens from the phone on the right,
 *    the slip settles into it, and the button to the main page appears.
 *
 * The slip and the phone are illustrations with example amounts; only the
 * borrow rate is live.
 *
 * @param props.rate Live borrow rate, already formatted (for example "3.10%"), or `null`.
 * @param props.steps The three steps of a payment.
 * @param props.links Explorer links proving the first mainnet payment.
 */
export function Intro({ rate, steps, links }: { rate: string | null; steps: IntroStep[]; links: IntroLink[] }) {
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

          <div className={styles.steps}>
            <ChapterLabels about="paying" chapter="02" />
            <div className={styles.column}>
              <h2 className={`${styles.heading} ${display.className}`}>One payment, one line on the slate.</h2>
              <ol className={styles.stepList}>
                {steps.map((step, i) => (
                  <li key={step.title} className={styles[`step${i + 1}`]}>
                    <span className={styles.stepNumber}>0{i + 1}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className={`${styles.proof} ${styles.step3}`}>
                <span>Real, on mainnet:</span>
                {links.map((link) => (
                  <a key={link.href} href={link.href}>
                    {link.label} ↗
                  </a>
                ))}
              </p>
            </div>
          </div>

          <div className={styles.day}>
            <ChapterLabels about="protection" chapter="03" />
            <div className={styles.column}>
              <h2 className={`${styles.heading} ${display.className}`}>Add liquidity. Our bot covers your exposure.</h2>
              <p className={styles.lead}>
                Keep a reserve of USDC next to your position. When the market moves against you, the Ardoise keeper
                repays your debt with it to keep the position away from liquidation.
              </p>
              <ul className={styles.lines}>
                <li>A guard refuses any payment that would leave your health factor under 1.25.</li>
                <li>The bot can only repay your own account.</li>
                <li>
                  Other currencies for the reserve <span className={styles.soon}>Soon</span>
                </li>
                <li>
                  Staking the reserve while it waits <span className={styles.soon}>Soon</span>
                </li>
              </ul>
            </div>
            <div className={styles.accessRow}>
              <AccessButton />
            </div>
            <div className={styles.phone}>
              <div className={styles.screen}>
                <p className={styles.appBar}>
                  <LogoMark size={16} />
                  Ardoise
                </p>
                <div className={styles.cardSlot} />
                <div className={styles.gauge} aria-hidden="true">
                  <span />
                </div>
                <p className={styles.gaugeNote}>
                  Margin <strong>2.31</strong> · guard at 1.25 · keeper watching
                </p>
                <p className={styles.cta}>Add to reserve</p>
              </div>
            </div>
          </div>

          <article className={styles.slip} aria-label="Example payment slip">
            <p className={styles.slipHead}>
              <LogoMark size={22} />
              Payment slip · cirBTC vault
            </p>
            <dl className={styles.slipFields}>
              <SlipField label="Amount" value="24.00 USDC" step={1} />
              <SlipField label="To" value="0x7c3f…a91e · Base" step={1} />
              <SlipField label="Borrowed at" value={rate ?? "best rate"} step={2} />
              <SlipField label="Collateral" value="cirBTC, untouched" step={2} />
              <SlipField label="Status" value="Delivered · line #1" step={3} />
            </dl>
            <p className={styles.slipFoot}>Live on Arc mainnet</p>
          </article>
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
    </div>
  );
}
