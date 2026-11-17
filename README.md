# Ardoise

> Pay anyone, on any chain, with your bitcoin without selling it: each payment borrows exactly the amount on Arc at the best available rate, and your position is protected from liquidation.

Built for **UBC Hackathon 2026 (University Blockchain Conference, UT Austin)**.

## Demo

- Live app: _coming soon_
- Demo video: _coming soon_

## The problem

Paying with bitcoin usually means selling it, which loses the exposure and, in the US, triggers capital gains tax. Borrowing against it avoids both, but today it is a loan you manage by hand: pick a lender, watch your margin, repay. Circle's Borrow Kit uses a single lender (Morpho) and does not protect the position from liquidation.

## The solution

Ardoise turns a cirBTC position on Arc into a payment account. Each payment borrows exactly the amount from the best lending venue on Arc (Aave V4 or Morpho), delivers it on the payee's chain through CCTP, and records one debt line per payment. A position guard refuses payments that would push the margin too low and repays debt before liquidation.

Every payment appears as a line in the account statement (amount, venue, rate, payee, memo, interest so far), built from the account's `Paid` and `LineRepaid` events.

## How it works

_Architecture overview and diagram to be added as the project is built._

## Built with Circle and Arc

_Where and how each sponsor technology is used, with links to the relevant files._

- **CCTP (Cross-Chain Transfer Protocol):** a payment to a payee on Base is burned on Arc and minted on Base by Circle's forwarder (CCTP fast transfer). The app tracks each delivery through Circle's attestation service (Iris): [`app/src/lib/delivery.ts`](app/src/lib/delivery.ts), shown on the payment page [`app/src/app/payments/[txHash]/page.tsx`](app/src/app/payments/[txHash]/page.tsx).
- **Gateway:** the keeper repays debt from the user's Circle Gateway balance on Base through standing orders, signed burn intents that can only pay the user's own Ardoise account, delivered on Arc by Circle's forwarder: [`keeper/src/gateway.ts`](keeper/src/gateway.ts). Users deposit, sign orders and repay in one click from the app ([`app/src/lib/gateway.ts`](app/src/lib/gateway.ts)), and the keeper checks each order before storing it ([`keeper/src/intake.ts`](keeper/src/intake.ts)); explained in [`docs/api.md`](docs/api.md).
- **CCTP fees:** before each payment to Base, the app asks Iris for the fast-transfer and forwarder fee and borrows it on top of the amount (`maxFee` in `pay()`): [`app/src/lib/fees.ts`](app/src/lib/fees.ts).
- **Arc:** the app reads Arc Testnet or Arc mainnet, chosen by `NEXT_PUBLIC_ARDOISE_NETWORK`: [`app/src/lib/network.ts`](app/src/lib/network.ts). The live USDC borrow rates of Aave V4 and Morpho against cirBTC are always read on Arc mainnet, where those markets are: [`app/src/lib/venues.ts`](app/src/lib/venues.ts).

## Getting started

### Prerequisites

- Node.js 22.9 or later, with npm
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`)

### Installation

```bash
git clone --recurse-submodules https://github.com/enzoblain/Ardoise.git
cd Ardoise
(cd app && npm install)
(cd keeper && npm install)
cp .env.example .env   # optional for read-only use: Arc reads default to the public RPC
```

The app and the keeper both read the `.env` file at the repository root.

### Run

Run the front end and the keeper in two separate terminals, from the repository root:

```bash
(cd app && npm run dev)      # front end on http://localhost:3000
```

```bash
(cd keeper && npm start)     # keeper, polls Arc mainnet for new blocks
```

Foundry only reads a `.env` inside `contracts/`, so export the root one before using an RPC alias (`--rpc-url arc`):

```bash
set -a && source .env && set +a
```

### Test

```bash
(cd contracts && forge build && forge test)
(cd app && npm run lint && npm test && npm run build)
(cd keeper && npm run typecheck)
```

## Project structure

```
contracts/   Solidity contracts (Foundry); for now the frozen interfaces in src/interfaces/
app/         Next.js + viem front end: pay screen and statement (simulated account, live rates), cross-chain payment tracking page
keeper/      Node keeper; for now follows Arc mainnet blocks
docs/        Roadmap and contract interfaces (api.md)
```

## Roadmap

## Team

Enzo Blain, Hugo Thomas

## License

MIT
