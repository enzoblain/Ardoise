# Roadmap

Who builds what, and when, until the UBC Hackathon 2026 submission. Every agent picks its task here and works only on it.

Last updated: 2026-11-17. All times are **CST (Austin, UTC-6)**; Paris is CST + 7 h.
Status: ⬜ to do, 🔄 in progress, ✅ done, ✂️ cut.

## Who is who

| Person | Role | Claude accounts | Time zone | Owns (folders) |
|--------|------|-----------------|-----------|----------------|
| Enzo Blain | Product, front end, demo, live pitch at the final | 1 (account E) | Paris (CET) | `app/`, cross-chain sending from the app, README, demo video, Devpost text |
| Hugo Thomas | Contracts, engine, position guard | 2 (accounts H1 and H2) | Paris (to confirm) | `contracts/` (H1: account, venues, ledger; H2: guard), `keeper/` (H2) |

## Milestones

| When (CST) | Paris | Milestone |
|------------|-------|-----------|
| Tue 11/17, 14:00 | Tue 21:00 | Blocking tests done: each has an explorer link or a decided fallback |
| Tue 11/17, 16:00 | Tue 23:00 | Shared groundwork merged into `main` (scaffold + interfaces); the three tracks start |
| Wed 11/18, 10:00 | Wed 17:00 | Sync point 1: everyone merges what is ready and updates their branch |
| Wed 11/18, 18:00–19:00 | Thu 01:00–02:00 | Circle office hours (Borrow Kit positioning, Gateway for deleveraging) |
| Wed 11/18, 20:00 | Thu 03:00 | Contracts deployed on Arc mainnet; app wired to mock contracts |
| Thu 11/19, 08:00 | Thu 15:00 | Sync point 2: app wired to the real contracts |
| Thu 11/19, 14:00 | Thu 21:00 | Full demo path works end to end |
| Thu 11/19, 20:00 | Fri 03:00 | README, video and Devpost text ready |
| **Fri 11/20, 00:00** | **Fri 07:00** | **Crunch mode starts**: demo-path fixes only |
| **Fri 11/20, 11:30** | **Fri 18:30** | **Merge freeze** |
| **Fri 11/20, 12:00** | **Fri 19:00** | **Submission on Devpost** |
| Sat 11/21 | — | Live final at UT Austin (in-person attendance required for any prize) |

## Shared groundwork (blocks everything else)

| # | Task | Who | When | Branch | Files | Done when | Status |
|---|------|-----|------|--------|-------|-----------|--------|
| 0.1 | Mainnet tests: buy ~$30–50 of cirBTC (Uniswap v3), supply it on the Aave V4 Main Spoke, borrow $1 through `borrowOnBehalfOf` from a test contract | Hugo · H1 | Tue 11/17 morning | none (experiments) | — | Explorer links recorded, or fallback decided | ⬜ |
| 0.2 | Tests: Circle passkey wallet (MSCA) on Arc mainnet; timed USDC transfer Arc → Base (CCTP Fast Transfer or Gateway) | Enzo · E | Tue 11/17 morning | none (experiments) | — | Passkeys work or fall back to a regular wallet; Arc → Base delay measured | ⬜ |
| 0.3 | Repository scaffold: `contracts/` (Foundry), `app/` (Next.js + viem), `keeper/` (Node); install, run and test commands in `CLAUDE.md` and the README | Enzo · E | Tue 11/17 afternoon | `chore/scaffold` | root, `contracts/`, `app/`, `keeper/` (skeletons) | `forge build` and `npm run dev` run; no `TBD` left in `CLAUDE.md` | ⬜ |
| 0.4 | Frozen interfaces: `IVenue` (`rate`, `available`, `healthAfter`, `borrow`, `repay`), `IArdoise` (`pay`, `repay`, `lines`, `health`), debt-line format, events | Hugo · H2 | Tue 11/17 afternoon | `feat/interfaces` | `contracts/src/interfaces/` | Merged into `main`; no change without telling the others first | ⬜ |

## Track A — On-chain core · Hugo, account H1

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| A1 | `AaveV4Adapter` (rate, liquidity, health after, borrow, repay) + tests | Wed 11/18 morning | 0.1, 0.4 | `feat/aave-adapter` | `contracts/src/venues/AaveV4Adapter.sol`, tests | Tests pass; a real borrow of a few dollars on mainnet | ⬜ |
| A2 | `ArdoiseAccount`: `pay()` picks the venue, borrows, sends, enforces per-payment and daily caps | Wed 11/18 midday | A1 | `feat/ardoise-account` | `contracts/src/ArdoiseAccount.sol`, tests | `pay()` borrows and pays on mainnet | ⬜ |
| A3 | Debt ledger (amount, venue, rate, payee, memo, accrued interest) + events | Wed 11/18 afternoon | A2 | `feat/debt-ledger` | `contracts/src/` (ledger), tests | One line per payment, readable by the app | ⬜ |
| A4 | Mainnet deployment + addresses in the README | Wed 11/18 evening | A3 | `chore/deploy-mainnet` | `contracts/script/`, README (addresses) | Contracts verified on the Arc explorer | ⬜ |

