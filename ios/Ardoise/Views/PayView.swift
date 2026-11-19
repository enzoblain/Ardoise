import BigInt
import SwiftUI

/// Pay: amount, payee chain, payee and memo, then the venues side by side
/// with the recommended one (`bestVenue`) selected by default. The payment
/// calls `payVia` on the venue on screen from the passkey's smart account.
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
    @State private var quoteError: String?
    @State private var sending = false
    @State private var sentTx: String?
    @State private var payError: String?

    private var amount: BigUInt? { Format.parseUsdc(amountText) }
    private var chosen: Venue? { picked ?? quote?.recommended }
    private var chosenOption: VenueOption? { quote?.options.first { $0.venue == chosen } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Card {
                    Eyebrow(text: "Amount")
                    HStack {
                        TextField("0", text: $amountText)
                            .keyboardType(.decimalPad)
                            .font(.system(size: 40, weight: .semibold).monospacedDigit())
                        Text("USDC").foregroundStyle(Theme.muted)
                    }
                    Picker("Payee's chain", selection: $chain) {
                        ForEach(Chain.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    TextField("Payee address on \(chain.rawValue) (0x…)", text: $payee)
                        .font(.callout.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Memo, shown on the statement", text: $memo)
                }
                venues
                summary
                if let quoteError { Text(quoteError).font(.footnote).foregroundStyle(Theme.danger) }
                if let payError { Text(payError).font(.footnote).foregroundStyle(Theme.danger) }
                if let sentTx {
                    Card {
                        Eyebrow(text: "Payment sent")
                        Button("See the transaction on Arc") { openURL(Deployment.explorer(tx: sentTx)) }
                    }
                }
                Button {
                    pay()
                } label: {
                    Text(sending ? "Confirm with your passkey…" : "Pay \(quote.map { Format.usdc($0.amount) } ?? "") USDC")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canPay)
            }
            .padding(16)
        }
        .navigationTitle("Pay")
        .task(id: "\(amountText)-\(chain.rawValue)") { await requote() }
    }

    @ViewBuilder private var venues: some View {
        if let quote {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Borrow from")
                ForEach(quote.options) { option in
                    Button { picked = option.venue } label: { VenueCard(option: option, quote: quote, chosen: option.venue == chosen) }
                        .buttonStyle(.plain)
                }
            }
        } else if quoteError == nil, amount != nil {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var summary: some View {
        if let quote {
            Card {
                row("Payee receives", "\(Format.usdc(quote.amount)) USDC")
                row(chain == .arc ? "Transfer fee" : "Max. CCTP fee (Circle)", "\(Format.usdc(quote.maxFee)) USDC")
                row("You borrow", "\(Format.usdc(quote.borrow)) USDC").fontWeight(.semibold)
                if let state = model.state, quote.borrow > state.remaining {
                    Text("Over your cap: \(Format.usdc(state.remaining)) USDC left today.")
                        .font(.footnote).foregroundStyle(Theme.danger)
                }
            }
        }
    }

    private var canPay: Bool {
        guard let quote, let option = chosenOption, !sending, quote.domain == chain.domain, quote.amount == amount,
              payee.count == 42, payee.hasPrefix("0x") else { return false }
        return option.usable(for: quote.borrow) && quote.borrow <= (model.state?.remaining ?? 0)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Theme.muted)
            Spacer()
            Text(value).monospacedDigit()
        }
        .font(.callout)
    }

    private func requote() async {
        quote = nil
        quoteError = nil
        guard let amount, let wallet = model.wallet, let account = model.account else { return }
        // Let typing settle before asking the chain.
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        do {
            let fresh = try await model.service.quote(owner: wallet.address, account: account, amount: amount, domain: chain.domain)
            // A newer amount or chain cancelled this quote: never show it.
            guard !Task.isCancelled else { return }
            quote = fresh
        } catch {
            if !Task.isCancelled { quoteError = AppModel.message(error) }
        }
    }

    private func pay() {
        guard let quote, let venue = chosen, let wallet = model.wallet, let account = model.account else { return }
        sending = true
        payError = nil
        sentTx = nil
        Task {
            defer { sending = false }
            do {
                // Everything comes from the quote on screen, never from the
                // form, which may have changed since.
                let data = try model.service.payViaData(
                    venue: venue, amount: quote.amount, domain: quote.domain,
                    payee: payee, maxFee: quote.maxFee, memo: memo
                )
                sentTx = try await wallet.send(to: account, data: data)
                // The quote is spent: a new payment needs a new quote.
                self.quote = nil
                payee = ""
                memo = ""
                await model.refresh()
            } catch WalletError.unconfirmed(let userOpHash) {
                // It may well have gone through: never offer the same payment again.
                self.quote = nil
                payError = WalletError.unconfirmed(userOpHash).errorDescription
            } catch {
                payError = AppModel.message(error)
            }
        }
    }
}

/// One venue: rate, liquidity and whether the guard allows this payment there.
struct VenueCard: View {
    let option: VenueOption
    let quote: PaymentQuote
    let chosen: Bool

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(option.venue.name).font(.headline)
                    if option.venue == quote.recommended {
                        Text(isCheapest ? "Recommended · cheapest" : "Recommended")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                    }
                }
                Text(status).font(.caption).foregroundStyle(option.usable(for: quote.borrow) ? Theme.muted : Theme.danger)
            }
            Spacer()
            Text(Format.bps(option.rateBps)).font(.title3.weight(.semibold).monospacedDigit())
        }
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(chosen ? Theme.chalk : Theme.line, lineWidth: chosen ? 1.5 : 1))
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

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
