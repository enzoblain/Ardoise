import SwiftUI

/// Shown when the passkey has no Ardoise account yet. Activation (supplying
/// cirBTC on Aave V4, authorizing the position managers, creating the account
/// and the borrow allowance) runs on the web app in one passkey signature;
/// the same passkey then works here.
struct ActivateView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer()
            Text("Activate your account")
                .font(.title.weight(.semibold))
                .foregroundStyle(Theme.chalk)
            Card {
                Eyebrow(text: "Your smart account on Arc")
                Text(model.wallet?.address ?? "")
                    .font(.footnote.monospaced())
                    .foregroundStyle(Theme.chalk)
                    .textSelection(.enabled)
                Text("Send it some cirBTC and at least 0.5 USDC for gas on Arc, then activate it on the web app with this same passkey: one signature supplies the cirBTC on Aave V4 and creates your Ardoise account.")
                    .font(.callout)
                    .foregroundStyle(Theme.muted)
            }
            Button {
                openURL(Deployment.webApp)
            } label: {
                Label("Activate on the web app", systemImage: "safari")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Button("I activated it, check again") { Task { await model.refresh() } }
                .frame(maxWidth: .infinity)
            Button("Sign out", role: .destructive) { model.signOut() }
                .frame(maxWidth: .infinity)
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
            Spacer()
        }
        .padding(24)
    }
}
