import Link from "next/link";
import { LogoMark } from "@/components/LogoMark";
import { Intro } from "@/components/landing/Intro";
import { LandingGate } from "@/components/landing/LandingGate";
import { SlateScene } from "@/components/landing/SlateScene";
import { MAINNET_DEPLOYMENT } from "@/lib/contracts/deployments";
import { formatBps } from "@/lib/format";
import { readVenueRates } from "@/lib/venues";

// Rates are read on Arc mainnet; refreshing them once a minute is enough for a
// landing page and keeps it off the public RPC's rate limit.
export const revalidate = 60;

const GITHUB = "https://github.com/enzoblain/Ardoise";
const EXPLORER = "https://explorer.arc.io";
// The first payment made from the app on Arc mainnet (roadmap C4, README "Demo").
const PAY_TX = "0x9dfdd3d8ba60968a8feaed312edd03ad8c238850e89ec3af05cb3aa8b5836aed";
const MINT_TX = "0x80d15046477b5332f3c55150b82dfeba38dbb97e15af9e70d792ffa266408a4b";

const STEPS = [
  {
    title: "Pick who you pay",
    text: "An amount, a payee, their chain: Arc or Base. No sale, no swap, no bridge to set up.",
  },
  {
    title: "Ardoise borrows exactly that",
    text: "At the cheapest lender Ardoise uses on Arc (Aave V4 today), against the cirBTC in your own Aave position, after checking your margin.",
  },
  {
    title: "It lands, and goes on your tab",
    text: "On Arc it is a direct transfer; to Base, Circle's CCTP delivers it in seconds. Your statement gets one new line.",
  },
];

/** What Ardoise uses from its two main stacks (README, "Built with Circle and Arc"). */
const STACK = [
  {
    name: "Arc",
    uses: [
      { what: "Arc mainnet", how: "Every Ardoise contract is deployed on Arc mainnet: the account factory, the lending adapter and the margin guard." },
      { what: "Lending on Arc", how: "Each payment borrows on Arc's Aave V4 market, and the Morpho rate on Arc is compared live." },
      { what: "Gas in USDC", how: "Gas on Arc is paid in USDC, so paying needs no other token." },
      { what: "Keeper", how: "A keeper follows Arc and repays debt with the USDC that reaches an account." },
    ],
  },
  {
    name: "Circle",
    uses: [
      { what: "USDC", how: "What each payment borrows and delivers." },
      { what: "cirBTC", how: "Circle's wrapped bitcoin on Arc, the collateral behind every payment." },
      { what: "CCTP", how: "A payment to Base is burned on Arc and minted on Base by Circle's forwarder, with the fee quoted before paying." },
      { what: "Gateway", how: "A USDC reserve on Base the keeper can draw on, through standing orders that can only repay your own account." },
      { what: "Modular Wallets", how: "A passkey owns a Circle smart account on Arc: sign in and pay without a seed phrase." },
    ],
  },
];

/**
 * Landing page: opening slides, then, once the visitor asks for it, what Ardoise does, the live borrow rates on Arc mainnet, how
 * Ardoise uses from Arc and Circle, and the way into the app.
 */
