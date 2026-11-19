# Deployments

Addresses of the Ardoise contracts. The app (C4) and the keeper (B2) read them from here.

## Arc mainnet (chain id 5042)

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

The full broadcast is in [`broadcast/Deploy.s.sol/5042/run-latest.json`](broadcast/Deploy.s.sol/5042/run-latest.json).

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
| Factory watched | `0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD`, accounts read from block `31777009` |
| RPC | `https://rpc.mainnet.arc.io` (the default when `ARC_RPC_URL` is empty) |

### Configuration

In the repo-root `.env` (gitignored; the variables are described in [`.env.example`](../.env.example)):

```sh
ARC_RPC_URL=                                                        # empty: public Arc mainnet RPC
KEEPER_PRIVATE_KEY=                                                 # key of the keeper wallet, never committed or printed
ARDOISE_FACTORY_ADDRESS=0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD
ARDOISE_FACTORY_DEPLOY_BLOCK=31777009
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

## CCTP-attested defense (D1)

> [!WARNING]
> **Not deployed yet.** The contracts, tests and scripts are in [`src/defense/`](src/defense/) and [`script/DeployDefense.s.sol`](script/DeployDefense.s.sol); see *CCTP-attested defense* in [`docs/api.md`](../docs/api.md). Fill in the addresses below once deployed and set `DEFENSE_ALARM_ADDRESS` / `DEFENSE_EXECUTOR_ADDRESS` for the keeper.

| Contract | Chain | Address | Source verification |
|----------|-------|---------|---------------------|
| `DefenseAlarm` | Arc mainnet | Pending | — |
| `DefenseExecutor` | Base mainnet | Pending | — |

### How to deploy

From `contracts/`, with the factory admin's key in the environment (the alarm only reads the factory; `setExecutor` must come from the alarm's deployer). Simulated on 2026-11-19 against both chains from the project wallet: about 1.05M gas on Arc for the alarm (about 0.03 USDC) and 2.47M gas on Base for the executor (about 0.00003 ETH at 0.006 gwei).

```sh
set -a && source ../.env && set +a                       # DEPLOYER_PRIVATE_KEY
# 1. Arc: the alarm, for the current factory (never hard-coded: pass it)
DEFENSE_FACTORY=0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD \
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
    0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64 6 600 3600)
forge verify-contract <executor> src/defense/DefenseExecutor.sol:DefenseExecutor --chain-id 8453 --verifier sourcify \
  --constructor-args $(cast abi-encode "f((address,address,address,uint32,address,address,uint32,uint256),(address,address,uint24)[])" \
    "(0x81D40F21F12A8F0E3252Bccb954D722d4c464B64,0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d,<alarm>,26,0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,0x2626664c2603336E57B271c5C0b26F421741e481,1000,3600)" \
    "[(0x4200000000000000000000000000000000000006,0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70,500)]")
```

A new factory (for example with a Morpho venue) needs a new alarm and a new executor, since the executor trusts one alarm address.

### Mainnet proof (planned)

1. On Base, from the demo owner: wrap a little ETH (`WETH.deposit`), `setPolicy([USDC, WETH], [0, 0.001e18], 86400, 100, 0.03e6)` (WETH only, to show the swap), `WETH.approve(executor, max)`.
2. On Arc, the guard owner: `guard.setSimulatedDrop(5500)`; check `alarm.shortfall(owner)`.
3. Anyone: `alarm.raise(owner)`; fetch the attestation from `https://iris-api.circle.com/v2/messages/26?transactionHash=<raise tx>`; call `receiveMessage(message, attestation)` on the Base MessageTransmitterV2.
4. Check `DefenseExecuted` on Base, the forwarded mint on the demo account on Arc, then `sweep()` (keeper); clear the simulation with `setSimulatedDrop(0)`. Record every link here.

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
