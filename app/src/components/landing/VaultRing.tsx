import { LogoMark } from "@/components/LogoMark";
import styles from "./VaultRing.module.css";

/** A collateral vault shown on the ring. Only `live` vaults exist on chain. */
interface Vault {
  /** Asset family printed above the headline. */
  family: string;
  /** Collateral asset. */
  asset: string;
  headline: string;
  text: string;
  /** Whether the vault can be used on Arc mainnet today. */
  live: boolean;
}

const VAULTS: Vault[] = [
  {
    family: "Bitcoin vault",
    asset: "cirBTC",
    headline: "Pay with your bitcoin. Keep your bitcoin.",
    text: "Post cirBTC, borrow exactly what each payment needs.",
    live: true,
  },
  {
    family: "Ether vault",
    asset: "ETH",
    headline: "Spend against your ether, not from it.",
    text: "The same slate, with ETH as collateral.",
    live: false,
  },
  {
    family: "Real-world assets",
    asset: "Treasury bills",
    headline: "Let tokenized T-bills pay the bills.",
    text: "Yield-bearing collateral behind every payment.",
    live: false,
  },
  {
    family: "Real-world assets",
    asset: "Gold",
    headline: "Gold in the vault, USDC at the till.",
    text: "Tokenized gold as collateral for daily spending.",
    live: false,
  },
  {
    family: "Real-world assets",
    asset: "Equities",
    headline: "Hold your stocks. Pay from their weight.",
    text: "Tokenized equities, borrowed against at the best rate.",
    live: false,
  },
];

/** Cards of the ring, in order: vault cards alternate with plain slates. */
const CARDS: (Vault | null)[] = [
  VAULTS[0],
  null,
  VAULTS[1],
  null,
  null,
  VAULTS[2],
  null,
  VAULTS[3],
  null,
  null,
  VAULTS[4],
  null,
];

/** Vertical offsets, in card heights, that scatter the cards on two tiers. */
const TIERS = [-0.42, 0.5, -0.3, 0.62, -0.55, 0.4];

/** A blank slate with a few chalk lines: the back of every card, and the filler cards. */
function Slate({ className }: { className?: string }) {
  return (
    <div className={`${styles.card} ${styles.slate} ${className ?? ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <b />
    </div>
  );
}

/** The face of a vault card. */
function VaultFace({ vault, rate }: { vault: Vault; rate: string | null }) {
  return (
    <article className={`${styles.card} ${styles.info}`}>
      <LogoMark className={styles.crest} />
      <p className={styles.family}>
        {vault.family} · {vault.asset}
      </p>
      <h3 className={styles.headline}>{vault.headline}</h3>
      <p className={styles.text}>{vault.text}</p>
      <p className={styles.status}>
        <span className={vault.live ? styles.live : styles.soon}>{vault.live ? "Live on Arc mainnet" : "Soon"}</span>
        {vault.live && rate !== null && <span>USDC at {rate}</span>}
      </p>
    </article>
  );
}

/**
 * The landing page's hero scene: a slowly rotating ring of collateral vault
 * cards, each with a slate on its back. Vaults that are not deployed are
 * marked "Soon", so the page never presents them as usable. Pure CSS; it
 * stands still with reduced motion.
 *
 * @param props.rate Live borrow rate shown on the vaults in service, already
 * formatted (for example "3.10%"), or `null` when rates could not be read.
 */
export function VaultRing({ rate }: { rate: string | null }) {
  return (
    <div className={styles.stage} aria-label="Ardoise collateral vaults">
      <div className={styles.tilt}>
        <ul className={styles.ring}>
          {CARDS.map((vault, i) => (
            <li
              key={i}
              className={styles.slot}
              style={{ "--angle": `${(360 / CARDS.length) * i}deg`, "--lift": TIERS[i % TIERS.length] } as React.CSSProperties}
            >
              {vault === null ? <Slate /> : <VaultFace vault={vault} rate={rate} />}
              <Slate className={styles.back} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
