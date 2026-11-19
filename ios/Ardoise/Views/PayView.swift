import BigInt
import SwiftUI

/// Pay: how much, to whom and on which chain, then where the credit comes
/// from (the recommended venue, `bestVenue`, selected by default) and, in
/// plain words, what will happen. "Review" opens a confirmation sheet; only
/// its button signs `payVia` with the passkey.
struct PayView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    enum Chain: String, CaseIterable, Identifiable {
        case arc = "Arc", base = "Base"
        var id: String { rawValue }
        var domain: UInt32 { self == .arc ? Deployment.arcDomain : Deployment.baseDomain }
    }

    @State private var amountText = "1"
    @State private var chain: Chain = .arc
    @State private var payee = ""
    @State private var memo = ""
    @State private var quote: PaymentQuote?
    @State private var picked: Venue?
    @State private var quoting = false
    /// The last quote failed: the screen offers to try again.
    @State private var quoteFailed = false
    @State private var reviewing = false
    @State private var sending = false
    @State private var sentTx: String?
    /// A payment sent whose transaction could not be read: its user operation.
    @State private var unconfirmed: String?
    @State private var toast: Toast?
    /// Bumped after a payment to quote again on the new position.
    @State private var quoteVersion = 0

    private var amount: BigUInt? { Format.parseUsdc(amountText) }
    private var chosen: Venue? { picked ?? quote?.recommended }
    private var chosenOption: VenueOption? { quote?.options.first { $0.venue == chosen } }
    private var payeeValid: Bool {
        payee.count == 42 && payee.hasPrefix("0x") && payee.dropFirst(2).allSatisfy(\.isHexDigit)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                amountCard
                payeeCard
                venues
                plan
                if let sentTx { sentCard(sentTx) }
                if let unconfirmed { unconfirmedCard(unconfirmed) }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(ScreenBackground())
        .safeAreaInset(edge: .bottom) { reviewBar }
        .navigationTitle("Send money")
        .toast($toast)
        .sheet(isPresented: $reviewing, onDismiss: {
            // An expired quote is replaced as soon as its sheet closes.
            if quote == nil && !sending { quoteVersion += 1 }
        }) {
            if let quote, let option = chosenOption {
                ReviewSheet(quote: quote, option: option, payee: payee, chain: chain, memo: memo) {
                    reviewing = false
                    pay()
                }
                .presentationDetents([.medium, .large])
                .presentationBackground(.ultraThinMaterial)
            } else {
                ContentUnavailableView("This quote has expired", systemImage: "clock.arrow.circlepath",
                                       description: Text("Close this sheet: the venues are compared again."))
                    .presentationDetents([.medium])
            }
        }
        .task(id: "\(amountText)-\(chain.rawValue)-\(quoteVersion)") { await requote() }
    }

    // MARK: Form

    private var amountCard: some View {
        VStack(spacing: 6) {
            Eyebrow(text: "You send")
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                TextField("0", text: $amountText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.center)
                    .font(.system(size: 56, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Theme.chalk)
                    .fixedSize()
                Text("USDC").font(.title3.weight(.semibold)).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity)
            if let state = model.state {
                Text("\(Format.usdc(state.remaining)) USDC left to spend today")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 16)
        .glassSurface(cornerRadius: 28)
    }

    private var payeeCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "To")
            Picker("Payee's chain", selection: $chain) {
                ForEach(Chain.allCases) { Text("On \($0.rawValue)").tag($0) }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 10) {
                Image(systemName: "person.crop.circle")
                    .font(.title2)
                    .foregroundStyle(payeeValid ? Theme.accent : Theme.muted)
                TextField("Payee address (0x…)", text: $payee)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if payee.isEmpty {
                    // PasteButton reads the clipboard without the system's "Allow Paste" prompt.
                    PasteButton(payloadType: String.self) { strings in
                        let pasted = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        // The callback may run off the main thread.
                        Task { @MainActor in payee = pasted }
                    }
                    .labelStyle(.titleOnly)
                    .buttonBorderShape(.capsule)
                } else {
                    Button { payee = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                        .accessibilityLabel("Clear the payee address")
                }
            }
            Divider().overlay(Theme.line)
            HStack(spacing: 10) {
                Image(systemName: "text.bubble").font(.title3).foregroundStyle(Theme.muted)
                TextField("What's it for? (on the statement)", text: $memo)
            }
        }
        .padding(18)
        .glassSurface(cornerRadius: 24)
    }

    @ViewBuilder private var venues: some View {
        if let quote {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: "Borrow from").padding(.leading, 4)
                ForEach(quote.options) { option in
                    Button {
                        withAnimation(.snappy) { picked = option.venue }
                    } label: {
                        VenueCard(option: option, quote: quote, chosen: option.venue == chosen)
                    }
                    .buttonStyle(.plain)
                }
            }
        } else if quoteFailed {
            Button {
                quoteVersion += 1
            } label: {
                Label("Compare the venues again", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
            }
            .secondaryButton()
        } else if quoting {
            HStack(spacing: 10) {
                ProgressView()
                Text("Comparing the venues…").font(.footnote).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
    }

    /// What the payment does, step by step, in the user's terms.
    @ViewBuilder private var plan: some View {
        if let quote, let option = chosenOption {
            VStack(alignment: .leading, spacing: 14) {
                Eyebrow(text: "What happens")
                PlanStep(
                    number: 1, icon: "bitcoinsign.circle",
                    title: "Borrow \(Format.usdc(quote.borrow)) USDC on \(option.venue.name)",
                    detail: "At \(Format.bps(option.rateBps)) a year, against your cirBTC. Your bitcoin is not sold."
                )
                PlanStep(
                    number: 2, icon: chain == .arc ? "arrow.right.circle" : "point.3.connected.trianglepath.dotted",
                    title: "\(payeeValid ? Format.short(payee) : "The payee") receives \(Format.usdc(quote.amount)) USDC on \(chain.rawValue)",
                    detail: chain == .arc
                        ? "A direct transfer on Arc."
                        : "Sent with Circle CCTP. Circle's fee is at most \(Format.usdc(quote.maxFee)) USDC."
                )
            }
            .padding(18)
            .glassSurface(cornerRadius: 24)
        }
    }

    private func sentCard(_ tx: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Payment sent").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.chalk)
                Text("Transaction \(Format.short(tx))").font(.footnote.monospaced()).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button("View") { openURL(Deployment.explorer(tx: tx)) }
                .font(.footnote.weight(.semibold))
                .secondaryButton()
        }
        .padding(16)
        .glassSurface(cornerRadius: 22, tint: Theme.accent.opacity(0.12))
    }

    /// Stays on screen, unlike a notification: the user needs it to check
    /// the statement before paying again.
    private func unconfirmedCard(_ userOpHash: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Payment not confirmed yet", systemImage: "clock.badge.questionmark")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.chalk)
            Text("User operation \(Format.short(userOpHash)). Check the statement before paying again.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            Button("Done, compare the venues again") {
                unconfirmed = nil
                quoteVersion += 1
            }
            .font(.footnote.weight(.semibold))
            .secondaryButton()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(cornerRadius: 22, tint: Theme.danger.opacity(0.12))
    }

    // MARK: Review

    private var reviewBar: some View {
        VStack(spacing: 8) {
            if let blocker {
                Label(blocker, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            Button {
                reviewing = true
            } label: {
                Label(
                    sending ? "Confirm with your passkey…" : quote.map { "Review · send \(Format.usdc($0.amount)) USDC" } ?? "Review",
                    systemImage: sending ? "faceid" : "arrow.up.circle.fill"
                )
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .primaryButton()
            .controlSize(.large)
            .disabled(blocker != nil || sending)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }

    /// Why the payment cannot be reviewed yet, in a few words; nil when it can.
    private var blocker: String? {
        guard amount.map({ $0 > 0 }) ?? false else { return "Enter an amount." }
        guard let quote, quote.domain == chain.domain, quote.amount == amount else {
            if quoteFailed { return "Could not compare the venues." }
            return quoting ? "Comparing the venues…" : "Waiting for a quote."
        }
        guard payeeValid else { return "Enter the payee's address." }
        guard let option = chosenOption else { return "Pick a venue." }
        if quote.borrow > (model.state?.remaining ?? 0) {
            return "Over your daily cap: \(Format.usdc(model.state?.remaining ?? 0)) USDC left today."
        }
        if !option.usable(for: quote.borrow) { return "\(option.venue.name) cannot lend this amount: pick another venue." }
        return nil
    }

    // MARK: Chain

    private func requote() async {
        quote = nil
        quoteFailed = false
        // Reset here too: the quote this one replaced no longer resets it.
        quoting = false
        guard let amount, amount > 0, let wallet = model.wallet, let account = model.account else { return }
        quoting = true
        // A cancelled quote leaves `quoting` to the newer one that replaced it.
        defer { if !Task.isCancelled { quoting = false } }
        // Let typing settle before asking the chain.
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        do {
            let fresh = try await model.service.quote(owner: wallet.address, account: account, amount: amount, domain: chain.domain)
            // A newer amount or chain cancelled this quote: never show it.
            guard !Task.isCancelled else { return }
            quote = fresh
        } catch {
            if !Task.isCancelled {
                quoteFailed = true
                toast = .error("Could not compare the venues", error)
            }
        }
    }

    private func pay() {
        // The review sheet's button signs: it gets the same checks as the
        // button that opened it, and never runs while a payment is in flight.
        guard !sending, blocker == nil,
              let quote, let venue = chosen, let wallet = model.wallet, let account = model.account else { return }
        sending = true
        sentTx = nil
        unconfirmed = nil
        // What was sent, for the confirmation: the form may change meanwhile.
        let sentPayee = payee
        let sentMemo = memo
        let sentChain = chain
        Task {
            defer { sending = false }
            do {
                // Amount, chain and fee come from the quote on screen, never
                // from the form, which may have changed since it was made.
                let data = try model.service.payViaData(
                    venue: venue, amount: quote.amount, domain: quote.domain,
                    payee: sentPayee, maxFee: quote.maxFee, memo: sentMemo
                )
                let tx = try await wallet.send(to: account, data: data)
                sentTx = tx
                toast = .success("Sent \(Format.usdc(quote.amount)) USDC", detail: "To \(Format.short(sentPayee)) on \(sentChain.rawValue).")
                // The quote is spent: a new payment needs a new quote.
                self.quote = nil
                // Clear only what was sent, never what the user typed since.
                if payee == sentPayee { payee = "" }
                if memo == sentMemo { memo = "" }
                await model.refresh()
                quoteVersion += 1
            } catch WalletError.unconfirmed(let userOpHash) {
                // It may well have gone through: never offer the same payment again.
                self.quote = nil
                unconfirmed = userOpHash
            } catch {
                toast = .error("Payment failed", error)
            }
        }
    }
}

/// One numbered step of "What happens".
private struct PlanStep: View {
    let number: Int
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Theme.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(Theme.chalk)
                Text(detail).font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(number). \(title). \(detail)")
    }
}

/// The last look before signing: who gets what, on which chain, and what
/// it costs. Its button is the only one that signs.
private struct ReviewSheet: View {
    let quote: PaymentQuote
    let option: VenueOption
    let payee: String
    let chain: PayView.Chain
    let memo: String
    let confirm: () -> Void
    /// Set on the first tap, so a double tap cannot sign twice.
    @State private var confirmed = false

    var body: some View {
        VStack(spacing: 22) {
            VStack(spacing: 6) {
                Text("Send").font(.subheadline).foregroundStyle(Theme.muted)
                Text("\(Format.usdc(quote.amount)) USDC")
                    .font(.system(size: 44, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Theme.chalk)
                Text("to \(Format.grouped(payee))")
                    .font(.footnote.monospaced())
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                Text("on \(chain.rawValue)").font(.footnote.weight(.semibold)).foregroundStyle(Theme.accent)
            }
            .padding(.top, 8)
            VStack(spacing: 10) {
                row("Borrowed from", "\(option.venue.name) · \(Format.bps(option.rateBps))")
                row(chain == .arc ? "Transfer fee" : "Max. Circle CCTP fee", "\(Format.usdc(quote.maxFee)) USDC")
                row("Total borrowed", "\(Format.usdc(quote.borrow)) USDC").fontWeight(.semibold)
                if !memo.isEmpty { row("Memo", memo) }
            }
            .padding(16)
            .glassSurface(cornerRadius: 20)
            Button {
                confirmed = true
                confirm()
            } label: {
                Label("Send with my passkey", systemImage: "faceid")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .primaryButton()
            .controlSize(.large)
            .disabled(confirmed)
        }
        .padding(20)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Theme.muted)
            Spacer()
            Text(value).foregroundStyle(Theme.chalk).monospacedDigit()
        }
        .font(.callout)
    }
}

/// One venue: rate, liquidity and whether the guard allows this payment there.
struct VenueCard: View {
    let option: VenueOption
    let quote: PaymentQuote
    let chosen: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(chosen ? Theme.accent : Theme.muted)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(option.venue.name).font(.headline).foregroundStyle(Theme.chalk)
                    if option.venue == quote.recommended {
                        Text(isCheapest ? "Recommended · cheapest" : "Recommended")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Theme.accent.opacity(0.15), in: Capsule())
                    }
                }
                Label(status, systemImage: usable ? "checkmark.shield" : "exclamationmark.shield")
                    .font(.caption)
                    .foregroundStyle(usable ? Theme.muted : Theme.danger)
            }
            Spacer()
            Text(Format.bps(option.rateBps)).font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.chalk)
        }
        .padding(14)
        .glassSurface(cornerRadius: 20, tint: chosen ? Theme.accent.opacity(0.14) : nil, interactive: true)
        .opacity(usable ? 1 : 0.7)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    private var usable: Bool { option.usable(for: quote.borrow) }

    private var isCheapest: Bool {
        quote.options.allSatisfy { $0.rateBps >= option.rateBps }
    }

    private var status: String {
        if option.available < quote.borrow { return "Not enough liquidity for this payment" }
        guard let allowed = option.allowed else { return "Could not read the guard for this venue" }
        if allowed >= quote.borrow { return "Guard OK for this payment" }
        if allowed == 0 { return "Guard refuses: no margin here" }
        return "Guard refuses: up to \(Format.usdc(allowed)) USDC here"
    }
}
