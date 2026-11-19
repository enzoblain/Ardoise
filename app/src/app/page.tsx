import { Instrument_Serif } from "next/font/google";
import Link from "next/link";
import { LogoMark } from "@/components/LogoMark";
import { PhoneShowcase } from "@/components/landing/PhoneShowcase";
import { SlateScene } from "@/components/landing/SlateScene";
import { VaultRing } from "@/components/landing/VaultRing";
import { MAINNET_DEPLOYMENT } from "@/lib/contracts/deployments";
import { formatBps } from "@/lib/format";
import { readVenueRates } from "@/lib/venues";

// Rates are read on Arc mainnet; refreshing them once a minute is enough for a
// landing page and keeps it off the public RPC's rate limit.
export const revalidate = 60;

/** Display typeface of the landing page: the title and the section headings. */
const display = Instrument_Serif({ subsets: ["latin"], weight: "400" });

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

const BUILT_WITH = ["Arc mainnet", "USDC", "cirBTC", "CCTP", "Gateway", "Aave V4"];

/**
 * Landing page: what Ardoise does, the live borrow rates on Arc mainnet, how
 * a payment works, how the position is protected, and the way into the app.
 */
export default async function Landing() {
  const venues = await readVenueRates().catch(() => null);
  // Only venues Ardoise can borrow from may be advertised as the payment rate;
  // the others (Morpho today) are shown as comparisons.
  const best = venues?.filter((v) => v.borrowable !== false).sort((a, b) => a.rateBps - b.rateBps)[0];
  const compared = venues?.find((v) => v.borrowable === false);
  const rate = best ? formatBps(best.rateBps) : null;
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
    <div className="min-h-screen bg-black text-[#fafafa]">
      <header className="mx-auto grid max-w-[110rem] grid-cols-[auto_1fr_auto] items-center gap-6 px-6 py-6 md:px-10">
        <Link href="/" className="flex items-center gap-2.5 text-lg font-bold uppercase tracking-tight text-[#f7931a]">
          <LogoMark size={28} />
          Ardoise
        </Link>
        <p className="mx-auto hidden max-w-md text-center text-sm leading-snug text-[#a8a49b] md:block">
          Post collateral, pay anyone in USDC, keep your assets. A bot guards the position on Arc mainnet.
        </p>
        <Link
          href="/app"
          className="col-start-3 rounded-full bg-[#ffd9a8] px-5 py-2.5 text-sm font-semibold text-[#141414] transition-opacity hover:opacity-85"
        >
          Launch app
        </Link>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <h1
            className={`${display.className} relative z-10 px-4 text-center text-[23.5vw] uppercase leading-[0.8] tracking-[-0.02em] text-[#f3efe6]`}
          >
            Ardoise
          </h1>
          <div className="-mt-[7vw]">
            <VaultRing rate={rate} />
          </div>
          <div className="relative z-10 mx-auto -mt-6 flex max-w-6xl flex-col items-center gap-4 px-6 pb-20 text-center">
            <p className="max-w-xl text-lg leading-relaxed text-[#a8a49b]">
              One slate, several vaults. Pay with your bitcoin today; ether and real-world assets are next.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link href="/app" className="rounded-full bg-[#ffd9a8] px-6 py-3 font-semibold text-[#141414] transition-opacity hover:opacity-85">
                Launch app →
              </Link>
              <a href="#how" className="rounded-full border border-[#262626] px-6 py-3 font-medium text-[#fafafa] transition-colors hover:border-[#4a4a4a]">
                How it works
              </a>
            </div>
            <p className="text-xs text-[#6b6b6b]">No wallet needed to try it: the app opens on a demo account.</p>
          </div>
        </section>

        <PhoneShowcase rate={rate} display={display.className} />

        <section className="border-y border-[#1c1c1c]">
          <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-[#1c1c1c] md:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="flex flex-col gap-1 bg-black px-6 py-7">
                <dt className="text-xs uppercase tracking-[0.12em] text-[#6b6b6b]">{s.label}</dt>
                <dd className="text-3xl font-semibold tracking-tight">{s.value}</dd>
                <dd className="text-xs text-[#6b6b6b]">{s.note}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="how" className="mx-auto max-w-6xl scroll-mt-8 px-6 py-24">
          <div className="mb-12 flex flex-col items-center justify-between gap-10 md:flex-row">
            <h2 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">One payment, one line on the slate.</h2>
            <SlateScene />
          </div>
          <ol className="grid gap-px overflow-hidden rounded-2xl border border-[#1c1c1c] bg-[#1c1c1c] md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-3 bg-black p-7">
                <span className="font-mono text-sm text-[#f7931a]">0{i + 1}</span>
                <h3 className="text-lg font-semibold">{step.title}</h3>
                <p className="text-sm leading-relaxed text-[#a1a1a1]">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mx-auto grid max-w-6xl gap-12 px-6 pb-24 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <h2 className="text-3xl font-semibold tracking-tight">Guarded, not just borrowed.</h2>
            <p className="leading-relaxed text-[#a1a1a1]">
              A position guard refuses any payment that would leave your health factor under 1.25. A keeper repays your
              debt with the USDC that reaches your account. With standing orders that can only repay your own account,
              it can also draw on a reserve you keep in Circle Gateway on Base (tested on testnet so far).
            </p>
          </div>
          <div className="flex flex-col gap-4">
            <h2 className="text-3xl font-semibold tracking-tight">Real, on mainnet.</h2>
            <p className="leading-relaxed text-[#a1a1a1]">
              The first payment from the app sent 0.40 USDC to a payee on Base, borrowed on Aave V4 against cirBTC.
            </p>
            <div className="flex flex-wrap gap-3 text-sm">
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
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="flex flex-col items-start gap-6 rounded-3xl border border-[#1c1c1c] bg-[#111111] p-8 md:flex-row md:items-center md:justify-between md:p-12">
            <div className="flex flex-col gap-3">
              <h2 className="text-3xl font-semibold tracking-tight">Put it on the slate.</h2>
              <ul className="flex flex-wrap gap-2">
                {BUILT_WITH.map((t) => (
                  <li key={t} className="rounded-full border border-[#262626] px-3 py-1 text-xs text-[#a1a1a1]">{t}</li>
                ))}
              </ul>
            </div>
            <Link href="/app" className="rounded-full bg-[#fafafa] px-6 py-3 font-medium text-[#0a0a0a] transition-opacity hover:opacity-85">
              Launch app →
            </Link>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-[#1c1c1c] px-6 py-8 text-sm text-[#6b6b6b]">
        <span>Ardoise · UBC Hackathon 2026 · Not audited, small amounts only</span>
        <a href={GITHUB} className="transition-colors hover:text-white">Source on GitHub</a>
      </footer>
    </div>
  );
}
