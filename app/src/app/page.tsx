import Link from "next/link";
import { Markets } from "@/components/Markets";
import { SiteHeader } from "@/components/SiteHeader";
import { Intro } from "@/components/landing/Intro";
import { IosDownload } from "@/components/landing/IosDownload";
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
    title: "Put up your bitcoin",
    text: "Your cirBTC goes into your own position on Aave V4 or Morpho, on Arc. Ardoise never holds it and can never withdraw it.",
  },
  {
    title: "Borrow, or pay someone directly",
    text: "Borrow USDC to your wallet, or have Ardoise pay a payee straight away: it borrows exactly the amount at the cheapest lender, after checking your margin.",
  },
  {
    title: "Set aside a reserve, the keeper does the rest",
    text: "If your margin runs low, the keeper repays your debt from the reserve you set aside, before any liquidation. Each borrowing is one line on your statement.",
  },
];

/**
 * Landing page: opening slides, then, once the visitor asks for it, what Ardoise does, the live
 * borrow rates on Arc mainnet, what Ardoise uses from Arc and Circle, and the way into the app.
 */
export default async function Landing() {
  const venues = await readVenueRates().catch(() => null);
  const best = venues?.filter((v) => v.borrowable !== false).sort((a, b) => a.rateBps - b.rateBps)[0];

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
      <SiteHeader />

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
              Borrow USDC against your bitcoin on Arc, at the best available rate, or pay someone with it directly. A reserve you set
              aside and a keeper guard your position against liquidation.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/app" className="rounded-full bg-[#fafafa] px-6 py-3 font-medium text-[#0a0a0a] transition-opacity hover:opacity-85">
                My position →
              </Link>
              <Link href="/?intro" className="rounded-full border border-[#262626] px-6 py-3 font-medium text-[#fafafa] transition-colors hover:border-[#4a4a4a]">
                How it works
              </Link>
            </div>
            <p className="text-xs text-[#6b6b6b]">No wallet needed to try it: the app opens on a demo account.</p>
            <IosDownload />
          </div>
          <div className="flex justify-center py-6 md:py-0">
            <SlateScene />
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          {venues ? (
            <Markets venues={venues} pickHref={(id) => `/app?tab=new&venue=${id}`} />
          ) : (
            <p className="text-sm text-[#6b6b6b]">The lending rates on Arc cannot be read right now.</p>
          )}
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
