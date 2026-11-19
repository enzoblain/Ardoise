import Foundation

/// The Ardoise contracts on Arc mainnet, from `contracts/deployments.md` (the
/// factory with the security-review fixes). Same values as the web app's
/// `app/src/lib/contracts/deployments.ts`.
enum Deployment {
    static let factory = "0x96359511A27830eDa8B5c663fE451eCf11ae1449"
    static let usdc = "0x3600000000000000000000000000000000000000"
    static let cirBtc = "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0"

    /// Aave V4 on Arc: the Main Spoke holds the positions; the Taker and Giver
    /// position managers borrow and repay on the user's behalf.
    static let aaveSpoke = "0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d"
    static let aaveTaker = "0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF"
    static let aaveGiver = "0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1"
    static let usdcReserveId = 0
    static let cirBtcReserveId = 2

    /// The Aave V4 adapter, which the one-time setup allows to borrow.
    static let aaveAdapter = "0xc07Ab03CC7E68a662124da695AF4Ea6745Dc6674"

    /// Lending venues, in the factory's order, with the name shown in the app.
    static let venues: [Venue] = [
        Venue(id: "aave-v4", name: "Aave V4", address: aaveAdapter),
        Venue(id: "morpho", name: "Morpho", address: "0xf4F0009eFC9da4359f2d6A726F702B2F96749E03"),
    ]

    /// CCTP domains the app pays to.
    static let arcDomain: UInt32 = 26
    static let baseDomain: UInt32 = 6

    /// Public Arc mainnet RPC, the one the web app tries first.
    static let arcRpc = URL(string: "https://rpc.blockdaemon.mainnet.arc.io")!
    /// Circle's Modular Wallets endpoint, with the Arc mainnet path the web app uses.
    static let circleArcUrl = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl/arc"
    /// Circle's CCTP attestation service, for fee quotes.
    static let irisUrl = "https://iris-api.circle.com"
    /// The web app, where an account is activated and protected with the same passkey.
    static let webApp = URL(string: "https://ardoise-rust.vercel.app/app")!

    /// Arc explorer page of a transaction.
    static func explorer(tx: String) -> URL {
        URL(string: "https://explorer.arc.io/tx/\(tx)")!
    }
}

/// A lending venue adapter the account can borrow through.
struct Venue: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let address: String
}
