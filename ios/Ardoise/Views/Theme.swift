import SwiftUI

/// The web app's palette (`app/src/app/globals.css`): a dark slate, chalk
/// text and bitcoin orange.
enum Theme {
    static let background = Color(red: 0x0b / 255, green: 0x0b / 255, blue: 0x0b / 255)
    static let card = Color(red: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255)
    static let line = Color(red: 0x2e / 255, green: 0x2e / 255, blue: 0x2e / 255)
    static let chalk = Color(red: 0xf5 / 255, green: 0xf5 / 255, blue: 0xf0 / 255)
    static let muted = Color(red: 0xa1 / 255, green: 0xa1 / 255, blue: 0xa1 / 255)
    static let accent = Color(red: 0xf7 / 255, green: 0x93 / 255, blue: 0x1a / 255)
    static let danger = Color(red: 0xf8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
}

/// A rounded glass card (a flat bordered one before iOS 26).
struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .glassSurface(cornerRadius: 20)
    }
}

/// Small uppercase label, like the web app's eyebrow.
struct Eyebrow: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(1.5)
            .foregroundStyle(Theme.muted)
    }
}
