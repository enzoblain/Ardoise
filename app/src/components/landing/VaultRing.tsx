import { LogoMark } from "@/components/LogoMark";
import styles from "./VaultRing.module.css";

/** A vault shown on the front of a card of the ring. */
interface Vault {
  /** Currency sign printed large on the card. */
  symbol: string;
  /** What the vault is, printed above the headline. */
  family: string;
  /** Asset or currency. */
  asset: string;
  headline: string;
  text: string;
  /** Two short facts, label then value. */
  stats: [string, string][];
  /** "live": works on Arc mainnet today; "app": built in the app, not yet run on mainnet; "soon": not built. */
  status: "live" | "app" | "soon";
  /** Shows the live best borrow rate in the status line. */
  showsRate?: boolean;
}

/**
 * Every card of the ring, in order: what Ardoise borrows against, what it
 * pays out in, and what protects a position. Facts are the deployed values
 * (Aave V4 collateral factor 78%, Morpho LLTV 86%, guard 1.25 / 1.5, caps
 * 10 / 20 USDC) and the mainnet runs (Arc → Base in 4 s, alarm to repayment
 * in 15 s).
 */
const VAULTS: Vault[] = [
  {
    symbol: "₿",
    family: "Bitcoin vault · Aave V4",
    asset: "cirBTC",
    headline: "Pay with your bitcoin. Keep your bitcoin.",
    text: "Post cirBTC in your own Aave position, borrow exactly what each payment needs.",
    stats: [
      ["Collateral factor", "78%"],
      ["Guard minimum", "1.25"],
    ],
    status: "live",
    showsRate: true,
  },
  {
    symbol: "$",
    family: "Paid out in",
    asset: "USDC",
    headline: "Every borrowing lands in dollars.",
    text: "On Arc at once, or on Base through Circle's CCTP in seconds.",
    stats: [
      ["Arc → Base", "4 s"],
      ["Gas on Arc", "USDC"],
    ],
    status: "live",
  },
  {
    symbol: "Ξ",
    family: "Ether vault",
    asset: "ETH",
    headline: "Spend against your ether, not from it.",
    text: "The same slate, with ETH as collateral.",
    stats: [
      ["Collateral", "ETH"],
      ["Borrow", "USDC"],
    ],
    status: "soon",
  },
  {
    symbol: "₿",
    family: "Bitcoin vault · Morpho",
    asset: "cirBTC",
    headline: "A second lender, compared on every payment.",
    text: "Morpho's isolated cirBTC / USDC market: the cheaper one wins.",
    stats: [
      ["Max LTV", "86%"],
      ["Target health", "1.50"],
    ],
    status: "live",
  },
  {
    symbol: "%",
    family: "Real-world assets",
    asset: "Treasury bills",
    headline: "Let tokenized T-bills pay the bills.",
    text: "Yield-bearing collateral behind every payment.",
    stats: [
      ["Collateral", "USYC"],
      ["Yield", "kept"],
    ],
    status: "soon",
  },
  {
    symbol: "◆",
    family: "Protection · Gateway",
    asset: "USDC reserve",
    headline: "A reserve that steps in first.",
    text: "USDC in Circle Gateway on Base, brought to Arc in seconds when the margin runs low.",
    stats: [
      ["Repays", "automatically"],
      ["Only to", "your account"],
    ],
    status: "live",
  },
  {
    symbol: "€",
    family: "Paid out in",
    asset: "EURC",
    headline: "Borrow euros on the same bitcoin.",
    text: "Morpho's EURC / cirBTC market, for payments in euros.",
    stats: [
      ["Currency", "EURC"],
      ["Collateral", "cirBTC"],
    ],
    status: "soon",
  },
  {
    symbol: "Au",
    family: "Real-world assets",
    asset: "Gold",
    headline: "Gold in the vault, USDC at the till.",
    text: "Tokenized gold as collateral for daily spending.",
    stats: [
      ["Collateral", "gold"],
      ["Borrow", "USDC"],
    ],
    status: "soon",
  },
  {
    symbol: "Ξ",
    family: "Protection · CCTP alarm",
    asset: "ETH on Base",
    headline: "Your ether defends your bitcoin.",
    text: "A Circle-attested alarm from Arc sells pre-authorized WETH on Base to repay, within your caps.",
    stats: [
      ["Alarm to repay", "15 s"],
      ["Max slippage", "you set"],
    ],
    status: "live",
  },
  {
    symbol: "▲",
    family: "Real-world assets",
    asset: "Equities",
    headline: "Hold your stocks. Pay from their weight.",
    text: "Tokenized equities, borrowed against at the best rate.",
    stats: [
      ["Collateral", "stocks"],
      ["Borrow", "USDC"],
    ],
    status: "soon",
  },
  {
    symbol: "◎",
    family: "Owner",
    asset: "Passkey",
    headline: "No seed phrase to lose.",
    text: "A passkey can own the account through a Circle smart account, on the web and on iOS.",
    stats: [
      ["Wallet", "Circle MSCA"],
      ["Apps", "web · iOS"],
    ],
    status: "app",
  },
  {
    symbol: "$",
    family: "Your account",
    asset: "Statement",
    headline: "One borrowing, one line on the slate.",
    text: "Lender, rate, interest and payee for each line, repayable at any time.",
    stats: [
      ["Per payment", "10 USDC"],
      ["Per day", "20 USDC"],
    ],
    status: "live",
  },
];

