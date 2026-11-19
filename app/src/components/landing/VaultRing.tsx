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
  /** Pattern of the small crest at the top of the card. */
  crest: Pattern;
}

type Pattern = "checker" | "scallop" | "waves" | "stripes" | "dots" | "cross";

const VAULTS: Vault[] = [
  {
    family: "Bitcoin vault",
    asset: "cirBTC",
    headline: "Pay with your bitcoin. Keep your bitcoin.",
    text: "Post cirBTC, borrow exactly what each payment needs.",
    live: true,
    crest: "checker",
  },
  {
    family: "Ether vault",
    asset: "ETH",
    headline: "Spend against your ether, not from it.",
    text: "The same slate, with ETH as collateral.",
    live: false,
    crest: "waves",
  },
  {
    family: "Real-world assets",
    asset: "Treasury bills",
    headline: "Let tokenized T-bills pay the bills.",
    text: "Yield-bearing collateral behind every payment.",
    live: false,
    crest: "stripes",
  },
  {
    family: "Real-world assets",
    asset: "Gold",
    headline: "Gold in the vault, USDC at the till.",
    text: "Tokenized gold as collateral for daily spending.",
    live: false,
    crest: "scallop",
  },
  {
    family: "Real-world assets",
    asset: "Equities",
    headline: "Hold your stocks. Pay from their weight.",
    text: "Tokenized equities, borrowed against at the best rate.",
    live: false,
    crest: "dots",
  },
];

/** Cards of the ring, in order: vault cards alternate with pattern cards. */
const CARDS: ({ vault: Vault } | { pattern: Pattern })[] = [
  { vault: VAULTS[0] },
  { pattern: "waves" },
  { vault: VAULTS[1] },
  { pattern: "cross" },
  { pattern: "scallop" },
  { vault: VAULTS[2] },
  { pattern: "checker" },
  { vault: VAULTS[3] },
  { pattern: "dots" },
  { pattern: "stripes" },
  { vault: VAULTS[4] },
  { pattern: "cross" },
];

/** Vertical offsets, in card heights, that scatter the cards on two tiers. */
const TIERS = [-0.42, 0.5, -0.3, 0.62, -0.55, 0.4];

/**
 * The landing page's hero scene: a slowly rotating ring of collateral vault
 * cards. Vaults that are not deployed are marked "Soon", so the page never
 * presents them as usable. Pure CSS; it stands still with reduced motion.
 *
 * @param props.rate Live borrow rate shown on the vaults in service, already
 * formatted (for example "3.10%"), or `null` when rates could not be read.
 */
export function VaultRing({ rate }: { rate: string | null }) {
  return (
    <div className={styles.stage} aria-label="Ardoise collateral vaults">
      <div className={styles.tilt}>
        <ul className={styles.ring}>
          {CARDS.map((card, i) => (
            <li
              key={i}
              className={styles.slot}
              style={{ "--angle": `${(360 / CARDS.length) * i}deg`, "--lift": TIERS[i % TIERS.length] } as React.CSSProperties}
            >
              {"vault" in card ? (
                <article className={`${styles.card} ${styles.info}`}>
                  <span className={`${styles.crest} ${styles[card.vault.crest]}`} aria-hidden="true" />
                  <p className={styles.family}>
                    {card.vault.family} · {card.vault.asset}
                  </p>
                  <h3 className={styles.headline}>{card.vault.headline}</h3>
                  <p className={styles.text}>{card.vault.text}</p>
                  <p className={styles.status}>
                    <span className={card.vault.live ? styles.live : styles.soon}>
                      {card.vault.live ? "Live on Arc mainnet" : "Soon"}
                    </span>
                    {card.vault.live && rate !== null && <span>USDC at {rate}</span>}
                  </p>
                </article>
              ) : (
                <div className={`${styles.card} ${styles[card.pattern]}`} aria-hidden="true" />
              )}
              <div className={`${styles.card} ${styles.back} ${styles[BACKS[i % BACKS.length]]}`} aria-hidden="true" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Patterns of the card backs, seen when a card is on the far side of the ring. */
const BACKS: Pattern[] = ["scallop", "checker", "stripes", "dots", "waves"];
