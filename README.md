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

## How it works

_Architecture overview and diagram to be added as the project is built._

## Built with Circle and Arc

_Where and how each sponsor technology is used, with links to the relevant files._

- **CCTP (Cross-Chain Transfer Protocol):** a payment to a payee on Base is burned on Arc and minted on Base by Circle's forwarder (CCTP fast transfer). The app tracks each delivery through Circle's attestation service (Iris): [`app/src/lib/delivery.ts`](app/src/lib/delivery.ts), shown on the payment page [`app/src/app/payments/[txHash]/page.tsx`](app/src/app/payments/[txHash]/page.tsx).
- **Arc:** the app reads Arc Testnet or Arc mainnet, chosen by `NEXT_PUBLIC_ARDOISE_NETWORK`: [`app/src/lib/network.ts`](app/src/lib/network.ts).

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
contracts/   Solidity contracts (Foundry); empty scaffold for now
app/         Next.js + viem front end; for now the Arc connection and the cross-chain payment tracking page
keeper/      Node keeper; for now follows Arc mainnet blocks
docs/        Roadmap
```

## Roadmap

## Team

Enzo Blain, Hugo Thomas

## License

MIT