## Track B — Position guard · Hugo, account H2

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| B1 | Margin check before each payment (refuse or reduce below the threshold) | Wed 11/18 morning | 0.4 | `feat/margin-check` | `contracts/src/guard/`, tests | A payment over the threshold is refused in tests | ⬜ |
| B2 | Keeper that can only repay, plus a public `sweep()` (a plain USDC `transfer()` runs no recipient code) | Wed 11/18 afternoon | B1 | `feat/keeper` | `keeper/`, repay function in `contracts/src/guard/` | Debt goes down after a keeper-triggered repayment | ⬜ |
| B3 | Bitcoin price-drop simulator, labelled as a simulation (no local Arc fork: native USDC breaks there) | Thu 11/19 morning | B1 | `feat/price-sim` | `contracts/src/guard/` or `keeper/` | The "BTC drops → payment refused → repayment" demo runs | ⬜ |
| B4 | (if time allows) deleveraging from a Gateway balance; otherwise a one-click user repayment | Thu 11/19 | B2 | `feat/gateway-deleverage` | `keeper/` | Repayment funded from Base, or fallback agreed | ⬜ |

## Track C — What the judges see · Enzo, account E

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| C1 | Pay screen + Aave / Morpho rate comparison (real reads) + margin gauge, on mock contracts | Wed 11/18 morning | 0.3, 0.4 | `feat/pay-screen` | `app/` (pay screen) | The flow can be clicked end to end with mocks | ⬜ |
| C2 | Line-by-line statement | Wed 11/18 afternoon | 0.4 | `feat/statement` | `app/` (statement) | Lines render from contract events | ⬜ |
| C3 | Sending to Base (CCTP Fast Transfer or Gateway, based on test 0.2) | Wed 11/18 evening | 0.2 | `feat/crosschain-send` | `app/` (sending), or `contracts/src/` if sending lives in `pay()` (decide with Hugo at sync point 1) | A payment lands on Base, with an explorer link | ⬜ |
| C4 | Wire the app to the real mainnet contracts | Thu 11/19 morning | A4, C1–C3 | `feat/wire-contracts` | `app/` (config, calls) | A real payment from the app, line visible in the statement | ⬜ |

## Assembly and submission

| # | Task | Who | When | Depends on | Done when | Status |
|---|------|-----|------|------------|-----------|--------|
| R1 | Rehearse the full demo path (pay on Base, statement, guard) | Enzo + Hugo | Thu 11/19 midday | C4, B3 | Three clean runs in a row | ⬜ |
| R2 | README: problem, solution, How it works (Mermaid), Built with Circle and Arc (with file links), Economic design and risk assumptions, contract addresses, 2-minute test | Enzo · E | Thu 11/19 afternoon | R1 | A newcomer understands and tests it in under 2 minutes | ⬜ |
| R3 | 2–3 min video (a real payment in the first 30 seconds) + backup video for the final | Enzo · E | Thu 11/19 evening | R1 | Video online, linked from the README | ⬜ |
| R4 | Devpost text (criterion → evidence mapping) | Enzo · E | Thu 11/19 evening | R2 | Draft ready on Devpost | ⬜ |
| R5 | Extras only if everything else works: EURC borrowing on Morpho, real Morpho borrowing, QuickNode Streams | Hugo · H1/H2 | Thu 11/19 afternoon | R1 | Only after R1 | ⬜ |
| R6 | Pre-submission audit | Enzo · E | Fri 11/20, start of crunch | R2–R4 | Blocking issues fixed | ⬜ |

## Crunch mode (from Fri 11/20 00:00 CST)

- Only fixes to the demo path and the deliverables, on `hotfix/...` branches, with a quick review.
- Merge freeze at 11:30 CST; submission at 12:00 CST.

## Parallel-work rules

- **One track = one Claude account = its own folders.** Track A: `contracts/src/` (account, venues, ledger) and `contracts/script/`. Track B: `contracts/src/guard/` and `keeper/`. Track C: `app/`. Two tracks never edit the same file.
- **Single contact point:** the interfaces and debt-line format frozen in 0.4. Changing them means telling the others first.
- **Sync points:** Wed 11/18 10:00 CST and Thu 11/19 08:00 CST: everyone merges what is ready and updates their branch from `main`.
- **Every task:** one branch, one pull request, a review by a fresh Claude session, merge with a human's go-ahead (see `CLAUDE.md`).
- When a task changes status, update its row here in the same pull request.

## If we fall behind

Cut in this order, first to last:
1. R5 (EURC, real Morpho borrowing, QuickNode).
2. B4 (Gateway deleveraging) → one-click user repayment.
3. Passkeys → regular wallet.
4. Live rate comparison → values read once and displayed.
5. C3 (sending to Base) → payments on Arc only, Base shown on a slide.
6. Switch the process level from `full` to `light` (reviews only for contracts and anything that moves money).
