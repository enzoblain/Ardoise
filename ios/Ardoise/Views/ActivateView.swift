import BigInt
import SwiftUI
import UIKit

/// The one-time setup of a passkey account, in the app: the address to fund
/// at the top with a copy button, the steps as a checklist that ticks itself
/// as the transfers land, and one "Activate" button, enabled once everything
/// is in place, that runs the whole setup in a single passkey signature.
struct ActivateView: View {
    @Environment(AppModel.self) private var model
    @State private var copied = false
    @State private var activating = false
    @State private var toast: Toast?

    /// How often the balances are read again while this screen is open.
    private static let pollInterval: Duration = .seconds(5)

    private var setup: SetupState? { model.setup }
    private var renewal: Bool { setup?.needsRenewalOnly ?? false }
    private var canActivate: Bool {
        guard let setup, let owner = model.wallet?.address else { return false }
        let calls = (try? Setup.calls(state: setup, owner: owner)) ?? []
        return (renewal || setup.funded) && setup.hasGas && !calls.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(renewal ? "Renew your borrow allowance" : "Activate your account")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(Theme.chalk)
                    Text(renewal
                        ? "Your payments have used up what Ardoise may borrow for you on Aave V4. One signature lets it borrow up to \(Format.usdc(Setup.borrowCap)) USDC again."
                        : "Fund your account, then activate it with one signature: it supplies your cirBTC to Aave V4 as collateral, creates your Ardoise account and lets it borrow up to \(Format.usdc(Setup.borrowCap)) USDC.")
                        .font(.callout)
                        .foregroundStyle(Theme.muted)
                }
                addressCard
                steps
                Button("Sign out", role: .destructive) { model.signOut() }
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
            }
            .padding(20)
        }
        .background(ScreenBackground())
        .safeAreaInset(edge: .bottom) { activateButton }
        .toast($toast)
        .task {
            // Ticks the steps by itself as the transfers land.
            while !Task.isCancelled {
                if !activating { await model.refreshSetup() }
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    private var addressCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "Your account address on Arc")
            // In groups of four, so it is easy to compare and never hyphenated;
            // the copy button copies the address as is.
            Text(Format.grouped(model.wallet?.address ?? ""))
                .font(.system(.title3, design: .monospaced))
                .foregroundStyle(Theme.chalk)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                UIPasteboard.general.string = model.wallet?.address
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            } label: {
                Label(copied ? "Copied" : "Copy address", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .secondaryButton()
            .controlSize(.large)
            Text(renewal
                ? "Send USDC for gas to this address on Arc if it runs low. The same address on Base keeps your Gateway reserve."
                : "Send cirBTC and USDC to this address on Arc. The same address on Base keeps your Gateway reserve.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
        }
        .padding(20)
        .glassSurface(cornerRadius: 24, tint: Theme.accent.opacity(0.10))
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "Before you activate").padding(.leading, 4)
            VStack(spacing: 0) {
                if !renewal {
                    CheckRow(
                        done: setup?.funded ?? false,
                        title: "Send cirBTC on Arc",
                        detail: cirBtcDetail
                    )
                    Divider().overlay(Theme.line)
                }
                CheckRow(
                    done: setup?.hasGas ?? false,
                    title: "Send at least \(Format.usdc(Setup.minGas)) USDC for gas",
                    detail: setup.map { "\(Format.usdc($0.gasBalance)) USDC on the account. Gas on Arc is paid in USDC." } ?? "Reading the balance…"
                )
                Divider().overlay(Theme.line)
                CheckRow(
                    done: false,
                    waiting: !canActivate,
                    title: renewal ? "Renew in one signature" : "Activate in one signature",
                    detail: canActivate ? "Everything is in place: tap \(renewal ? "Renew" : "Activate")." : "Available once the steps above are done."
                )
            }
            .glassSurface(cornerRadius: 20)
            Text("The steps tick themselves as your transfers land.")
                .font(.caption)
                .foregroundStyle(Theme.muted)
                .padding(.leading, 4)
        }
    }

    private var cirBtcDetail: String {
        guard let setup else { return "Reading the balance…" }
        if setup.collateral > 0 { return "\(Format.cirBtc(setup.collateral)) cirBTC already supplied on Aave V4." }
        if setup.walletCirBtc > 0 { return "\(Format.cirBtc(setup.walletCirBtc)) cirBTC received, ready to supply." }
        return "Send it to the address above. It becomes your collateral on Aave V4."
    }

    private var activateButton: some View {
        Button {
            activate()
        } label: {
            Text(activating ? "Confirm with your passkey…" : renewal ? "Renew" : "Activate")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .primaryButton()
        .controlSize(.large)
        .disabled(!canActivate || activating)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private func activate() {
        activating = true
        toast = nil
        Task {
            defer { activating = false }
            do {
                try await model.activate()
            } catch {
                toast = .error(renewal ? "Renewal failed" : "Activation failed", error)
            }
        }
    }
}

/// One setup step as a checkbox row: a filled check once done, an empty
/// circle while waiting, a dimmed one when it cannot start yet.
struct CheckRow: View {
    let done: Bool
    var waiting = false
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .foregroundStyle(done ? Theme.accent : waiting ? Theme.line : Theme.muted)
                .accessibilityLabel(done ? "Done" : "Not done")
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(done ? .regular : .semibold))
                    .foregroundStyle(done ? Theme.muted : waiting ? Theme.muted.opacity(0.6) : Theme.chalk)
                    .strikethrough(done, color: Theme.muted)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .animation(.easeInOut, value: done)
    }
}