export default async function Landing() {
  const venues = await readVenueRates().catch(() => null);
  // Only venues Ardoise can borrow from may be advertised as the payment rate;
  // the others (Morpho today) are shown as comparisons.
  const best = venues?.filter((v) => v.borrowable !== false).sort((a, b) => a.rateBps - b.rateBps)[0];
  const compared = venues?.find((v) => v.borrowable === false);
  const stats = [
    best
      ? { label: "Borrow rate now", value: formatBps(best.rateBps), note: `${best.name}, used for payments` }
      : { label: "Borrow rate now", value: "—", note: "rates unavailable right now" },
    compared
      ? { label: `${compared.name} rate`, value: formatBps(compared.rateBps), note: "compared live, not borrowed yet" }
      : { label: "Compared rate", value: "—", note: "rates unavailable right now" },
    { label: "Arc → Base delivery", value: "4 s", note: "first mainnet payment" },
    { label: "Bitcoin sold", value: "0", note: "it stays your collateral" },
  ];

  return (
    <LandingGate
      intro={
        <Intro
          rate={best ? formatBps(best.rateBps) : null}
          steps={STEPS}
          links={[
            { label: "Payment on Arc", href: `${EXPLORER}/tx/${PAY_TX}` },
            { label: "Arrival on Base", href: `https://basescan.org/tx/${MINT_TX}` },
            { label: "Contracts", href: `${EXPLORER}/address/${MAINNET_DEPLOYMENT.factory}` },
          ]}
        />
      }
    >
    <div className="min-h-screen bg-[#0a0a0a] text-[#fafafa]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <LogoMark size={28} />
          Ardoise
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link href="/" className="hidden text-[#a1a1a1] transition-colors hover:text-white sm:inline">How it works</Link>
          <a href="#stack" className="hidden text-[#a1a1a1] transition-colors hover:text-white sm:inline">Arc / Circle</a>
          <Link href="/app?connect=wallet" className="rounded-full bg-[#fafafa] px-4 py-2 font-medium text-[#0a0a0a] transition-opacity hover:opacity-85">
            Connect wallet
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pt-10 pb-24 md:grid-cols-[1.05fr_1fr] md:pt-20">
          <div className="flex flex-col gap-7">
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#262626] px-3 py-1 text-xs text-[#a1a1a1]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#f7931a]" />
              Live on Arc mainnet
            </span>
            <h1 className="text-5xl font-semibold leading-[1.02] tracking-[-0.04em] sm:text-6xl">
              Pay with your bitcoin.
              <br />
              <span className="text-[#6b6b6b]">Keep your bitcoin.</span>
            </h1>
            <p className="max-w-md text-lg leading-relaxed text-[#a1a1a1]">
              Each payment borrows exactly its amount on Arc, at the best available rate, and delivers it on Arc or, through Circle&rsquo;s CCTP, on Base.
              Your position is guarded against liquidation.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/app" className="rounded-full bg-[#fafafa] px-6 py-3 font-medium text-[#0a0a0a] transition-opacity hover:opacity-85">
                My position →
              </Link>
              <Link href="/" className="rounded-full border border-[#262626] px-6 py-3 font-medium text-[#fafafa] transition-colors hover:border-[#4a4a4a]">
                How it works
              </Link>
            </div>
            <p className="text-xs text-[#6b6b6b]">No wallet needed to try it: the app opens on a demo account.</p>
          </div>
          <div className="flex justify-center py-6 md:py-0">
            <SlateScene />
          </div>
        </section>

        <section className="border-y border-[#1c1c1c]">
          <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-[#1c1c1c] md:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="flex flex-col gap-1 bg-[#0a0a0a] px-6 py-7">
                <dt className="text-xs uppercase tracking-[0.12em] text-[#6b6b6b]">{s.label}</dt>
                <dd className="text-3xl font-semibold tracking-tight">{s.value}</dd>
                <dd className="text-xs text-[#6b6b6b]">{s.note}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="stack" className="mx-auto max-w-6xl scroll-mt-8 px-6 py-24">
          <h2 className="mb-4 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">Built on Arc, with Circle.</h2>
          <p className="mb-12 max-w-2xl leading-relaxed text-[#a1a1a1]">
            Ardoise runs on two stacks more than any other: Arc carries every contract and every loan, Circle provides
            the money, the collateral and the way across chains.
          </p>
          <div className="grid gap-px overflow-hidden rounded-2xl border border-[#1c1c1c] bg-[#1c1c1c] md:grid-cols-2">
            {STACK.map((side) => (
              <div key={side.name} className="flex flex-col gap-6 bg-[#0a0a0a] p-7">
                <h3 className="text-2xl font-semibold tracking-tight">{side.name}</h3>
                <dl className="flex flex-col">
                  {side.uses.map((use) => (
                    <div key={use.what} className="flex flex-col gap-1 border-t border-[#1c1c1c] py-4">
                      <dt className="flex items-center gap-2 font-medium">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#f7931a]" />
                        {use.what}
                      </dt>
                      <dd className="text-sm leading-relaxed text-[#a1a1a1]">{use.how}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <a href={`${EXPLORER}/tx/${PAY_TX}`} className="rounded-full border border-[#262626] px-4 py-2 transition-colors hover:border-[#4a4a4a]">
              Payment on Arc ↗
            </a>
            <a href={`https://basescan.org/tx/${MINT_TX}`} className="rounded-full border border-[#262626] px-4 py-2 transition-colors hover:border-[#4a4a4a]">
              Arrival on Base ↗
            </a>
            <a
              href={`${EXPLORER}/address/${MAINNET_DEPLOYMENT.factory}`}
              className="rounded-full border border-[#262626] px-4 py-2 transition-colors hover:border-[#4a4a4a]"
            >
              Contracts ↗
            </a>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="flex flex-col items-start gap-6 rounded-3xl border border-[#1c1c1c] bg-[#111111] p-8 md:flex-row md:items-center md:justify-between md:p-12">
            <h2 className="text-3xl font-semibold tracking-tight">Put it on the slate.</h2>
            <Link href="/app" className="rounded-full bg-[#fafafa] px-6 py-3 font-medium text-[#0a0a0a] transition-opacity hover:opacity-85">
              My position →
            </Link>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-[#1c1c1c] px-6 py-8 text-sm text-[#6b6b6b]">
        <span>Ardoise · UBC Hackathon 2026 · Not audited, small amounts only</span>
        <a href={GITHUB} className="transition-colors hover:text-white">Source on GitHub</a>
      </footer>
    </div>
    </LandingGate>
  );
}
