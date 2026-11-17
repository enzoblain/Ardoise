# Roadmap

Who builds what, and when, until the UBC Hackathon 2026 submission. Every agent picks its task here and works only on it.

Last updated: 2026-11-17. All times are **CST (Austin, UTC-6)**; Paris is CST + 7 h.
Status: ⬜ to do, 🔄 in progress, ✅ done, ✂️ cut.

## Who is who

| Person | Role | Claude accounts | Time zone | Owns (folders) |
|--------|------|-----------------|-----------|----------------|
| Enzo Blain | Product, front end, demo, live pitch at the final | 1 (account E) | Paris (CET) | `app/`, README, demo video, Devpost text |
| Hugo Thomas | Contracts, engine, position guard | 2 (accounts H1 and H2) | Paris (to confirm) | H1: `contracts/src/` except `guard/`, `contracts/script/`, `contracts/deployments.md`; H2: `contracts/src/guard/`, `keeper/` |

## Milestones

| When (CST) | Paris | Milestone |
|------------|-------|-----------|
| Tue 11/17, 14:00 | Tue 21:00 | Blocking tests done: each has an explorer link or a decided fallback |
| Tue 11/17, 16:00 | Tue 23:00 | Shared groundwork merged into `main` (scaffold + interfaces); the three tracks start |
| Wed 11/18, 10:00 | Wed 17:00 | Sync point 1: everyone merges what is ready and updates their branch |
| Wed 11/18, 18:00–19:00 | Thu 01:00–02:00 | Circle office hours (Borrow Kit positioning, Gateway for deleveraging) |
| Wed 11/18, 20:00 | Thu 03:00 | Account, venues and ledger deployed on Arc mainnet (A4); app works on mock contracts |
| Thu 11/19, 08:00 | Thu 15:00 | Sync point 2: all contracts on mainnet; wiring the app to them starts (C4) |
| Thu 11/19, 14:00 | Thu 21:00 | Full demo path works end to end |
| Thu 11/19, 20:00 | Fri 03:00 | README, video and Devpost text ready |
| **Fri 11/20, 00:00** | **Fri 07:00** | **Crunch mode starts**: demo-path fixes only |
| **Fri 11/20, 11:30** | **Fri 18:30** | **Merge freeze** |
| **Fri 11/20, 12:00** | **Fri 19:00** | **Submission on Devpost** |
| Sat 11/21 | — | Live final at UT Austin (in-person attendance required for any prize) |

## Shared groundwork (blocks everything else)

| # | Task | Who | When | Branch | Files | Done when | Status |
|---|------|-----|------|--------|-------|-----------|--------|
| 0.1 | Mainnet tests: buy ~$30–50 of cirBTC (Uniswap v3), supply it on the Aave V4 Main Spoke, borrow $1 through `borrowOnBehalfOf` from a test contract | Hugo · H1 | Tue 11/17 morning | none (experiments) | — | Explorer links recorded, or fallback decided | ✅ passed on mainnet, no fallback needed (see results below) |
| 0.2 | Tests: Circle passkey wallet (MSCA) on Arc mainnet; timed USDC transfer Arc → Base (CCTP Fast Transfer or Gateway) | Enzo · E | Tue 11/17 morning | none (experiments) | — | Passkeys work or fall back to a regular wallet; Arc → Base delay measured | ✅ passed on testnet and mainnet (see results below) |
| 0.3 | Repository scaffold: `contracts/` (Foundry), `app/` (Next.js + viem), `keeper/` (Node); install, run and test commands in `CLAUDE.md` and the README | Enzo · E | Tue 11/17 afternoon | `chore/scaffold` | root, `contracts/`, `app/`, `keeper/` (skeletons) | `forge build` and `npm run dev` run; no `TBD` left in `CLAUDE.md` | ✅ |
| 0.4 | Frozen interfaces: `IVenue` (`rate`, `available`, `healthAfter`, `borrow`, `repay`), `IArdoise` (`pay`, `repay`, `lines`, `health`), `IGuard` (`checkMargin`, called by `pay()`), debt-line format, events | Hugo · H2 | Tue 11/17 afternoon | `feat/interfaces` | `contracts/src/interfaces/` | Merged into `main`; no change without telling the others first | ✅ see [`api.md`](api.md) |

### Blocking test results

**0.1 — cirBTC collateral and `borrowOnBehalfOf` (Hugo, Tue 11/17, Arc mainnet)**

