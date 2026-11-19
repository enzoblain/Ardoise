import SwiftUI

/// Sign in with a passkey: create one, or use the one already made on the
/// web app (same domain, same passkey).
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var username = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            Spacer()
            VStack(alignment: .leading, spacing: 10) {
                Text("Ardoise")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(Theme.chalk)
                Text("Pay from your bitcoin without selling it. Your position is defended on Arc.")
                    .foregroundStyle(Theme.muted)
            }
            Card {
                Eyebrow(text: "Sign in")
                Button {
                    connect(register: false)
                } label: {
                    Label("Use my passkey", systemImage: "person.badge.key.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Divider().overlay(Theme.line)
                Eyebrow(text: "New here")
                TextField("Name for the passkey", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(Theme.background, in: RoundedRectangle(cornerRadius: 12))
                Button("Create a passkey") { connect(register: true) }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .frame(maxWidth: .infinity)
                    .disabled(username.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .disabled(busy)
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
            Text("Your passkey owns a Circle smart account on Arc mainnet. The same passkey works on ardoise-rust.vercel.app.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            Spacer()
        }
        .padding(24)
    }

    private func connect(register: Bool) {
        busy = true
        Task {
            await model.connect(register: register, username: username.trimmingCharacters(in: .whitespaces))
            busy = false
        }
    }
}
