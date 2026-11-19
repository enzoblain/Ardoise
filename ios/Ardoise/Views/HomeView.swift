import SwiftUI

/// The signed-in app: pay, statement and account.
struct HomeView: View {
    var body: some View {
        TabView {
            NavigationStack { PayView() }
                .tabItem { Label("Pay", systemImage: "paperplane.fill") }
            NavigationStack { StatementView() }
                .tabItem { Label("Statement", systemImage: "list.bullet.rectangle") }
            NavigationStack { AccountView() }
                .tabItem { Label("Account", systemImage: "shield.lefthalf.filled") }
        }
    }
}

/// The margin on each venue, the caps, and the gas balance.
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let state = model.state {
                    ForEach(state.positions) { position in
                        Card {
                            HStack {
                                Eyebrow(text: position.venue.name)
                                Spacer()
                                Text(Format.bps(position.rateBps)).foregroundStyle(Theme.muted)
                            }
                            HStack(alignment: .firstTextBaseline) {
                                Text("Health factor").foregroundStyle(Theme.muted)
                                Spacer()
                                Text(Format.healthFactor(position.healthFactor))
                                    .font(.title2.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(Theme.chalk)
                            }
                            MarginBar(margin: Format.margin(position.healthFactor),
                                      minimum: state.minHealthFactor.map(Format.margin))
                            HStack {
                                Text("Collateral \(Format.usd(position.collateralUsd))")
                                Spacer()
                                Text("Debt \(Format.usd(position.debtUsd))")
                            }
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(Theme.muted)
                        }
                    }
                    Card {
                        Eyebrow(text: "Limits")
                        row("Per payment", "\(Format.usdc(state.perPayment)) USDC")
                        row("Today", "\(Format.usdc(state.spentToday)) of \(Format.usdc(state.daily)) USDC")
                        row("Guard minimum", state.minHealthFactor.map(Format.healthFactor) ?? "no guard")
                        row("USDC for gas", "\(Format.usdc(state.gasBalance)) USDC")
                    }
                    Card {
                        Eyebrow(text: "Accounts")
                        row("Smart account", Format.short(model.wallet?.address ?? ""))
                        row("Ardoise account", Format.short(state.account))
                    }
                }
                Button {
                    openURL(Deployment.webApp)
                } label: {
                    Label("Protection and stress test on the web app", systemImage: "safari")
                }
                Button("Sign out", role: .destructive) { model.signOut() }
            }
            .padding(16)
        }
        .background(ScreenBackground())
        .refreshable { await model.refresh() }
        .navigationTitle("Account")
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

/// How much borrowing power is still unused, against the guard's minimum.
struct MarginBar: View {
    let margin: Double
    let minimum: Double?

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.line)
                Capsule().fill(Theme.chalk).frame(width: geo.size.width * margin)
                if let minimum {
                    Rectangle().fill(Theme.accent).frame(width: 2).offset(x: geo.size.width * minimum)
                }
            }
        }
        .frame(height: 8)
        .accessibilityLabel("Margin \(Int(margin * 100)) percent")
    }
}