Run from a dedicated project wallet with $4 of cirBTC instead of $30–50: a $1 borrow only needs a small position, and every step is the same.

| Test | Result | Evidence |
|------|--------|----------|
| Bridge 5 USDC Ethereum → Arc, CCTP fast transfer with Circle's forwarder (`depositForBurnWithHook`, domain 26) | Minted on Arc about 1 min after the burn, about 0.025 USDC in fees, no Arc gas needed by the recipient | [burn on Ethereum](https://etherscan.io/tx/0x8fc7e4021db32d2f1b20031cac3d1479f0b014e28e34123c90f60137372237a4), [mint on Arc](https://explorer.arc.io/tx/0x38ec3b153236379af508d028552de2cae2e6b7b7721121d77ec629f2888a1c17) |
| Buy cirBTC: 4 USDC → 6,271 sats on the Uniswap v3 cirBTC/USDC 0.01% pool | Works | [swap](https://explorer.arc.io/tx/0x850fb03b6beeaae8d254a0deca5fa8dc2e974df27b8f934acd66c3bb4c3ccbea) |
| Supply cirBTC on the Aave V4 Main Spoke (reserve 2) and enable it as collateral | Works | [supply](https://explorer.arc.io/tx/0xf90dccb8a05401477ce95b4db0d6cd91d7df2f9a3d0da316917a2cbc8698add2), [collateral](https://explorer.arc.io/tx/0x1eeb80c7833f3f1790412f231110cb54db0c27e42ee339f8d294bdcba2c65e73) |
| A test contract borrows 1 USDC (reserve 0) on the wallet's behalf through `TakerPositionManager.borrowOnBehalfOf` | Works: debt of 1.000001 USDC on the wallet, the contract forwarded the USDC to it; about 317k gas | [authorize Taker](https://explorer.arc.io/tx/0x04120fd8a4298a9a5eeb26a9b919c48342e3b03bf6e0e15d396aa1174b1c7e2c), [test contract](https://explorer.arc.io/address/0xf4f15c650e54f701eE2f817d6EdD6b170fa96bfC), [borrow allowance](https://explorer.arc.io/tx/0x01fbfef1b6a6e27338b16671be3312c46b7a986464a33a8d6426c510bd22d962), [borrow](https://explorer.arc.io/tx/0xb25dfd484be78b9c3f7d652975600f1283486ee2c591f2d9fb572d026c8d83ee) |

Decisions:
- **No fallback needed**: Ardoise borrows on Aave V4 on the user's behalf, and the collateral stays in the user's wallet.
- `borrowOnBehalfOf` lives on the `TakerPositionManager`, not on the Spoke, and repaying on someone's behalf goes through the `GiverPositionManager`. The user authorizes both once and gives the adapter a borrow allowance; the steps are in [`api.md`](api.md).
- CCTP fast transfer with the forwarder also works on mainnet towards Arc (domain 26), which supports the 0.2 decision.

**0.2 — passkeys and Arc → Base (Enzo, Tue 11/17, testnet then mainnet)**

| Test | Result | Evidence |
|------|--------|----------|
| Circle passkey wallet (MSCA) on Arc Testnet | Works. Account deployed and a user operation confirmed in 8.2 s, gas sponsored by Circle's paymaster (testnet client key, `@circle-fin/modular-wallets-core` 1.0.16) | [account](https://explorer.testnet.arc.io/address/0x8a75a1f7b15e42f60d85b2b7e5b1c8e4f8d9c86a), [transaction](https://explorer.testnet.arc.io/tx/0xec2834578819435f03ece68de41bb802f3e008a9768155e787a19037c0c511f8) |
| 1 USDC Arc Testnet → Base Sepolia, Circle Bridge Kit (`@circle-fin/bridge-kit` 1.17.2), CCTP fast transfer, `useForwarder: true` | Arrived. 6 s from the Arc block to the Base block, 12 s end to end including the wallet signature. About 0.053 USDC in fees; Circle's relayer submits the mint, so the recipient (here the same wallet) needs no gas on Base | Sent from the dedicated project test wallet, which MetaMask ran as an EIP-7702 delegated account (approve and burn in one transaction); A2 will call CCTP from a contract instead. [burn on Arc](https://explorer.testnet.arc.io/tx/0x56b6cfcddd62fced03a9efb4e192f561f1e1a0ff0de0c3504464c8fea0255988), [mint on Base](https://sepolia.basescan.org/tx/0x0cbd3d556f547f82ef27ab41a209a66e350792c79cae420e5cb101aafb1b77e8) |

Decisions:
- **Passkeys are kept**; no fallback to a regular wallet is needed.
- **Cross-chain payments use CCTP fast transfer with Circle's forwarder** (through Bridge Kit or the same contracts), not Gateway. This shapes `pay()` in A2 and the delivery tracking in C3.

Mainnet confirmation (same day, dedicated project wallet, real funds):

| Test | Result | Evidence |
|------|--------|----------|
| Circle passkey wallet (MSCA) on Arc mainnet | Works. Account deployed and 0.01 USDC sent in one user operation, confirmed in 7.9 s. No Gas Station policy: the account paid its own gas, about 0.038 USDC (0.106 USDC prefunded, of which the EntryPoint kept 0.068 as a deposit for later operations). A live client key needs billing details in the Circle Console (the pricing shown there lists wallets as free up to 1,000 active per month) and its own mainnet passkey domain | [account](https://explorer.arc.io/address/0x094aea4481b40686f3440cfce5088582d5ec5769), [transaction](https://explorer.arc.io/tx/0xd034bbb8791191441e395e6fa350b6e94d5024fd8f945333c6c031c72ac75233) |
| 1 USDC Arc → Base, Circle Bridge Kit, CCTP fast transfer, `useForwarder: true` | Arrived. 6 s from the Arc block to the Base block, 15 s end to end including the wallet signature. 0.053948 USDC in fees (0 protocol fee, forwarder fee only), 0.946052 USDC received. The app's payment page shows it correctly with `NEXT_PUBLIC_ARDOISE_NETWORK=mainnet` | [burn on Arc](https://explorer.arc.io/tx/0xff4d55ff4df9a858265d6edbdcacc5758fec353659e23f5e59d30d6342bbbe22), [mint on Base](https://basescan.org/tx/0x1b331fa52cac85b499fa68d856cbd952f72285908de7d19dd56da7b00b1d3778) |

The mainnet figures match the testnet ones, so the decisions above stand.

## Track A — On-chain core · Hugo, account H1

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| A1 | `AaveV4Adapter` (rate, liquidity, health after, borrow, repay) + tests | Wed 11/18 morning | 0.1, 0.3, 0.4 | `feat/aave-adapter` | `contracts/src/venues/AaveV4Adapter.sol`, tests | Tests pass; a real borrow of a few dollars on mainnet | ⬜ |
| A2 | `ArdoiseAccount`: `pay()` picks the venue, calls `IGuard.checkMargin`, borrows, sends (on Arc, or to another chain through CCTP fast transfer with Circle's forwarder, see the 0.2 results), enforces per-payment and daily caps, public `sweep()`; plus `ArdoiseFactory` (account registry, venue list, guard) | Wed 11/18 midday | A1, 0.2 | `feat/ardoise-account` | `contracts/src/ArdoiseAccount.sol`, `contracts/src/ArdoiseFactory.sol`, tests | `pay()` borrows and pays on mainnet | ⬜ |
| A3 | Debt ledger (amount, venue, rate, payee, memo, accrued interest) + events | Wed 11/18 afternoon | A2 | `feat/debt-ledger` | `contracts/src/` (ledger), tests | One line per payment, readable by the app | ⬜ |
| A4 | Mainnet deployment of the factory, venues and ledger (factory first, then adapters, then `setVenues`); addresses in `contracts/deployments.md` | Wed 11/18 evening | A3 | `chore/deploy-mainnet` | `contracts/script/`, `contracts/deployments.md` | Contracts verified on the Arc explorer | ⬜ |

## Track B — Position guard · Hugo, account H2

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| B1 | Margin check before each payment (refuse or reduce below the threshold), implementing `IGuard` | Wed 11/18 morning | 0.3, 0.4 | `feat/margin-check` | `contracts/src/guard/`, tests | A payment over the threshold is refused in tests | ✅ `MarginGuard`, minimum 1.25 and target 1.5 suggested at deployment |
| B2 | Keeper that can only repay: it watches accounts (`AccountCreated`) and calls the public `IArdoise.sweep()` implemented in A2 (a plain USDC `transfer()` runs no recipient code) | Wed 11/18 afternoon | B1, A2 | `feat/keeper` | `keeper/` | Debt goes down after a keeper-triggered repayment | ⬜ |
| B3 | Bitcoin price-drop simulator, labelled as a simulation (no local Arc fork: native USDC breaks there) | Thu 11/19 morning | B1, B2 | `feat/price-sim` | `contracts/src/guard/` or `keeper/` | The "BTC drops → payment refused → repayment" demo runs | ⬜ |
| B5 | Mainnet deployment of the guard; keeper running against mainnet; guard address in `contracts/deployments.md` (coordinate with H1) | Wed 11/18 evening | B2, A4 | `chore/deploy-guard` | `contracts/script/` (guard script only), `keeper/` config | `pay()` on mainnet calls the deployed guard | ⬜ |
| B4 | (if time allows) deleveraging from a Gateway balance; otherwise a one-click user repayment | Thu 11/19 | B2 | `feat/gateway-deleverage` | `keeper/` | Repayment funded from Base, or fallback agreed | ⬜ |

## Track C — What the judges see · Enzo, account E

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| C1 | Pay screen + destination chain picker (Arc or Base, moved from C3) + Aave / Morpho rate comparison (real reads) + margin gauge, on mock contracts | Wed 11/18 morning | 0.3, 0.4 | `feat/pay-screen` | `app/` (pay screen) | The flow can be clicked end to end with mocks | ✅ simulated account in the browser, live Aave V4 / Morpho rates from Arc mainnet, CCTP fee from Circle |
| C2 | Line-by-line statement | Wed 11/18 afternoon | 0.3, 0.4 | `feat/statement` | `app/` (statement) | Lines render from contract events | ✅ decoded from `Paid` / `LineRepaid` logs with the `IArdoise` ABI; the simulated account emits the same encoded logs until C4 |
| C3 | Delivery tracking on Base (explorer link, arrival status); the sending itself happens in `pay()` (A2) | Wed 11/18 evening | 0.2, 0.3 | `feat/crosschain-send` | `app/` only | The app shows a payment arriving on Base | ✅ payment page `/payments/[txHash]`, checked with the 0.2 testnet transfer |
| C4 | Wire the app to the real mainnet contracts (addresses from `contracts/deployments.md`) | Thu 11/19 morning | A4, B5, C1–C3 | `feat/wire-contracts` | `app/` (config, calls) | A real payment from the app, line visible in the statement | ⬜ |

## Assembly and submission

| # | Task | Who | When | Depends on | Done when | Status |
|---|------|-----|------|------------|-----------|--------|
| R1 | Rehearse the full demo path (pay on Base, statement, guard) | Enzo + Hugo | Thu 11/19 midday | C4, B3 | Three clean runs in a row | ⬜ |
| R2 | README: problem, solution, How it works (Mermaid), Built with Circle and Arc (with file links), Economic design and risk assumptions, contract addresses (from `contracts/deployments.md`), 2-minute test; branch `docs/readme` | Enzo · E | Thu 11/19 afternoon | R1 | A newcomer understands and tests it in under 2 minutes | ⬜ |
| R3 | 2–3 min video (a real payment in the first 30 seconds) + backup video for the final | Enzo · E | Thu 11/19 evening | R1 | Video online, linked from the README | ⬜ |
| R4 | Devpost text (criterion → evidence mapping) | Enzo · E | Thu 11/19 evening | R2 | Draft ready on Devpost | ⬜ |
| R5 | Extras only if everything else works: EURC borrowing on Morpho, real Morpho borrowing, QuickNode Streams | Hugo · H1/H2 | Thu 11/19 afternoon | R1 | Only after R1 | ⬜ |
| R6 | Pre-submission audit | Enzo · E | Fri 11/20, start of crunch | R2–R4 | Blocking issues fixed | ⬜ |

## Crunch mode (from Fri 11/20 00:00 CST)

- Only fixes to the demo path and the deliverables, on `hotfix/...` branches, with a quick review.
- Merge freeze at 11:30 CST; submission at 12:00 CST.

## Parallel-work rules

- **One track = one Claude account = its own folders.** Track A: `contracts/src/` except `guard/`, `contracts/script/`, `contracts/deployments.md`. Track B: `contracts/src/guard/`, `keeper/`, its own guard deployment script. Track C: `app/`. The README belongs to Enzo. Two tracks never edit the same file.
- **Tasks without a branch** (R1, R3, R4, R6) change nothing in the repository; R5 extras each get their own `feat/...` branch.
- **Single contact point:** the interfaces (`IVenue`, `IArdoise`, `IGuard`) and debt-line format frozen in 0.4. Changing them means telling the others first.
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
