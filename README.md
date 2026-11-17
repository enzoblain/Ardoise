# Ardoise

> Pay anyone, on any chain, with your bitcoin without selling it: each payment borrows exactly the amount on Arc at the best available rate, and your position is protected from liquidation.

Built for **UBC Hackathon 2026 (University Blockchain Conference, UT Austin)**.

## Demo

- Live app: _coming soon_
- Demo video: _coming soon_

## The problem

Paying with bitcoin usually means selling it, which loses the exposure and, in the US, triggers capital gains tax. Borrowing against it avoids both, but today it is a loan you manage by hand: pick a lender, watch your margin, repay. Circle's Borrow Kit uses a single lender (Morpho) and does not protect the position from liquidation.

## The solution

Ardoise turns a cirBTC position on Arc into a payment account. Each payment borrows exactly the amount from the best lending venue on Arc (Aave V4 or Morpho), delivers it on the payee's chain through CCTP or Gateway, and records one debt line per payment. A position guard refuses payments that would push the margin too low and repays debt before liquidation.

## How it works

_Architecture overview and diagram to be added as the project is built._

## Built with Circle and Arc

_Where and how each sponsor technology is used, with links to the relevant files._

## Getting started

### Prerequisites

### Installation

```bash
TBD
```

### Run

```bash
TBD
```

## Project structure

## Roadmap

## Team

Enzo Blain, Hugo Thomas

## License

MIT
