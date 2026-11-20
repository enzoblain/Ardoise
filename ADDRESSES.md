# Contract addresses

The Ardoise contracts in use, deployed on 2026-11-19 from `main`. Every source is verified on Sourcify (exact match). Full deployment record, transactions and checks: [`contracts/deployments.md`](contracts/deployments.md).

## Arc mainnet (chain id 5042)

| Contract | Role | Address | Source |
|---|---|---|---|
| `ArdoiseFactory` | Creates one account per owner; holds the lender list and the guard | [`0x96359511A27830eDa8B5c663fE451eCf11ae1449`](https://explorer.arc.io/address/0x96359511A27830eDa8B5c663fE451eCf11ae1449) | [Sourcify](https://repo.sourcify.dev/5042/0x96359511A27830eDa8B5c663fE451eCf11ae1449) |
| `AaveV4Adapter` | Borrows and repays USDC on the Aave V4 Main Spoke for the owner only | [`0xc07Ab03CC7E68a662124da695AF4Ea6745Dc6674`](https://explorer.arc.io/address/0xc07Ab03CC7E68a662124da695AF4Ea6745Dc6674) | [Sourcify](https://repo.sourcify.dev/5042/0xc07Ab03CC7E68a662124da695AF4Ea6745Dc6674) |
| `MorphoAdapter` | Same on Morpho's cirBTC / USDC market | [`0xf4F0009eFC9da4359f2d6A726F702B2F96749E03`](https://explorer.arc.io/address/0xf4F0009eFC9da4359f2d6A726F702B2F96749E03) | [Sourcify](https://repo.sourcify.dev/5042/0xf4F0009eFC9da4359f2d6A726F702B2F96749E03) |
| `MarginGuard` | Refuses borrowing under health factor 1.25; repay target 1.5 | [`0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080`](https://explorer.arc.io/address/0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080) | [Sourcify](https://repo.sourcify.dev/5042/0xEBAC5C07DC0983C01f55AbEAD77a3FcC7a4cf080) |
| `DefenseAlarm (production)` | Sends the Circle-attested CCTP alarm; real health factor | [`0x71146B387B1dF474dd165d35b384A38E1a02813b`](https://explorer.arc.io/address/0x71146B387B1dF474dd165d35b384A38E1a02813b) | [Sourcify](https://repo.sourcify.dev/5042/0x71146B387B1dF474dd165d35b384A38E1a02813b) |
| `DefenseAlarm (demo)` | Same, also follows the guard's simulated drop (demo only) | [`0xFbd04d6263aDD461C523f34C8c3717Fb5c437545`](https://explorer.arc.io/address/0xFbd04d6263aDD461C523f34C8c3717Fb5c437545) | [Sourcify](https://repo.sourcify.dev/5042/0xFbd04d6263aDD461C523f34C8c3717Fb5c437545) |
| `ArdoiseAccount (demo)` | The demo wallet's account used in the video | [`0x6Ce5C993328265425175cE044b0843F74aE98aB3`](https://explorer.arc.io/address/0x6Ce5C993328265425175cE044b0843F74aE98aB3) | [Sourcify](https://repo.sourcify.dev/5042/0x6Ce5C993328265425175cE044b0843F74aE98aB3) |

## Base mainnet (chain id 8453)

| Contract | Role | Address | Source |
|---|---|---|---|
| `DefenseExecutor (production)` | Spends only pre-authorized USDC / WETH, only to repay the account on Arc | [`0xbb8c9935BFE2F15169E7195E212AB50134064E5B`](https://basescan.org/address/0xbb8c9935BFE2F15169E7195E212AB50134064E5B) | [Sourcify](https://repo.sourcify.dev/8453/0xbb8c9935BFE2F15169E7195E212AB50134064E5B) |
| `DefenseExecutor (demo)` | Paired with the demo alarm | [`0x7016D3D0a4DB22c6C2079C5e7172a1A4d2161f29`](https://basescan.org/address/0x7016D3D0a4DB22c6C2079C5e7172a1A4d2161f29) | [Sourcify](https://repo.sourcify.dev/8453/0x7016D3D0a4DB22c6C2079C5e7172a1A4d2161f29) |

## Protocols Ardoise uses (not ours)

| Contract | Chain | Address |
|---|---|---|
| USDC | Arc | `0x3600000000000000000000000000000000000000` |
| cirBTC | Arc | `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0` |
| Aave V4 Main Spoke | Arc | `0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d` |
| Aave V4 TakerPositionManager | Arc | `0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF` |
| Aave V4 GiverPositionManager | Arc | `0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1` |
| Morpho (cirBTC / USDC market `0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d`) | Arc | `0x34CD04070dD72b14E241112F6d83812Df5Af7fCD` |
| Circle CCTP V2 TokenMessengerV2 | Arc, Base | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| Circle CCTP V2 MessageTransmitterV2 | Arc, Base | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Circle Gateway GatewayWallet | Arc, Base | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| Circle Gateway GatewayMinter | Arc, Base | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | Base | `0x4200000000000000000000000000000000000006` |
| Uniswap SwapRouter02 | Base | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Chainlink ETH / USD feed | Base | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` |
