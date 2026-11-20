import { SiteHeader } from "@/components/SiteHeader";
import { MAINNET_DEPLOYMENT } from "@/lib/contracts/deployments";

const EXPLORER = "https://explorer.arc.io";
// The first payment made from the app on Arc mainnet (roadmap C4, README "Demo").
const PAY_TX = "0x9dfdd3d8ba60968a8feaed312edd03ad8c238850e89ec3af05cb3aa8b5836aed";
const MINT_TX = "0x80d15046477b5332f3c55150b82dfeba38dbb97e15af9e70d792ffa266408a4b";

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
      { what: "Modular Wallets", how: "A passkey can own a Circle smart account on Arc, with no seed phrase (built in the app, not yet run on mainnet)." },
    ],
  },
];

/** The Arc / Circle page (`/stack`): what Ardoise uses from each, with links to the proofs on chain. */
export default function StackPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#fafafa]">
      <SiteHeader />
      <main>
        <section id="stack" className="mx-auto max-w-6xl px-6 py-16">
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

      </main>
    </div>
  );
}
