import BigInt
import Foundation

/// Display and parsing of the contracts' units: USDC with 6 decimals, rates
/// in basis points, health factors and USD values in WAD (18 decimals).
enum Format {
    static let wad = BigUInt(10).power(18)
    static let usdcUnit = BigUInt(1_000_000)
    /// `type(uint256).max`: the health factor of a position without debt.
    static let noDebt = BigUInt(2).power(256) - 1

    /// "20.00" or "0.054508": at least two decimals, trailing zeros past them dropped.
    static func usdc(_ units: BigUInt) -> String {
        let whole = units / usdcUnit
        var fraction = String(units % usdcUnit)
        fraction = String(repeating: "0", count: 6 - fraction.count) + fraction
        while fraction.count > 2, fraction.hasSuffix("0") { fraction.removeLast() }
        return "\(whole).\(fraction)"
    }

    /// "0.00025": cirBTC from its 8 decimals, trailing zeros dropped.
    static func cirBtc(_ units: BigUInt) -> String {
        let unit = BigUInt(100_000_000)
        var fraction = String(units % unit)
        fraction = String(repeating: "0", count: 8 - fraction.count) + fraction
        while fraction.hasSuffix("0") { fraction.removeLast() }
        return fraction.isEmpty ? "\(units / unit)" : "\(units / unit).\(fraction)"
    }

    /// Parses "20", "0.5" or "1,25" into USDC units; nil for anything else,
    /// zero, or more than 6 decimals.
    static func parseUsdc(_ text: String) -> BigUInt? {
        let normalized = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        let pieces = normalized.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(pieces.count),
              pieces.allSatisfy({ $0.allSatisfy { $0.isASCII && $0.isNumber } }),
              let whole = BigUInt(pieces[0].isEmpty ? "0" : String(pieces[0])) else { return nil }
        var fraction = pieces.count == 2 ? String(pieces[1]) : ""
        guard fraction.count <= 6 else { return nil }
        fraction += String(repeating: "0", count: 6 - fraction.count)
        let value = whole * usdcUnit + (BigUInt(fraction) ?? 0)
        return value > 0 ? value : nil
    }

    /// "3.10%".
    static func bps(_ bps: BigUInt) -> String {
        String(format: "%.2f%%", Double(bps) / 100)
    }

    /// "1.95", or "∞" without debt.
    static func healthFactor(_ wadValue: BigUInt) -> String {
        if wadValue >= noDebt / 2 { return "∞" }
        return String(format: "%.2f", toDouble(wadValue))
    }

    /// "$3.93" from a WAD USD value.
    static func usd(_ wadValue: BigUInt) -> String {
        String(format: "$%.2f", toDouble(wadValue))
    }

    /// Share of borrowing power still unused: 1 - 1 / health factor, as in the web app.
    static func margin(_ healthFactor: BigUInt) -> Double {
        if healthFactor >= noDebt / 2 { return 1 }
        let hf = toDouble(healthFactor)
        return hf <= 1 ? 0 : 1 - 1 / hf
    }

    /// "0x094a ea44 81b4 …": an address in groups of four after the 0x.
    static func grouped(_ address: String) -> String {
        guard address.hasPrefix("0x") else { return address }
        var groups: [String] = ["0x"]
        var current = ""
        for character in address.dropFirst(2) {
            current.append(character)
            if current.count == 4 {
                groups.append(current)
                current = ""
            }
        }
        if !current.isEmpty { groups.append(current) }
        return groups.joined(separator: " ").replacingOccurrences(of: "0x ", with: "0x")
    }

    /// "0x54e1…18d7".
    static func short(_ address: String) -> String {
        guard address.count > 10 else { return address }
        return "\(address.prefix(6))…\(address.suffix(4))"
    }

    static func toDouble(_ wadValue: BigUInt) -> Double {
        Double(wadValue / (wad / 1_000_000)) / 1_000_000
    }
}
