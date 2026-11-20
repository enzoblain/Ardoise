import Link from "next/link";
import { HeaderWallet } from "@/components/HeaderWallet";
import { LogoMark } from "@/components/LogoMark";

/** A section of the app, as `/app?tab=`. */
export type AppTab = "positions" | "new" | "pay" | "markets" | "collateral" | "stress";

/** The app's sections, in the order of the header. */
export const APP_TABS: [AppTab, string][] = [
  ["positions", "My positions"],
  ["new", "New position"],
  ["pay", "Pay someone"],
  ["markets", "Markets"],
  ["collateral", "Collateral"],
  ["stress", "Stress test"],
];

/**
 * The header shared by the main landing page and the app: the brand (back to
 * the intro), the app's sections on the left, and on the right the way back
 * to the intro, the Arc and Circle section of the landing page, and the
 * wallet: Connect wallet, or the connected wallet's address.
 *
 * @param props.current The app section being shown, if any, to mark it.
 */
export function SiteHeader({ current }: { current?: AppTab }) {
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 py-5">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <Link href="/?intro" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <LogoMark size={28} />
          Ardoise
        </Link>
        <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="App sections">
          {APP_TABS.map(([id, label]) => (
            <Link
              key={id}
              href={`/app?tab=${id}`}
              aria-current={current === id ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                current === id ? "bg-[#fafafa] text-[#0a0a0a]" : "text-[#a1a1a1] hover:text-white"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <nav className="flex items-center gap-6 text-sm" aria-label="Site">
        <Link href="/?intro" className="hidden text-[#a1a1a1] transition-colors hover:text-white sm:inline">
          How it works
        </Link>
        <Link href="/#stack" className="hidden text-[#a1a1a1] transition-colors hover:text-white sm:inline">
          Arc / Circle
        </Link>
        <HeaderWallet />
      </nav>
    </header>
  );
}