const STATUS_LABEL: Record<Vault["status"], string> = {
  live: "Live on Arc mainnet",
  app: "In the app · beta",
  soon: "Soon",
};

/** Vertical offsets, in card heights, that scatter the cards on two tiers. */
const TIERS = [-0.42, 0.5, -0.3, 0.62, -0.55, 0.4];

/** A blank slate with a few chalk lines: the back of every card. */
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

/** The face of a vault card: its currency, what it is, two facts and whether it is live. */
function VaultFace({ vault, rate }: { vault: Vault; rate: string | null }) {
  return (
    <article className={`${styles.card} ${styles.info}`}>
      <div className={styles.top}>
        <LogoMark className={styles.crest} />
        <span className={styles.symbol} aria-hidden="true">
          {vault.symbol}
        </span>
      </div>
      <p className={styles.family}>
        {vault.family} · {vault.asset}
      </p>
      <h3 className={styles.headline}>{vault.headline}</h3>
      <p className={styles.text}>{vault.text}</p>
      <dl className={styles.stats}>
        {vault.stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.status}>
        <span className={vault.status === "live" ? styles.live : styles.soon}>{STATUS_LABEL[vault.status]}</span>
        {vault.showsRate && rate !== null && <span>USDC at {rate}</span>}
      </p>
    </article>
  );
}

/**
 * The landing page's hero scene: a slowly rotating ring of vault cards (the
 * collateral, the currencies paid out and the protection), each with a slate
 * on its back. What is not on mainnet yet is marked "Soon" or "In the app ·
 * beta", so the page never presents it as usable. Pure CSS; it stands still
 * with reduced motion.
 *
 * @param props.rate Live best borrow rate, shown on the Aave V4 bitcoin vault, already
 * formatted (for example "3.10%"), or `null` when rates could not be read.
 */
export function VaultRing({ rate }: { rate: string | null }) {
  return (
    <div className={styles.stage} aria-label="Ardoise collateral vaults">
      <div className={styles.tilt}>
        <ul className={styles.ring}>
          {VAULTS.map((vault, i) => (
            <li
              key={vault.family + vault.asset}
              className={styles.slot}
              style={{ "--angle": `${(360 / VAULTS.length) * i}deg`, "--lift": TIERS[i % TIERS.length] } as React.CSSProperties}
            >
              <VaultFace vault={vault} rate={rate} />
              <Slate className={styles.back} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
