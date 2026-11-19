import SwiftUI

/// Liquid Glass where the system has it (iOS 26), the web app's flat card
/// before that, so the app still runs on the iOS 17 deployment target.
extension View {
    /// A glass surface in a rounded rectangle, optionally tinted.
    @ViewBuilder
    func glassSurface(cornerRadius: CGFloat = 24, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular.tint(tint).interactive(interactive), in: RoundedRectangle(cornerRadius: cornerRadius))
        } else {
            // Opaque card first, so a light tint never leaves the surface see-through.
            background {
                RoundedRectangle(cornerRadius: cornerRadius).fill(Theme.card)
                    .overlay(RoundedRectangle(cornerRadius: cornerRadius).fill(tint ?? .clear))
            }
            .overlay(RoundedRectangle(cornerRadius: cornerRadius).stroke(Theme.line))
        }
    }

    /// The prominent glass button style, or the bordered prominent one before iOS 26.
    @ViewBuilder
    func primaryButton() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent)
        } else {
            buttonStyle(.borderedProminent)
        }
    }

    /// The secondary glass button style, or the bordered one before iOS 26.
    @ViewBuilder
    func secondaryButton() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glass)
        } else {
            buttonStyle(.bordered)
        }
    }

    /// Shows `message` as a notification that slides in from the top and
    /// goes away by itself after a few seconds, or when tapped.
    func toast(_ message: Binding<Toast?>) -> some View {
        modifier(ToastModifier(toast: message))
    }
}

/// The dark slate with a soft bitcoin-orange glow, so the glass above it has
/// something to refract.
struct ScreenBackground: View {
    var body: some View {
        ZStack {
            Theme.background
            RadialGradient(colors: [Theme.accent.opacity(0.22), .clear], center: .topTrailing, startRadius: 0, endRadius: 420)
            RadialGradient(colors: [Theme.accent.opacity(0.10), .clear], center: .bottomLeading, startRadius: 0, endRadius: 360)
        }
        .ignoresSafeArea()
    }
}

/// A short notification: an error, or a confirmation.
struct Toast: Equatable, Identifiable {
    enum Kind { case error, success }

    let id = UUID()
    let kind: Kind
    let title: String
    let detail: String?

    /// An error notification whose detail is `error` in readable words.
    @MainActor static func error(_ title: String, _ error: Error) -> Toast {
        Toast(kind: .error, title: title, detail: AppModel.message(error))
    }

    /// An error notification with an optional line of detail.
    static func error(_ title: String, detail: String? = nil) -> Toast {
        Toast(kind: .error, title: title, detail: detail)
    }

    /// A confirmation notification with an optional line of detail.
    static func success(_ title: String, detail: String? = nil) -> Toast {
        Toast(kind: .success, title: title, detail: detail)
    }
}

private struct ToastModifier: ViewModifier {
    @Binding var toast: Toast?

    /// Long enough to read a two-line error.
    private static let shownFor: Duration = .seconds(5)

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let toast {
                    ToastView(toast: toast)
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .onTapGesture { dismiss() }
                        .task(id: toast.id) {
                            try? await Task.sleep(for: Self.shownFor)
                            if !Task.isCancelled { dismiss() }
                        }
                        .sensoryFeedback(toast.kind == .error ? .error : .success, trigger: toast.id)
                }
            }
            .animation(.spring(duration: 0.4), value: toast)
    }

    private func dismiss() {
        toast = nil
    }
}

private struct ToastView: View {
    let toast: Toast

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: toast.kind == .error ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(toast.kind == .error ? Theme.danger : Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(toast.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.chalk)
                if let detail = toast.detail {
                    Text(detail).font(.footnote).foregroundStyle(Theme.muted).lineLimit(3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(cornerRadius: 22, tint: toast.kind == .error ? Theme.danger.opacity(0.18) : nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}
