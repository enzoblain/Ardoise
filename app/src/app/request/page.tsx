import type { Metadata } from "next";
import { AppHeader } from "@/components/AppHeader";
import { RequestForm } from "@/components/RequestForm";

export const metadata: Metadata = {
  title: "Request a payment · Ardoise",
  description: "Get paid in USDC by someone who pays from their bitcoin: share a link or a QR code.",
};

/** Request page (`/request`): builds a payment request link and its QR code. */
export default function RequestPage() {
  return (
    <div className="min-h-screen">
      <AppHeader current="request" />
      <main className="mx-auto max-w-6xl px-6 pb-16">
        <RequestForm />
      </main>
    </div>
  );
}
