import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "@/components/LogoMark";

/**
 * Header of the app's pages (`/app`, `/request`, `/payments/...`): the logo
 * back to the landing page, links between paying and requesting a payment,
 * and an optional status on the right.
 *
 * @param props.current The page being shown, highlighted in the links.
 * @param props.status Shown on the right, for example the network status.
 */
export function AppHeader({ current, status }: { current?: "pay" | "request"; status?: ReactNode }) {
  const link = (page: "pay" | "request", href: string, label: string) => (
    <Link
      href={href}
      aria-current={current === page ? "page" : undefined}
      className={`rounded-full px-3 py-1.5 transition-colors ${current === page ? "bg-surface text-foreground" : "text-muted hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-5">
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <LogoMark size={28} />
          Ardoise
        </Link>
        <nav className="flex items-center gap-1 text-sm" aria-label="App">
          {link("pay", "/app", "Pay")}
          {link("request", "/request", "Request")}
        </nav>
      </div>
      {status}
    </header>
  );
}
