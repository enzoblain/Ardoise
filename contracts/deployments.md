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

> [!WARNING]
> **Payments are not live yet.** No guard is set, so every `pay()` reverts with `GuardNotSet()`; repayments and `sweep()` already work. The items below are pending. When they are done, update this section and run the checks that follow.

### Pending

- [x] **Guard (B5):** deployed and set on 2026-11-18 (see the table above); sources verified on Sourcify.
- [ ] **Demo account:** owned by the project test wallet, which holds the cirBTC collateral on the Main Spoke and has already authorized the Taker and Giver position managers. It needs `factory.createAccount()` and `Taker.approveBorrow(MainSpoke, 0, AaveV4Adapter, cap)` for this adapter (see docs/api.md, *One-time user setup on Aave V4*).
- [ ] **Keeper:** in the repo-root `.env`, set `ARDOISE_FACTORY_ADDRESS=0xb44DD865DdD6a67b79C632Fe9795DB8e713692bD`, `ARDOISE_FACTORY_DEPLOY_BLOCK=31777009` and `KEEPER_PRIVATE_KEY` (a dedicated wallet holding a little USDC for gas), then run `(cd keeper && npm start)`. Leave `ARC_RPC_URL` empty or point it to Arc mainnet: on Arc Testnet the keeper would watch the mainnet factory address and silently find no account. The app needs `NEXT_PUBLIC_ARDOISE_NETWORK=mainnet` (`.env.example` defaults to testnet). For Gateway standing orders (B4), also set `GATEWAY_ORDERS_FILE` (outside the repository), `GATEWAY_INTAKE_PORT=8787`, and `NEXT_PUBLIC_KEEPER_URL=http://localhost:8787` for the app.

### Checks once B5 is done

Read-only, against `https://rpc.mainnet.arc.io`, comparing with the A4 state above:

- [x] `factory.guard()` returns the deployed `MarginGuard`, and `guard.minHealthFactor()` / `targetHealthFactor()` return `1.25e18` / `1.5e18`.
- [x] `factory.venues()` still returns `[0x38B564d0b3d57216A34d83FbF08DE48744567b38]` and `factory.admin()` the project wallet: B5 must not redeploy the factory or the adapter.
- [x] `factory.accountOf(0x54e1714a0ffae58d3AA227C80FD48668e11f18d7)` returns the demo account, and `Taker.borrowAllowance(MainSpoke, 0, demoWallet, AaveV4Adapter)` is not zero. Checked on 2026-11-18: account `0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD`, allowance 60 USDC.
- [ ] `guard.checkMargin(demoWallet, AaveV4Adapter, 1e6)` returns `1e6` while the demo position is healthy.
- [x] A first `pay()` from the demo account succeeds on mainnet: account [`0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD`](https://explorer.arc.io/address/0xdcB201E7dFCB1edaacB53043ca12558A260B2bBD) paid 0.40 USDC to Base from the app on 2026-11-18, borrowing 0.45523 USDC on Aave V4 through the guard (debt line #1): [pay on Arc](https://explorer.arc.io/tx/0x9dfdd3d8ba60968a8feaed312edd03ad8c238850e89ec3af05cb3aa8b5836aed), [mint on Base](https://basescan.org/tx/0x80d15046477b5332f3c55150b82dfeba38dbb97e15af9e70d792ffa266408a4b) (0.40 USDC to the payee, 0.05523 USDC forwarder fee). The keeper part is pending (PR #19).

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
