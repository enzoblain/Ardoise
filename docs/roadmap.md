# Roadmap

Who builds what, and when, until the UBC Hackathon 2026 submission. Every agent picks its task here and works only on it.

Last updated: 2026-11-19. All times are **CST (Austin, UTC-6)**; Paris is CST + 7 h.
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
| A1 | `AaveV4Adapter` (rate, liquidity, health after, borrow, repay) + tests | Wed 11/18 morning | 0.1, 0.3, 0.4 | `feat/aave-adapter` | `contracts/src/venues/AaveV4Adapter.sol`, tests | Tests pass; a real borrow of a few dollars on mainnet | ✅ 30 unit tests; 1 USDC borrowed and repaid on mainnet through the adapter ([borrow](https://explorer.arc.io/tx/0xd1f4a2dfc6ceb598eea1b26ee708cf555726a2ec7e27e8e1bbd81b6fd274a8d8), [repay](https://explorer.arc.io/tx/0x23c6fac99298df1cc4d63e75435d06efcdd5422222bdd72778056ed1eb9e4b51)) |
| A2 | `ArdoiseAccount`: `pay()` picks the venue, calls `IGuard.checkMargin`, borrows, sends (on Arc, or to another chain through CCTP fast transfer with Circle's forwarder, see the 0.2 results), enforces per-payment and daily caps, public `sweep()`; plus `ArdoiseFactory` (account registry, venue list, guard) | Wed 11/18 midday | A1, 0.2 | `feat/ardoise-account` | `contracts/src/ArdoiseAccount.sol`, `contracts/src/ArdoiseFactory.sol`, tests | `pay()` borrows and pays on mainnet | ✅ 109 contract tests; on mainnet a test deployment paid 0.50 USDC on Arc ([pay](https://explorer.arc.io/tx/0x9bdf57e2259edd1e5af9ebca7167c4a7c21019249e470c955f010993e606a1a0)), repaid it ([repay](https://explorer.arc.io/tx/0x760325e259f3517df376302a65c660c005922c0bede99fa567329829fef7ed89)) and paid 1 USDC to Base, minted 6 s later by the forwarder ([pay](https://explorer.arc.io/tx/0x6b0484d21b5c23e38826252a3d02cdf335dafede7df32f2f42dfd64cf95066e5), [mint on Base](https://basescan.org/tx/0x39c247e90f5e45abb253be5b9c2477b325d740a5c6ac6856984985c26088ad67)) |
| A3 | Debt ledger (amount, venue, rate, payee, memo, accrued interest) + events | Wed 11/18 afternoon | A2 | `feat/debt-ledger` | `contracts/src/` (ledger), tests | One line per payment, readable by the app | ✅ built in A2: `IArdoise` requires the ledger, so `lines()`, `line()`, `Paid` and `LineRepaid` ship with the account |
| A4 | Mainnet deployment of the factory, venues and ledger (factory first, then adapters, then `setVenues`); addresses in `contracts/deployments.md` | Wed 11/18 evening | A3 | `chore/deploy-mainnet` | `contracts/script/`, `contracts/deployments.md` | Contracts verified on the Arc explorer | ✅ factory and Aave V4 adapter on Arc mainnet, sources verified on Sourcify (the Blockscout API is behind a Cloudflare challenge); addresses in [`contracts/deployments.md`](../contracts/deployments.md); the guard follows in B5 |

## Track B — Position guard · Hugo, account H2

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| B1 | Margin check before each payment (refuse or reduce below the threshold), implementing `IGuard` | Wed 11/18 morning | 0.3, 0.4 | `feat/margin-check` | `contracts/src/guard/`, tests | A payment over the threshold is refused in tests | ✅ `MarginGuard`, minimum 1.25 and target 1.5 suggested at deployment |
| B2 | Keeper that can only repay: it watches accounts (`AccountCreated`) and calls the public `IArdoise.sweep()` implemented in A2 (a plain USDC `transfer()` runs no recipient code) | Wed 11/18 afternoon | B1, A2 | `feat/keeper` | `keeper/` | Debt goes down after a keeper-triggered repayment | ✅ keeper running on Arc mainnet from its own wallet `0xfA1F…5541`: 3 blocks after a plain 0.10 USDC transfer to the demo account ([transfer](https://explorer.arc.io/tx/0x578f203c3bdc3ea4b11c4d9c1862cd7b24627b28f00e71eb7e35d118c1402466)), the keeper called `sweep()`, which repaid 0.10 USDC against debt line #1 ([sweep](https://explorer.arc.io/tx/0xe68ac63117e4ad5fee25fa63c8f7b70927dcdcca9b283f8201b2490247cf929a), `LineRepaid`); the owner's Aave USDC debt (`Spoke.getUserTotalDebt`) went from 1.515319 to 1.415319 |
| B3 | Bitcoin price-drop simulator, labelled as a simulation (no local Arc fork: native USDC breaks there) | Thu 11/19 morning | B1, B2 | `feat/price-sim` | `contracts/src/guard/` or `keeper/` | The "BTC drops → payment refused → repayment" demo runs | ✅ `MarginGuard.setSimulatedDrop` and the keeper (see [`api.md`](api.md)), run on Arc mainnet on 2026-11-18: with a 55% simulated drop the guard refused a 0.20 USDC payment ([refused pay](https://explorer.arc.io/tx/0x433455e25f1b9c35da979a996f9d798270a41ae353a00e63a48c568ef3c51fa9)), then the keeper drew 0.40 USDC from the owner's Gateway reserve on Base ([mint on Arc](https://explorer.arc.io/tx/0x39ef15e9635ef1500b2690bc2b452e6cab6d0b1ff32f81b153692ffd8cef6253)) and repaid it ([sweep](https://explorer.arc.io/tx/0x420afd89cbf7f80882be56c1b4f2328e7068a75421d2876d15a113a3a6a0da24)), 17 s after it first read the simulated health factor; details in [`deployments.md`](../contracts/deployments.md#state) |
| B5 | Mainnet deployment of the guard; keeper running against mainnet; guard address in `contracts/deployments.md` (coordinate with H1) | Wed 11/18 evening | B2, A4 | `chore/deploy-guard` | `contracts/script/` (guard script only), `keeper/` config | `pay()` on mainnet calls the deployed guard | ✅ guard deployed with Enzo's `script/DeployGuard.s.sol` and set on the factory ([`0xEBAC…f080`](https://explorer.arc.io/address/0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080)); the first `pay()` went through it from the app ([pay on Arc](https://explorer.arc.io/tx/0x9dfdd3d8ba60968a8feaed312edd03ad8c238850e89ec3af05cb3aa8b5836aed)); keeper running on mainnet and documented in [`deployments.md`](../contracts/deployments.md#keeper) |
| B4 | (if time allows) deleveraging from a Gateway balance; otherwise a one-click user repayment. Taken by Enzo · E with Hugo's agreement: keeper part (standing orders) first, app part (deposit, signing, one-click repayment) after C4 | Thu 11/19 | B2 | `feat/gateway-deleverage` | `keeper/`, then `app/` | Repayment funded from Base, or fallback agreed | ✅ automatic and manual paths run on Arc mainnet on 2026-11-18 (see [`deployments.md`](../contracts/deployments.md#state)). Manual: from the Protection panel the demo wallet deposited 1 USDC into Gateway on Base, signed two 0.40 USDC standing orders and repaid 0.15 USDC from Base in one click ([mint on Arc](https://explorer.arc.io/tx/0x66530e482f4f1b2d1bffe4105050438ef2d944eee09fc9aae54d8b341ba7dce0)); the keeper swept it 5 s later, debt 1.415 → 1.265 USDC ([#25](https://github.com/enzoblain/Ardoise/pull/25)). Automatic: in the B3 run the keeper drew 0.40 USDC from that reserve and repaid it 17 s after reading the simulated health factor ([#40](https://github.com/enzoblain/Ardoise/pull/40)). [#41](https://github.com/enzoblain/Ardoise/pull/41) signs one-click repayments with twice the default fee margin and re-reads the Gateway balance before sending. Testnet first run: a 2 USDC standing order minted on Arc Testnet 6.7 s after submission ([mint](https://explorer.testnet.arc.io/tx/0x265e5554b7e58d5da6a0dd0197015e17c40a943706e34695d9968941424a8f54)) |

## Track C — What the judges see · Enzo, account E

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| C1 | Pay screen + destination chain picker (Arc or Base, moved from C3) + Aave / Morpho rate comparison (real reads) + margin gauge, on mock contracts | Wed 11/18 morning | 0.3, 0.4 | `feat/pay-screen` | `app/` (pay screen) | The flow can be clicked end to end with mocks | ✅ simulated account in the browser, live Aave V4 / Morpho rates from Arc mainnet, CCTP fee from Circle |
| C2 | Line-by-line statement | Wed 11/18 afternoon | 0.3, 0.4 | `feat/statement` | `app/` (statement) | Lines render from contract events | ✅ decoded from `Paid` / `LineRepaid` logs with the `IArdoise` ABI; the simulated account emits the same encoded logs until C4 |
| C3 | Delivery tracking on Base (explorer link, arrival status); the sending itself happens in `pay()` (A2) | Wed 11/18 evening | 0.2, 0.3 | `feat/crosschain-send` | `app/` only | The app shows a payment arriving on Base | ✅ payment page `/payments/[txHash]`, checked with the 0.2 testnet transfer |
| C4 | Wire the app to the real mainnet contracts (addresses from `contracts/deployments.md`) | Thu 11/19 morning | A4, B5, C1–C3 | `feat/wire-contracts` | `app/` (config, calls) | A real payment from the app, line visible in the statement | ✅ a real payment from the app on 2026-11-18: 0.40 USDC to Base, 0.45523 USDC borrowed on Aave V4 (CCTP fee included) through the guard ([pay](https://explorer.arc.io/tx/0x9dfdd3d8ba60968a8feaed312edd03ad8c238850e89ec3af05cb3aa8b5836aed), [mint on Base](https://basescan.org/tx/0x80d15046477b5332f3c55150b82dfeba38dbb97e15af9e70d792ffa266408a4b)); its debt line #1 and `Paid` event are on chain for the statement (see [`deployments.md`](../contracts/deployments.md)) |
| C5 | Logo and brand assets, wired into the app (favicon, header) and the README | Wed 11/18 | — | `feat/logo` | `assets/logo/`, `app/` (icon, header), README | The logo shows in the app tab, the app header and the README | ✅ made with the logo-designer skill: a slate with ledger lines in chalk, the current payment in bitcoin orange; 7 SVGs and a brand reference page in `assets/logo/` |
| C6 | Landing page on `/` (3D slate hero, live rates, how it works, link to the app), app moved to `/app` | Wed 11/18 | C5, R7 | `feat/landing-page` | `app/` (landing, routes), README | The live link opens the landing page and its button opens the app | ✅ landing on `/` with a CSS 3D slate (no new dependency, still under reduced motion), live rates from Arc mainnet; the app moved to `/app`; redesigned in [#66](https://github.com/enzoblain/Ardoise/pull/66): a scroll-driven intro (ring of collateral vaults, borrowing, paying, protection) before the main page, whose buttons connect a wallet and open the position |
| C7 | Visual pass on the app (`/app`, payment page): the landing page's dark theme and palette, two-column layout, cards; no logic change | Wed 11/18 | C6 | `feat/app-design` | `app/` (styles, components) | The app matches the landing page on desktop and mobile, every state still works | ✅ one dark theme in the logo's palette with shared card, field and button styles, two columns on desktop; checked on the demo flow, the receipt, the delivery page and mobile |
| C8 | Circle passkey wallets in the app: sign in with a passkey (Circle smart account), activation in one signature (supply cirBTC, collateral, position managers, account, allowance in one user operation), payments as user operations; browser wallets unchanged | Wed 11/18 | 0.2, C4 | `feat/passkey-wallet` | `app/` (wallet, setup, account screens) | A passkey account activates and pays on Arc mainnet from the deployed app | ✅ payment: a passkey account paid from the deployed app on Arc mainnet on 2026-11-20 ([Arc](https://explorer.arc.io/tx/0x73f17cba212629515f8aacf66be6e0e80f6b51dd982fb289f62991931e3cd104), [Base](https://basescan.org/tx/0xb3dcab1b490bbc929a43746e9f8a3a26306e2c97cb0d7897071e94aeccee781d)), after the fix in #87; the activation on mainnet was not recorded |
| C9 | Gateway protection for passkey accounts: the same smart account on Base deposits in one user operation and signs standing orders through ERC-1271 (`contractSigner`); the keeper intake flags such orders from the chain | Wed 11/18 | C8, B4 | `feat/passkey-protection` | `app/` (Protection panel, Gateway signer), `keeper/` (intake) | A passkey account deposits on Base and repays from its Gateway reserve on mainnet | 🔄 built and unit-tested (app and keeper); the mainnet run follows the C8 one |
| C10 | Stress test and reserve breakdown (Hugo's P1 ideas, read only): a scenario (BTC and ETH drops) gives the health factor curve with and without Ardoise, the reserve drawn in order, survival and the liquidation penalty avoided; the reserve asset by asset (asset, chain, value, crisis haircut, defense value, weight, priority) and the bitcoin drop it covers | Thu 11/19 | C4, B4 | `feat/stress-test` | `app/` (stress model, reserve reads, panel) | Shown on the demo account (simulated reserve) and on a live account (reserve read on chain), counting only what the keeper can draw | ✅ model unit-tested (10 tests) and checked in the browser on the demo account; run with the app's own code on the live demo account on 2026-11-19, as the deployed app reads it (no keeper URL on Vercel, so the whole Gateway balance counts as the owner's). Aave V4: 3.93 USD of cirBTC, 0.865 USD of debt, health factor 3.55; the 78% collateral factor and the health factors at each preset match a hand calculation (1.42 at BTC −60%). Displayed: the keeper alone covers down to −71%; with the owner's 0.399 USDC in Gateway and 1.11 USD of ETH, −85% under the BTC −60% / ETH −70% preset (−84% under the default one) |
| C11 | Native iOS app (SwiftUI, Circle Modular Wallets iOS SDK): passkey sign-in with the web app's passkey (associated domain), pay with the venue picker (`payVia`, Circle fee for Base), statement, positions and caps, and the activation of a passkey account in one signature (checklist of the funding steps, address with a copy button); protection and stress test stay on the web | Thu 11/19 | C8, R5 | `feat/ios-app` | `ios/`, `app/public/.well-known/` | The app signs in with a passkey and pays on Arc mainnet | 🔄 merged (#64) and the site now serves `apple-app-site-association` (production deploy of 9d5597e). In the simulator (iPhone 17 Pro, iOS 27) Circle accepts the iOS client key and iOS verifies the association: the system passkey sheet opens. Left: sign in with a real passkey, activate an account from the app (none in the simulator; the sheet offers a phone's passkey through the QR code, not tried yet) and a mainnet payment from the app. The TestFlight workflow uploaded builds 101 and 102; the pay screen now has a review sheet before signing and errors as notifications. The unit tests build, but Xcode 27 beta's test runner cannot attach to the simulator |

## Track D — CCTP-attested defense · Hugo

When a position is under the guard's minimum and the Gateway standing orders cannot cover it, a message attested by Circle (CCTP V2 generic messaging) goes from Arc to Base; only that message lets a contract on Base spend the owner's pre-authorized funds there and burn USDC back to the owner's Ardoise account.

| # | Task | When | Depends on | Branch | Files | Done when | Status |
|---|------|------|------------|--------|-------|-----------|--------|
| D1 | Defense contracts (Hugo · H1): `DefenseAlarm` on Arc (checks the minimum health factor on chain and sends the message; since #62 it reads the venue's real health factor, the simulated one only on a demo pair; the first pairs deployed followed the guard's simulated drop), `DefenseExecutor` on Base (accepts only the finalized message from the alarm, pulls the owner's USDC then WETH within their policy, swaps against a Chainlink bound, burns to the owner's account), deploy scripts | Thu 11/19 | B3, B4 | `feat/cctp-defense` | `contracts/src/defense/`, `contracts/src/cctp/`, `contracts/script/DeployDefense.s.sol`, tests, `docs/api.md` | Tests pass, including a Base fork test; a real alarm on mainnet ends in a mint on the demo account | ✅ deployed and proven on mainnet on 2026-11-19: a real alarm on Arc, relayed to Base, swapped WETH and minted 0.253 USDC on the demo account in 26 s (links in `contracts/deployments.md`); after [#48](https://github.com/enzoblain/Ardoise/pull/48), [#50](https://github.com/enzoblain/Ardoise/pull/50). Security fix in [#62](https://github.com/enzoblain/Ardoise/pull/62): the alarm pins its venues, thresholds and health source at construction; redeployed on 2026-11-19 with the other security fixes (#58 to #63) on a new factory, as a production pair and a demo pair that honors the simulated drop; the keeper relays the demo pair, and the demo wallet's policies on the earlier executors were cleared |
| D2 | Keeper relay (Hugo · H2): after the sweep and the Gateway standing orders, raise the alarm, wait for Circle's attestation, relay it to Base; a `TooSoon(owner, nextAllowed)` revert on Base means retry at `nextAllowed` while the alarm is valid, and a `PositionHealthy` revert on `raise` means call `sweep()` (see *CCTP-attested defense* in `docs/api.md`) | Thu 11/19 | D1 | `feat/keeper-defense-relay` | `keeper/`, `.env.example`, `contracts/deployments.md` (keeper section) | Keeper tests pass; the keeper relays a real alarm on mainnet | ✅ keeper relay built and tested ([#46](https://github.com/enzoblain/Ardoise/pull/46)); on mainnet on 2026-11-19 the keeper alone drew the Gateway order, raised the alarm, relayed Circle's attestation to Base and swept the mint: 15 s from `raise` to the repayment ([deployments](../contracts/deployments.md)) |

## Assembly and submission

| # | Task | Who | When | Depends on | Done when | Status |
|---|------|-----|------|------------|-----------|--------|
| R1 | Rehearse the full demo path (pay on Base, statement, guard) | Enzo + Hugo | Thu 11/19 midday | C4, B3 | Three clean runs in a row | ✅ rehearsed by Enzo and Hugo (reported on 2026-11-19) |
| R2 | README: problem, solution, How it works (Mermaid), Built with Circle and Arc (with file links), Economic design and risk assumptions, contract addresses (from `contracts/deployments.md`), 2-minute test; branch `docs/readme` | Enzo · E | Thu 11/19 afternoon | R1 | A newcomer understands and tests it in under 2 minutes | ✅ written before R1 (branch `docs/readme`): demo transactions, How it works (Mermaid), Built with Circle and Arc, Economic design and risk assumptions, deployed contracts, Borrow Kit comparison, 2-minute test checked on a clean clone without `.env`; the live app and video links come with R3 and the deployment |
| R3 | 2–3 min video (a real payment in the first 30 seconds) + backup video for the final | Enzo · E | Thu 11/19 evening | R1 | Video online, linked from the README | ⬜ |
| R4 | Devpost text (criterion → evidence mapping) | Enzo · E | Thu 11/19 evening | R2 | Draft ready on Devpost | ⬜ |
| R5 | Extras only if everything else works: EURC borrowing on Morpho, real Morpho borrowing, QuickNode Streams. Real Morpho borrowing taken by Enzo · E (option 3: `MorphoAdapter`, and `bestVenue` that skips venues the guard refuses, on a new factory) | Enzo · E (was Hugo · H1/H2) | Thu 11/19 afternoon | R1 | Only after R1 | ✅ Morpho borrowing merged (#39) and live on Arc mainnet: new factory with the Aave V4 and Morpho adapters, `payVia` so the user picks the venue (the app recommends the cheapest the guard allows), `sweep()` that repays the venue closest to liquidation first; one 0.10 USDC payment through each venue from the demo account (see [`deployments.md`](../contracts/deployments.md)). EURC and QuickNode Streams not done |
| R6 | Pre-submission audit | Enzo · E | Fri 11/20, start of crunch | R2–R4 | Blocking issues fixed | ⬜ |
| R7 | Deploy the app on Vercel (root `app/`, `NEXT_PUBLIC_ARDOISE_NETWORK=mainnet`), so judges can try the demo account from a link; put the link in the README | Enzo · E | Wed 11/18 | C4, R2 | The live link opens the demo account with live mainnet rates, from a browser without wallet | ✅ https://ardoise-rust.vercel.app (mainnet, no secret), checked from a browser without wallet |
| R8 | Share the app's Arc reads between visitors: server-side account history (`/api/account-events`, incremental), cached venue rates and block, RPC fallback to Blockdaemon's public endpoint | Enzo · E | Wed 11/18 | R7 | Several judges can open the app at once without the public RPC refusing reads | ✅ on mainnet the demo account's history is read in 1.2 s, then 4 ms; `/app` renders in 7 ms once cached. The default Arc RPC refused the browser's log scan after 3 calls ("rate limit exceeded"); Blockdaemon's endpoint scanned it in 0.7 s |

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
