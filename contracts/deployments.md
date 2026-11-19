# Deployments

Addresses of the Ardoise contracts. The app (C4) and the keeper (B2) read them from here.

## Arc mainnet (chain id 5042)

### Current: factory with the Morpho venue (PR #39)

Deployed on 2026-11-19 from the `feat/morpho-venue` branch ([PR #39](https://github.com/enzoblain/Ardoise/pull/39), main merged in) with [`script/Deploy.s.sol`](script/Deploy.s.sol) and `ARDOISE_GUARD` set to the existing guard, in block [31976642](https://explorer.arc.io/block/31976642), by the project wallet (factory admin). Same constructor arguments as below (caps 10 / 20 USDC, finality 2000); the factory lists two venues, Aave V4 then Morpho, and accounts created here have `payVia(venue, …)`. Accounts of the previous factory keep working but are not the ones the app and the keeper read. Gas: 0.162 USDC.

| Contract | Address | Source verification |
|----------|---------|---------------------|
| `ArdoiseFactory` | [`0xB4476B617B750B9f48786c60930bc499343BB4a8`](https://explorer.arc.io/address/0xB4476B617B750B9f48786c60930bc499343BB4a8) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0xB4476B617B750B9f48786c60930bc499343BB4a8) |
| `AaveV4Adapter` (USDC on the Aave V4 Main Spoke, reserve 0) | [`0xCB907D5E3bb0dd01aE564aA38ef4Fce089F3e18F`](https://explorer.arc.io/address/0xCB907D5E3bb0dd01aE564aA38ef4Fce089F3e18F) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0xCB907D5E3bb0dd01aE564aA38ef4Fce089F3e18F) |
| `MorphoAdapter` (cirBTC/USDC market `0xc2db905f…5815d` on Morpho `0x34CD0407…7fCD`) | [`0x48BbdF2Fda17FC197909C82dE1d95242659e80a5`](https://explorer.arc.io/address/0x48BbdF2Fda17FC197909C82dE1d95242659e80a5) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0x48BbdF2Fda17FC197909C82dE1d95242659e80a5) |
| `MarginGuard` (unchanged, see below) | [`0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080`](https://explorer.arc.io/address/0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080) |

| Transaction | Hash |
|-------------|------|
| Deploy `ArdoiseFactory` | [`0x1ebcb728…`](https://explorer.arc.io/tx/0x1ebcb728121f0f79202693b4e1866cf26139959de02a16e95fa3c555fcbdd790) |
| Deploy `AaveV4Adapter` | [`0xdde0b791…`](https://explorer.arc.io/tx/0xdde0b7910bc570b6578a6f0aaa6fdcaaacffd71c3c8ae9fb857ef92c8a0999e9) |
| Deploy `MorphoAdapter` | [`0x133b159a…`](https://explorer.arc.io/tx/0x133b159a578adf10e2a86acd199bfa4ce0a07c8a64cc6f806cb26ad788008321) |
| `setVenues([AaveV4Adapter, MorphoAdapter])` | [`0x44bd18ba…`](https://explorer.arc.io/tx/0x44bd18ba4a63d6e5e40a6ca63dd22563f2eb7eb4e0bd1e68f0c41903c0a637e7) |
| `setGuard(MarginGuard)` | [`0xb705a9ae…`](https://explorer.arc.io/tx/0xb705a9aeda83d35a55519029672efcf40136d8350b0dbaa8a9731f228a0cad13) |

Checked after mining: `factory.venues()` returns both adapters in that order and `factory.guard()` returns the guard. `MorphoAdapter(factory, morpho, marketId)` was verified with constructor arguments `(0xB4476B61…B4a8, 0x34CD04070dD72b14E241112F6d83812Df5Af7fCD, 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d)`. The broadcast is in [`broadcast/Deploy.s.sol/5042/run-latest.json`](broadcast/Deploy.s.sol/5042/run-latest.json).

**Demo wallet on this factory.** The project wallet's account is [`0x4d298b39F3676B07335206E7b7F042D51e787a49`](https://explorer.arc.io/address/0x4d298b39F3676B07335206E7b7F042D51e787a49). Its Aave V4 position (cirBTC collateral, earlier debt) is the same one the previous account borrowed against: the position belongs to the owner, not to the account. Setup on 2026-11-19: `createAccount()` [`0x6ed86354…`](https://explorer.arc.io/tx/0x6ed863546fd9069646476d1f30878b05e6f1337bb0816d764f5894b88195365f); `approveBorrow(MainSpoke, 0, AaveV4Adapter, 60 USDC)` [`0x74c9bf1e…`](https://explorer.arc.io/tx/0x74c9bf1ef5bfc875121b32597a190b7578b751f52f1752d8de4d82654b0c7816); 2,500 sats of cirBTC withdrawn from Aave V4 [`0x36c8b626…`](https://explorer.arc.io/tx/0x36c8b6264a33385a0e5ff54822a319c84938901d7ffe0903dcf872f26628233b), approved [`0xb8e89faf…`](https://explorer.arc.io/tx/0xb8e89faf330a20d41bd0eccfe201d3f03c74abc4f34c0d3f4d2104a3c64d5535) and supplied as collateral on Morpho [`0x0c56da58…`](https://explorer.arc.io/tx/0x0c56da5808227e97e33f1720293714269148d327ab38b9807d52d856e98c25e2); `Morpho.setAuthorization(MorphoAdapter, true)` [`0xa37ebe5b…`](https://explorer.arc.io/tx/0xa37ebe5b6883fe699904dd90ef0921ef995e366d2342e3e266e10d49a8948c8f).

**`payVia` on mainnet.** With Aave V4 at 3.11% and Morpho at 4.04%, `bestVenue(0.10 USDC)` returns the Aave V4 adapter. Two payments of 0.10 USDC on Arc to the owner, one per venue: `payVia(AaveV4Adapter, …)` opened line #1 [`0xd644175e…`](https://explorer.arc.io/tx/0xd644175e6ff3de535a4db46248ffbdd8dbf0eec4ac88aaaf0f26dddcffe7e1aa) (Aave V4 health factor 3.009 → 2.586), `payVia(MorphoAdapter, …)` opened line #2 [`0x22c73905…`](https://explorer.arc.io/tx/0x22c7390583ce2d2d66c9a594775bdc9af4e5c654c2840e4fcd1daf5af682ca14) on the venue that is not the cheapest (Morpho debt 0.100001 USDC, health factor 13.47).

The defense alarm reads its factory as an immutable: an alarm deployed against the previous factory does not see accounts of this one, so the defense must be deployed against this factory.

The Gateway standing orders recorded in the B3 run were signed for the previous account (`0xdcB201E7…`), and the keeper only submits an order whose recipient is the account it defends. The automatic Gateway repayment therefore needs new standing orders signed for `0x4d298b39…` before it can run again on this factory.

### Previous factory (Aave V4 only)

Deployed on 2026-11-17 from commit [`37d9fe4`](https://github.com/enzoblain/Ardoise/commit/37d9fe4) (branch `chore/deploy-mainnet`, [PR #14](https://github.com/enzoblain/Ardoise/pull/14)) with [`script/Deploy.s.sol`](script/Deploy.s.sol), in block [31777009](https://explorer.arc.io/block/31777009). Deployer and factory admin: the dedicated project wallet [`0x54e1714a0ffae58d3AA227C80FD48668e11f18d7`](https://explorer.arc.io/address/0x54e1714a0ffae58d3AA227C80FD48668e11f18d7).

| Contract | Address | Source verification |
|----------|---------|---------------------|
| `ArdoiseFactory` | [`0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD`](https://explorer.arc.io/address/0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD) |
| `AaveV4Adapter` (USDC on the Aave V4 Main Spoke) | [`0x38B564d0b3d57216A34d83FbF08DE48744567b38`](https://explorer.arc.io/address/0x38B564d0b3d57216A34d83FbF08DE48744567b38) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0x38B564d0b3d57216A34d83FbF08DE48744567b38) |
| `MarginGuard` (min health factor 1.25, target 1.5, owner = admin) | [`0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080`](https://explorer.arc.io/address/0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080) |

The guard was deployed on 2026-11-18 with [`script/DeployGuard.s.sol`](script/DeployGuard.s.sol) (task B5, [PR #18](https://github.com/enzoblain/Ardoise/pull/18)) from commit [`b2c0f55`](https://github.com/enzoblain/Ardoise/commit/b2c0f55), in block [31848228](https://explorer.arc.io/block/31848228), by the factory admin: [deploy `MarginGuard`](https://explorer.arc.io/tx/0xe06eb6271c82a06ceebddbd00e0b1c936442e0f25992dc0b42df0ed44c2c1dd0), [`factory.setGuard`](https://explorer.arc.io/tx/0x33621a5269aaf01dca0883563259adeacafebf8eae5134f9ca77175c91a1a92f). Checked after mining: `factory.guard()` returns the guard, `factory.venues()` is unchanged, the guard's owner is the admin, thresholds are 1.25e18 / 1.5e18 and `simulatedDropBps()` is 0.

Accounts (`ArdoiseAccount`) are deployed by the factory through `createAccount()`; find one with `accountOf(owner)` or the `AccountCreated` event.

| Transaction | Hash |
|-------------|------|
| Deploy `ArdoiseFactory` | [`0x21e810b0…`](https://explorer.arc.io/tx/0x21e810b0c6893ee05509a33e1264d202c5653cf423e051da0806232ba9f1d12b) |
| Deploy `AaveV4Adapter` | [`0x21965436…`](https://explorer.arc.io/tx/0x21965436377db88b621f763b972da0b2fc3d7bb04fea2b7b7f9882e42698ad17) |
| `setVenues([AaveV4Adapter])` | [`0x5ad5c9d7…`](https://explorer.arc.io/tx/0x5ad5c9d74fed75250c2a7f062a27b16c10057214505e0622e319b3782744eddb) |

The full broadcast is in [`broadcast/Deploy.s.sol/5042/run-latest.json` at commit `37d9fe4`](https://github.com/enzoblain/Ardoise/blob/37d9fe4/contracts/broadcast/Deploy.s.sol/5042/run-latest.json) (the current file holds the Morpho factory's broadcast).

### Constructor arguments

`ArdoiseFactory(admin, usdc, tokenMessenger, minFinalityThreshold, defaultPerPaymentCap, defaultDailyCap)`:

| Argument | Value |
|----------|-------|
| `admin` | `0x54e1714a0ffae58d3AA227C80FD48668e11f18d7` |
| `usdc` | `0x3600000000000000000000000000000000000000` (USDC, 6 decimals) |
| `tokenMessenger` | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` (CCTP V2 TokenMessenger) |
| `minFinalityThreshold` | `2000` (standard finality, attested in about 0.5 s from Arc) |
| `defaultPerPaymentCap` | `10000000` (10 USDC) |
| `defaultDailyCap` | `20000000` (20 USDC) |

`AaveV4Adapter(factory, spoke, taker, giver, reserveId)`:

| Argument | Value |
|----------|-------|
| `factory` | `0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD` |
| `spoke` | `0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d` (Aave V4 Main Spoke) |
| `taker` | `0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF` (TakerPositionManager) |
| `giver` | `0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1` (GiverPositionManager) |
| `reserveId` | `0` (USDC) |

### State after deployment

Read on chain right after the deployment: `factory.venues()` = `[AaveV4Adapter]`, `factory.guard()` = zero address, `adapter.rate()` = 310 bps, `adapter.available()` = 26.32M USDC (the Main Spoke draw cap is the binding limit).

> [!NOTE]
> **Payments are live on mainnet since 2026-11-18**: the guard is set, the first payment is recorded below and the keeper runs against mainnet (see *Keeper*). The simulated price-drop demo (B3) and both Gateway repayment paths from Base (B4) are recorded there too.

### Pending

- [x] **Guard (B5):** deployed and set on 2026-11-18 (see the table above); sources verified on Sourcify.
- [x] **Demo account:** created on 2026-11-18 from the app: [`0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD`](https://explorer.arc.io/address/0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD), owned by the project test wallet, with a 60 USDC borrow allowance for the adapter (see *Checks once B5 is done*).
- [x] **Keeper:** configured and running against mainnet, end-to-end repayment proven (see *Keeper* below). For Gateway standing orders (B4), set `GATEWAY_ORDERS_FILE` (outside the repository), `GATEWAY_INTAKE_PORT=8787`, and `NEXT_PUBLIC_KEEPER_URL=http://localhost:8787` for the app. The app needs `NEXT_PUBLIC_ARDOISE_NETWORK=mainnet` (`.env.example` defaults to testnet).

### Checks once B5 is done

Read-only, against `https://rpc.mainnet.arc.io`, comparing with the A4 state above:

- [x] `factory.guard()` returns the deployed `MarginGuard`, and `guard.minHealthFactor()` / `targetHealthFactor()` return `1.25e18` / `1.5e18`.
- [x] `factory.venues()` still returns `[0x38B564d0b3d57216A34d83FbF08DE48744567b38]` and `factory.admin()` the project wallet: B5 must not redeploy the factory or the adapter.
- [x] `factory.accountOf(0x54e1714a0ffae58d3AA227C80FD48668e11f18d7)` returns the demo account, and `Taker.borrowAllowance(MainSpoke, 0, demoWallet, AaveV4Adapter)` is not zero. Checked on 2026-11-18: account `0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD`, allowance 60 USDC.
- [x] `guard.checkMargin(demoWallet, AaveV4Adapter, 1e6)` returns `1e6` while the demo position is healthy. Checked on 2026-11-18 after the first payment: returns `1e6`.
- [x] A first `pay()` from the demo account succeeds on mainnet: account [`0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD`](https://explorer.arc.io/address/0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD) paid 0.40 USDC to Base from the app on 2026-11-18, borrowing 0.45523 USDC on Aave V4 through the guard (debt line #1): [pay on Arc](https://explorer.arc.io/tx/0x9dfdd3d8ba60968a8feaed312edd03ad8c238850e89ec3af05cb3aa8b5836aed), [mint on Base](https://basescan.org/tx/0x80d15046477b5332f3c55150b82dfeba38dbb97e15af9e70d792ffa266408a4b) (0.40 USDC to the payee, 0.05523 USDC forwarder fee). The keeper then found the account and repaid against its debt (see *Keeper* below).

## Keeper

The keeper (tasks B2 and B5) runs off chain, on the machine of whoever operates it. It is not a contract and holds no role: `sweep()` is public, so its wallet can only pay gas to apply the USDC already sitting on an account to that account's debt.

| Item | Value |
|------|-------|
| Keeper wallet | [`0xfA1Fd59bD90961d68AB60f66EE242e1Dd7c45541`](https://explorer.arc.io/address/0xfA1Fd59bD90961d68AB60f66EE242e1Dd7c45541), a dedicated wallet created for the keeper, funded with 1 USDC for gas on 2026-11-18 |
| Factory watched | `0xB4476B617B750B9f48786c60930bc499343BB4a8` (the Morpho factory), accounts read from block `31976642`; until 2026-11-19, the first factory `0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD` from block `31777009` |
| RPC | `https://rpc.mainnet.arc.io` (the default when `ARC_RPC_URL` is empty) |

### Configuration

In the repo-root `.env` (gitignored; the variables are described in [`.env.example`](../.env.example)):

```sh
ARC_RPC_URL=                                                        # empty: public Arc mainnet RPC
KEEPER_PRIVATE_KEY=                                                 # key of the keeper wallet, never committed or printed
ARDOISE_FACTORY_ADDRESS=0xB4476B617B750B9f48786c60930bc499343BB4a8
ARDOISE_FACTORY_DEPLOY_BLOCK=31976642
```

Leave `ARC_RPC_URL` empty or point it to Arc mainnet: on Arc Testnet the keeper would watch the mainnet factory address and silently find no account. Without `KEEPER_PRIVATE_KEY` the keeper runs dry: it logs its decisions and sends nothing. To replace the wallet, create one with `cast wallet new`, put its key in `.env` only and send it about 1 USDC on Arc.

### Start and logs

```sh
(cd keeper && npm install && npm start)
```

The keeper runs in the foreground and writes to standard output, one line per event, prefixed with an ISO timestamp and `[keeper]`; redirect it to keep a file, for example `npm start >> ~/ardoise-keeper.log 2>&1` (outside the repository). It logs the factory and the wallet address at start, then only changes: an account found, a decision that changed, a `sweep()` sent with its transaction hash, a failure and its recovery. The key is never logged. It makes one pass every 15 seconds (about ten reads): the public Arc RPC answers 429 when polled too often, so each request is retried with an exponential delay and a pass that still fails doubles the wait before the next one, up to 2 minutes. Use a dedicated endpoint in `ARC_RPC_URL` to run several keepers or other tools from the same address. It stops with Ctrl+C and can be restarted at any time: it keeps no state and rebuilds the account list from `ARDOISE_FACTORY_DEPLOY_BLOCK`.

### State

Running against mainnet since 2026-11-18. It found the demo account `0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD` from block 31777009.

Repayment proof (B2, B5): a plain 0.10 USDC transfer to the demo account ([transfer](https://explorer.arc.io/tx/0x578f203c3bdc3ea4b11c4d9c1862cd7b24627b28f00e71eb7e35d118c1402466), block 31853276) was followed 3 blocks later by `sweep()` from the keeper wallet ([sweep](https://explorer.arc.io/tx/0xe68ac63117e4ad5fee25fa63c8f7b70927dcdcca9b283f8201b2490247cf929a), block 31853279), which repaid 0.10 USDC against debt line #1 (`LineRepaid`). The owner's Aave USDC debt (`Spoke.getUserTotalDebt(0, owner)`) went from 1.515319 to 1.415319.

Gateway repayment from Base (B4, manual path), run on 2026-11-18 from the app with the demo wallet, the keeper running on the same machine:

| Step | Transaction | Result |
|------|-------------|--------|
| Deposit 1 USDC into Circle Gateway on Base | [`0x68283d5a…`](https://basescan.org/tx/0x68283d5a9d0747ccda803ba68af23214fa8d2c01d908833933ab2a204dd8b67e) | Credited by Gateway about 15 min later (Base finality) |
| Sign 2 standing orders of 0.4 USDC | none (signatures) | The keeper intake stored 2 orders |
| Repay 0.15 USDC now from Base: Gateway transfer with Circle's forwarder, minted on Arc to the account | [`0x66530e48…`](https://explorer.arc.io/tx/0x66530e482f4f1b2d1bffe4105050438ef2d944eee09fc9aae54d8b341ba7dce0) | 0.15 USDC on the account |
| `sweep()` by the keeper, about 5 s (block timestamps) after the USDC arrived | [`0x14463968…`](https://explorer.arc.io/tx/0x1446396825e0bce282c7de8dbf74acd4e1a4a6c891bbabf6be1c721ed5399764) | Debt 1.415329 → 1.265330 USDC (`Spoke.getUserTotalDebt`), health factor 2.224 → 2.488 |

Left after the run: 0.824729 USDC in the Gateway reserve and 2 standing orders of 0.4 USDC held by the keeper. Gateway charges its fee on top of the amount (about 0.025 USDC for the 0.15 repayment), so the reserve covers one order; using both needs about 0.03 USDC more in the reserve if Gateway checks it against the actual fee, about 0.08 USDC if against the signed fee cap. The first "Repay now" attempt was refused by Gateway because the order was signed with the exact fee estimate: Gateway answered that the fee cap was 0.000222 USDC short. A retry went through, and the app now signs immediate repayments with the same fee headroom as standing orders ([PR #41](https://github.com/enzoblain/Ardoise/pull/41)). The health factor read at the start of the B3 run below (2.416) is lower than right after this run (2.488) for almost the same debt because the bitcoin price moved in between.

Simulated price-drop demo (B3), with the repayment funded from the owner's Gateway reserve on Base (the automatic path of B4), run on 2026-11-18 from the keeper at commit [`7d7f958`](https://github.com/enzoblain/Ardoise/commit/7d7f958). Before the run: debt 1.265387 USDC, health factor 2.416, Gateway reserve on Base 0.824729 USDC with two signed 0.40 USDC standing orders in the keeper's `GATEWAY_ORDERS_FILE`.

| Step | Transaction | Block |
|---|---|---|
| The guard owner sets a 55% simulated drop (`setSimulatedDrop(5500)`): the simulated health factor falls to 1.087, under the 1.25 minimum | [`0xa32faf51…`](https://explorer.arc.io/tx/0xa32faf511dfe15c0e6f1a6761933859e67a2908e7f61fc95384104f655c232e3) | 31957851 |
| A 0.20 USDC `pay()` from the owner is refused by the guard: `PaymentRefused(200000, 0)` | [`0x433455e2…`](https://explorer.arc.io/tx/0x433455e25f1b9c35da979a996f9d798270a41ae353a00e63a48c568ef3c51fa9) (reverted) | 31957874 |
| The keeper sees the simulated health factor under the minimum with nothing on the account (0.348109 USDC missing to reach the 1.5 target) and submits one standing order to Gateway; Circle's forwarder mints 0.40 USDC on the account | [`0x39ef15e9…`](https://explorer.arc.io/tx/0x39ef15e9635ef1500b2690bc2b452e6cab6d0b1ff32f81b153692ffd8cef6253) | 31957883 |
| The keeper calls `sweep()`, which repays 0.40 USDC on Aave: 0.205254 USDC closes debt line #1 (`LineRepaid`), the remaining 0.194746 USDC goes to the venue debt without a line event | [`0x420afd89…`](https://explorer.arc.io/tx/0x420afd89cbf7f80882be56c1b4f2328e7068a75421d2876d15a113a3a6a0da24) | 31957910 |
| The guard owner clears the simulation (`setSimulatedDrop(0)`) | [`0x213d0b56…`](https://explorer.arc.io/tx/0x213d0b56297ca80c851e69d091e2f8ca2b1c648c5368eefaceeed605969290a7) | 31957954 |

From the keeper's first simulated reading (23:11:40 UTC) to the confirmed `sweep()` (23:11:57 UTC): 17 seconds. After the run: debt 0.865389 USDC, simulated health factor 1.590 (above the 1.5 target, so the keeper stopped), real health factor 3.533 once the simulation was cleared. The Gateway reserve went from 0.824729 to 0.399422 USDC: 0.40 USDC drawn plus a 0.025307 USDC Gateway fee. It no longer covers the second standing order (0.40 USDC plus the fee); deposit about 0.1 USDC on Base before running the demo again.

### Defense relay (D2)

The keeper's third defense step, in [`keeper/src/defense.ts`](../keeper/src/defense.ts). It is off while `DEFENSE_ALARM_ADDRESS` is empty. When it is on, the keeper runs, for each account on each pass:

1. `sweep()` when the account holds USDC (B2).
2. The owner's Gateway standing orders when the position is under the guard's minimum and the account holds nothing to repay with (B4).
3. When the position is still under the minimum, the account still holds nothing to repay with and Gateway is not covering the shortfall (no transfer on its way or settled in the last minute: no order left, or Gateway refused them, for example for a reserve too low), the defense relay:
   - simulates `DefenseAlarm.raise(owner)` on Arc. `CoolingDown(nextAllowed)`: nothing is sent until `nextAllowed`. `PositionHealthy`: the balance on the account restores the position, so the keeper calls `sweep()` on the account directly. Any other revert holds `raise` for that owner for 1 minute, doubling up to 1 hour;
   - sends `raise(owner)` with 30% gas headroom (the alarm's own `sweep()` reverts with `SweepOutOfGas` on a tight estimate) and follows that transaction until it has a receipt (the owner stays on hold meanwhile, so a slow `raise` is never sent twice; without a receipt after 5 minutes it is treated as lost and `raise` is held as after a failure), then reads `AlarmRaised` from the receipt;
   - polls Circle Iris, `GET https://iris-api.circle.com/v2/messages/26?transactionHash=<raise tx>`, every 2 s doubling up to 30 s, until the message's `status` is `complete`, and gives up when the alarm expires;
   - simulates, then sends `receiveMessage(message, attestation)` to the MessageTransmitterV2 on Base (`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`) with the same key and 50% gas headroom over the estimate, a complement to the executor's gas floor ([PR #48](https://github.com/enzoblain/Ardoise/pull/48): at least 300k gas before a swap plus a 63/64 check, else the delivery reverts with `SwapOutOfGas` instead of skipping the WETH swap and consuming the alarm; that revert is retried like any other failure), follows that transaction until it has a receipt instead of sending it again, and logs the executor's `DefenseExecuted` or `AlarmIgnored`. `TooSoon(owner, nextAllowed)`: delivered again from `nextAllowed` (waiting at least 5 s, so a clock ahead of Base cannot spin) if that is before the alarm's expiry, otherwise given up. `AlarmAlreadyUsed` or a CCTP nonce already used: someone delivered it, nothing left to do. Other failed simulations (no gas spent, for example a stale price): retried after 5 s, doubling up to 1 minute, until the alarm expires. A transaction that reverts or has no receipt after 5 minutes counts as a failed delivery; after 5 of them the alarm is given up;
   - lets the usual `sweep()` of step 1 repay the debt once Circle's forwarder mints the USDC on the account.

The keeper never chooses an amount or a recipient: the alarm measures the shortfall on chain and Circle's message bytes are relayed unchanged. Its wallet only pays gas, in USDC on Arc and in ETH on Base. State is kept in memory per owner: no second `raise` while a relay runs or during the alarm's cooldown, and Base transactions are sent one at a time. The cooldown is also enforced on chain, so a restart cannot raise two alarms for one shortfall; it can only drop the relay of an alarm already raised, which anyone can still deliver by hand from the `raise` transaction until it expires (see *Mainnet proof* below).

| Variable | Use |
|----------|-----|
| `DEFENSE_ALARM_ADDRESS` | `DefenseAlarm` on Arc; empty keeps the relay off |
| `BASE_RPC_URL` | Base endpoint for `receiveMessage`; empty uses the public Base RPC |
| `KEEPER_PRIVATE_KEY` | Same key on both chains; the wallet needs a little ETH on Base. Empty: dry run, the keeper logs the alarm it would raise and sends nothing |

At start, with the relay on, the keeper logs the alarm address and its wallet's address and ETH balance on Base. Status: built and covered by tests (`keeper/src/defense.test.ts`); not yet run against the mainnet contracts, which are not deployed.

## CCTP-attested defense (D1)

Deployed on 2026-11-19 from commit [`f48a7f2`](https://github.com/enzoblain/Ardoise/commit/f48a7f2) (after [#48](https://github.com/enzoblain/Ardoise/pull/48) and [#50](https://github.com/enzoblain/Ardoise/pull/50)) with [`script/DeployDefense.s.sol`](script/DeployDefense.s.sol), by the project wallet, for the factory above (cooldown 1800 s, alarm TTL 900 s; executor: fast burns, price age 1500 s, minimum interval 2400 s). Set `DEFENSE_ALARM_ADDRESS` for the keeper (it does not read `DEFENSE_EXECUTOR_ADDRESS`). See *CCTP-attested defense* in [`docs/api.md`](../docs/api.md).

| Contract | Chain | Address | Source verification |
|----------|-------|---------|---------------------|
| `DefenseAlarm` | Arc mainnet | [`0x3BABC3f53E354284C98F272CC4E093730aA05E43`](https://explorer.arc.io/address/0x3BABC3f53E354284C98F272CC4E093730aA05E43) | [Sourcify, exact match](https://repo.sourcify.dev/5042/0x3BABC3f53E354284C98F272CC4E093730aA05E43) |
| `DefenseExecutor` | Base mainnet | [`0x897B6baF462ae207895f2Cf32A0A4c6D98f15296`](https://basescan.org/address/0x897B6baF462ae207895f2Cf32A0A4c6D98f15296) | [Sourcify, exact match](https://repo.sourcify.dev/8453/0x897B6baF462ae207895f2Cf32A0A4c6D98f15296) |

| Step | Transaction | Block | Gas | Cost |
|------|-------------|-------|-----|------|
| Deploy `DefenseAlarm` (Arc) | [`0x263bef1c…`](https://explorer.arc.io/tx/0x263bef1c00aa23203f211e77869cb6613166918ba8c92464e6b68402379d156d) | 31975421 | 908,467 | 0.0234 USDC |
| Deploy `DefenseExecutor` (Base) | [`0xe36b79e6…`](https://basescan.org/tx/0xe36b79e68ec9f5ccf0997530938ce1d715fb2b4f8ed44ad2d1ae7dd1458effe8) | 59310147 | 1,998,458 | 0.000012 ETH |
| `alarm.setExecutor` (Arc) | [`0xc3ce8cf5…`](https://explorer.arc.io/tx/0xc3ce8cf5f1741a2a6286293d238cc71768e81a7caa95e663752342498c654863) | 31975485 | 44,899 | 0.0012 USDC |

### Mainnet proof

Run on 2026-11-19 on the demo position (owner: the project wallet, account [`0xdcB201E7…`](https://explorer.arc.io/address/0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD)): health factor 3.57, debt 0.865 USDC. The two Gateway standing orders were taken out of the keeper's orders file for the run, so Gateway would not repay first, and put back unchanged afterwards. The running keeper did not have the D2 relay yet, so the project wallet relayed the message to Base.

| Step | Transaction | Result |
|------|-------------|--------|
| Base: wrap 0.0002 ETH | [`0xe1ef27ec…`](https://basescan.org/tx/0xe1ef27ec701bfd8068f28bee9f620b0077136515635177621b277bafd49f2bd0) | 0.0002 WETH |
| Base: `WETH.approve(executor, 0.0002e18)` | [`0x7765a1d2…`](https://basescan.org/tx/0x7765a1d2817235b908ed8ab64e204e8823b080b7a59adda808170822bc15d4d7) | |
| Base: `setPolicy([USDC, WETH], [1e6, 0.0002e18], 86400, 100, 0.025e6)` | [`0xf248c348…`](https://basescan.org/tx/0xf248c348a97cd95c6f468aaef6899909907c1588d32c767c185564c0586e0868) | USDC first (none held), then WETH, 100 bps (1%) max slippage, 0.025 USDC max fee |
| Arc: `guard.setSimulatedDrop(7000)` | [`0x229348a8…`](https://explorer.arc.io/tx/0x229348a873f56128a9f7862e125eac99335c161a0e05ab27bcd9e1cf9f18a82e) | simulated health factor 1.07, under the 1.25 minimum (a 55% drop leaves it at 1.61) |
| Arc: `alarm.raise(owner)` | [`0x24ec3513…`](https://explorer.arc.io/tx/0x24ec351379fa834f71145c43b00a339c3ab8407368bb74a94d33582dc1d9f655) | 326,590 gas; `AlarmRaised`, `amountNeeded` 0.253127 USDC, nonce 1 |
| Circle attestation | `iris-api.circle.com/v2/messages/26?transactionHash=0x24ec3513…` | `complete`, finality 2000 |
| Base: `MessageTransmitterV2.receiveMessage(message, attestation)` | [`0xc26de466…`](https://basescan.org/tx/0xc26de466e79196ff47dff7926032ffd1a4362ab401b55280497bf150b1ef40e7) | 444,685 gas; 0.000157 WETH swapped for 0.278127 USDC (`AssetUsed`), burned to the account with `maxFee` 0.025 (`DefenseExecuted`) |
| Arc: Circle's forwarder mints | [`0x3fcc6ffd…`](https://explorer.arc.io/tx/0x3fcc6ffd7b14066b782ccc492ece8052271560a53c87e09b49ea27095c6bacc8) | 0.253127 USDC on the account |
| Arc: `account.sweep()` | [`0xc55f42ad…`](https://explorer.arc.io/tx/0xc55f42adea96b9bddd50ce2d24f613c48aadb838ef62ddcfb3c145350b8add7a) | debt 0.865396 → 0.612270 USDC, simulated health factor 1.504 (target 1.5) |
| Arc: `guard.setSimulatedDrop(0)` | [`0x26cf0faa…`](https://explorer.arc.io/tx/0x26cf0faa9c821c049812a15216ccdd651c43fc90922be4f0fa8903f9714fc810) | simulation cleared |

Timing (block timestamps): `raise` mined → attestation complete: under 9 s (polled every 2 s) → `receiveMessage` mined on Base: 21 s after `raise`, most of it the manual relay → forwarded mint on Arc: 5 s after the Base burn, 26 s after `raise`. The keeper running at the time did not sweep within a minute, so the sweep was sent by hand 66 s after the mint.

### How to deploy

From `contracts/`, with the factory admin's key in the environment (the alarm only reads the factory; `setExecutor` must come from the alarm's deployer). The 2026-11-19 deployment above cost 0.025 USDC on Arc and 0.000012 ETH on Base.

```sh
set -a && source ../.env && set +a                       # DEPLOYER_PRIVATE_KEY
# 1. Arc: the alarm, for the current factory (never hard-coded: pass it)
DEFENSE_FACTORY=0xB4476B617B750B9f48786c60930bc499343BB4a8 \
  forge script script/DeployDefense.s.sol:DeployDefenseAlarm --rpc-url https://rpc.mainnet.arc.io --broadcast
# 2. Base: the executor, trusting that alarm
DEFENSE_ALARM_ADDRESS=<alarm> \
  forge script script/DeployDefense.s.sol:DeployDefenseExecutor --rpc-url https://mainnet.base.org --broadcast
# 3. Arc: record the executor in the alarm (once)
DEFENSE_ALARM_ADDRESS=<alarm> DEFENSE_EXECUTOR_ADDRESS=<executor> \
  forge script script/DeployDefense.s.sol:SetDefenseExecutor --rpc-url https://rpc.mainnet.arc.io --broadcast
# Sources (Sourcify supports both chains)
forge verify-contract <alarm> src/defense/DefenseAlarm.sol:DefenseAlarm --chain-id 5042 --verifier sourcify \
  --constructor-args $(cast abi-encode "f(address,address,uint32,uint64,uint64)" \
    0xB4476B617B750B9f48786c60930bc499343BB4a8 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64 6 1800 900)
forge verify-contract <executor> src/defense/DefenseExecutor.sol:DefenseExecutor --chain-id 8453 --verifier sourcify \
  --constructor-args $(cast abi-encode "f((address,address,address,uint32,address,address,uint32,uint256,uint256),(address,address,uint24)[])" \
    "(0x81D40F21F12A8F0E3252Bccb954D722d4c464B64,0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d,<alarm>,26,0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,0x2626664c2603336E57B271c5C0b26F421741e481,1000,1500,2400)" \
    "[(0x4200000000000000000000000000000000000006,0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70,500)]")
```

A new factory (for example with a Morpho venue) needs a new alarm and a new executor, since the executor trusts one alarm address.

## How to deploy the guard

From `contracts/`, simulate first from the admin address (no key needed, nothing is sent), then broadcast. Prefer a Foundry keystore (`cast wallet import`) to signing with a raw key: the repo-root `.env` is also read by the app and the keeper. A `DEPLOYER_PRIVATE_KEY` set in the shell takes precedence over `--account`, so `unset DEPLOYER_PRIVATE_KEY` first.

```sh
forge script script/DeployGuard.s.sol --fork-url https://rpc.mainnet.arc.io --sender 0x54e1714a0ffae58d3AA227C80FD48668e11f18d7   # simulation
forge script script/DeployGuard.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast \
  --account <keystore name> --sender 0x54e1714a0ffae58d3AA227C80FD48668e11f18d7                  # broadcast, keystore
```

With the key in the environment instead, run `set -a && source ../.env && set +a` (it sets `DEPLOYER_PRIVATE_KEY`) and broadcast without `--account` and `--sender`.

The script refuses to send anything if the key is not the factory admin's or if a guard is already set (`ARDOISE_REPLACE_GUARD=true` allows replacing it). Thresholds default to 1.25e18 / 1.5e18 and can be overridden with `ARDOISE_MIN_HEALTH_FACTOR` / `ARDOISE_TARGET_HEALTH_FACTOR`. The admin also owns the guard, so it is the admin who turns the demo's simulated price drop on and off with `setSimulatedDrop`.

## How to redeploy

From `contracts/`, with the deployer key in the environment (never in a file under the repository):

```sh
set -a && source ../.env && set +a          # DEPLOYER_PRIVATE_KEY, optional ARDOISE_* settings
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.arc.io            # simulation
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast
```

The local simulation works with Arc's native USDC, since the deployment moves no tokens. It costs about 3.9M gas, about 0.10 USDC of Arc gas. A new factory means new accounts, and a new adapter means every user grants a new borrow allowance.

### Verifying the sources

The Arc mainnet explorer runs Blockscout behind a Cloudflare challenge that blocks `forge verify-contract --verifier blockscout`. Sourcify supports Arc mainnet and needs no API key:

```sh
forge verify-contract <factory> src/ArdoiseFactory.sol:ArdoiseFactory --chain-id 5042 --verifier sourcify \
  --constructor-args $(cast abi-encode "f(address,address,address,uint32,uint256,uint256)" \
    <admin> 0x3600000000000000000000000000000000000000 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d 2000 10000000 20000000)
forge verify-contract <adapter> src/venues/AaveV4Adapter.sol:AaveV4Adapter --chain-id 5042 --verifier sourcify \
  --constructor-args $(cast abi-encode "f(address,address,address,address,uint256)" \
    <factory> 0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d 0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF 0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1 0)
```
