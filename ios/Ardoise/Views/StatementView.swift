import SwiftUI

/// One line per payment, newest first: amount, venue, rate, payee and memo,
/// with interest so far.
struct StatementView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            if model.lines.isEmpty {
                Text("No payment yet.").foregroundStyle(Theme.muted)
            }
            ForEach(model.lines.reversed()) { line in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("#\(line.id.description)").font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                        Text(line.memo.isEmpty ? "Payment" : line.memo).font(.headline)
                        Spacer()
                        Text("\(Format.usdc(line.principal)) USDC").monospacedDigit()
                    }
                    Text("To \(Format.short(line.payee)) on \(line.destinationDomain == 26 ? "Arc" : line.destinationDomain == 6 ? "Base" : "domain \(line.destinationDomain)") · \(line.openedAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                    Text("\(line.venue?.name ?? "Venue") at \(Format.bps(line.rateBps)) · interest \(Format.usdc(line.accruedInterest)) · owed \(Format.usdc(line.outstanding))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.muted)
                }
                .listRowBackground(Theme.card)
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await model.refresh() }
        .navigationTitle("Statement")
    }
}
