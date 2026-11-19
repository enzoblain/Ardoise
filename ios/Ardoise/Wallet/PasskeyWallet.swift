import BigInt
import CircleModularWalletsCore
import Foundation

/// A passkey that owns a Circle smart account (MSCA) on Arc mainnet, through
/// Circle's Modular Wallets SDK. The passkey's relying party is the web app's
/// domain (set in the Circle Console and in this app's associated domains),
/// so the same passkey works here and on https://ardoise-rust.vercel.app.
///
/// On Arc mainnet the account pays its own gas in USDC: Circle offers no
/// paymaster there (test 0.2 in `docs/roadmap.md`).
final class PasskeyWallet: @unchecked Sendable {
    let address: String
    private let account: CircleSmartAccount
    private let bundler: BundlerClient

    private init(address: String, account: CircleSmartAccount, bundler: BundlerClient) {
        self.address = address
        self.account = account
        self.bundler = bundler
    }

    /// Creates a passkey (`register`) or signs in with an existing one (`login`)
    /// and returns its smart account on Arc.
    ///
    /// - Parameters:
    ///   - register: True to create a new passkey named `username`.
    ///   - username: Name of the new passkey; ignored when signing in.
    /// - Throws: `WalletError.notConfigured` without a client key, or the SDK's
    ///   error when Circle refuses the key or the user cancels.
    static func connect(register: Bool, username: String) async throws -> PasskeyWallet {
        guard let clientKey = Bundle.main.object(forInfoDictionaryKey: "CircleClientKey") as? String, !clientKey.isEmpty else {
            throw WalletError.notConfigured
        }
        let credential: WebAuthnCredential
        do {
            credential = try await toWebAuthnCredential(
                transport: toPasskeyTransport(clientKey: clientKey),
                userName: register ? username : nil,
                mode: register ? .register : .login
            )
        } catch where String(reflecting: error).contains("401") {
            // The SDK sends the app's bundle ID; a client key made for the web
            // app (an allowed domain, no bundle ID) is refused with a bare 401.
            throw WalletError.keyRefused
        }
        let owner = toWebAuthnAccount(credential)
        let bundler = BundlerClient(chain: Arc, transport: toModularTransport(clientKey: clientKey, url: Deployment.circleArcUrl))
        let account = try await toCircleSmartAccount(client: bundler, owner: owner)
        return PasskeyWallet(address: account.getAddress(), account: account, bundler: bundler)
    }

    /// Sends one call from the smart account as a user operation, signed with
    /// the passkey, and waits for it to be mined.
    ///
    /// - Parameters:
    ///   - to: Contract to call.
    ///   - data: Call data.
    /// - Returns: The Arc transaction hash.
    /// - Throws: The bundler's error (a contract revert shows up here), or
    ///   `WalletError.reverted` when the operation was mined but failed.
    func send(to: String, data: Data) async throws -> String {
        // Circle's bundler prices user operations itself: use its medium tier,
        // as the web app does.
        let price = try await bundler.getUserOperationGasPrice()
        let partial = UserOperationV07(
            maxPriorityFeePerGas: price.medium.maxPriorityFeePerGas,
            maxFeePerGas: price.medium.maxFeePerGas
        )
        let userOpHash = try await bundler.sendUserOperation(
            account: account,
            calls: [EncodeCallDataArg(to: to, data: "0x" + data.map { String(format: "%02x", $0) }.joined())],
            partialUserOp: partial
        )
        // From here the payment is on its way: any failure to read its outcome
        // must not look like a payment that can be retried.
        let receipt: GetUserOperationReceiptResult
        do {
            receipt = try await bundler.waitForUserOperationReceipt(userOpHash: userOpHash, retryCount: 15)
        } catch {
            throw WalletError.unconfirmed(userOpHash)
        }
        guard let hash = receipt.receipt.transactionHash else { throw WalletError.unconfirmed(userOpHash) }
        guard receipt.success != false else { throw WalletError.reverted(hash) }
        return hash
    }
}

enum WalletError: LocalizedError {
    case notConfigured
    case keyRefused
    case unconfirmed(String)
    case reverted(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Passkeys are not configured: set CIRCLE_CLIENT_KEY in ios/Local.xcconfig."
        case .keyRefused:
            return "Circle refused the client key for this app: it needs an iOS client key for the bundle ID \(Bundle.main.bundleIdentifier ?? ""), with ardoise-rust.vercel.app as its passkey domain."
        case .unconfirmed(let userOpHash):
            return "The payment was sent (user operation \(Format.short(userOpHash))) but its transaction could not be read yet. Check the statement before paying again."
        case .reverted(let hash):
            return "The payment was mined but reverted (transaction \(Format.short(hash)))."
        }
    }
}
