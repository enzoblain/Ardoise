import BigInt
import Foundation
import Observation

/// The app's state: the connected passkey, its Ardoise account and what was
/// last read about it.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case signedOut
        case loading
        /// Signed in, but the account is not set up yet: the activation screen.
        case needsActivation
        case ready
    }

    private(set) var phase: Phase = .signedOut
    private(set) var wallet: PasskeyWallet?
    private(set) var account: String?
    /// The one-time setup, while the account is not ready.
    private(set) var setup: SetupState?
    private(set) var state: AccountState?
    private(set) var lines: [DebtLine] = []
    var error: String?

    let service = ArdoiseService()

    /// Creates or picks a passkey, then reads its account.
    func connect(register: Bool, username: String) async {
        error = nil
        phase = .loading
        do {
            wallet = try await PasskeyWallet.connect(register: register, username: username)
            await refresh()
        } catch {
            phase = .signedOut
            self.error = Self.message(error)
        }
    }

    /// Reads the account, its positions and its statement again.
    func refresh() async {
        guard let wallet else { return }
        do {
            let setup = try await Setup.read(owner: wallet.address)
            guard setup.ready, let account = setup.account else {
                self.setup = setup
                self.account = nil
                phase = .needsActivation
                return
            }
            self.setup = nil
            self.account = account
            async let state = service.state(owner: wallet.address, account: account)
            async let lines = service.lines(account: account)
            self.state = try await state
            self.lines = try await lines
            phase = .ready
        } catch {
            self.error = Self.message(error)
            if phase == .loading { phase = .signedOut }
        }
    }

    /// Reads the setup again, for the activation screen's checklist.
    func refreshSetup() async {
        guard let wallet, phase == .needsActivation else { return }
        if let setup = try? await Setup.read(owner: wallet.address) { self.setup = setup }
    }

    /// Runs every missing setup step in one user operation signed with the
    /// passkey, then opens the app once the account is ready.
    ///
    /// - Returns: The activation's Arc transaction hash.
    /// - Throws: The bundler's or the passkey's error.
    @discardableResult
    func activate() async throws -> String {
        guard let wallet, let setup else { throw WalletError.notConfigured }
        let hash = try await wallet.send(calls: try Setup.calls(state: setup, owner: wallet.address))
        await refresh()
        return hash
    }

    func signOut() {
        wallet = nil
        account = nil
        setup = nil
        state = nil
        lines = []
        // An error from this session must not show on the sign-in screen.
        error = nil
        phase = .signedOut
    }

    /// Short, readable message for any error the SDK or the chain throws.
    static func message(_ error: Error) -> String {
        // ASAuthorizationError.canceled (1001): the user closed the passkey
        // sheet, or the device has no passkey for the site.
        if String(reflecting: error).contains("AuthorizationError Code=1001 ") {
            return "Cancelled, or no passkey for ardoise-rust.vercel.app on this device."
        }
        let text = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        return text.components(separatedBy: "\n").first ?? text
    }
}
