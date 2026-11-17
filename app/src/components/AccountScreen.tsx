"use client";

import { useMemo, useState } from "react";
import type { Venue } from "@/lib/ardoise";
import { createMockArdoise } from "@/lib/mockArdoise";
import { PayScreen } from "@/components/PayScreen";
import { Statement } from "@/components/Statement";

/**
 * The account's two views, sharing one account client: the pay screen and,
 * below it, the statement that each payment adds a line to.
 *
 * @param props.venues Venues with their live rates, read on the server.
 */
export function AccountScreen({ venues }: { venues: Venue[] }) {
  // The mock keeps its state in memory for as long as the page is open; C4
  // replaces it with the on-chain client.
  const account = useMemo(() => createMockArdoise(venues), [venues]);
  const [payments, setPayments] = useState(0);

  return (
    <>
      <PayScreen account={account} venues={venues} onPaid={() => setPayments((n) => n + 1)} />
      <Statement account={account} venues={venues} version={payments} />
    </>
  );
}
