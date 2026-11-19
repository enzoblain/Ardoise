import BigInt
import Foundation
import Web3Core

/// The owner's position on one venue (`IArdoise.health(venue)`), with the venue's live rate.
struct VenuePosition: Identifiable, Sendable {
    var id: String { venue.id }
    let venue: Venue
    let rateBps: BigUInt
    let available: BigUInt
    let healthFactor: BigUInt
    let collateralUsd: BigUInt
    let debtUsd: BigUInt
}

/// What the app shows about an account.
struct AccountState: Sendable {
    let account: String
    let perPayment: BigUInt
    let daily: BigUInt
    let spentToday: BigUInt
    /// Lowest health factor a payment may leave; nil while the factory has no guard.
    let minHealthFactor: BigUInt?
    /// USDC the smart account holds on Arc, which pays its gas.
    let gasBalance: BigUInt
    let positions: [VenuePosition]

    /// What is left under the binding cap today.
    var remaining: BigUInt {
        let dailyLeft = daily > spentToday ? daily - spentToday : 0
        return min(perPayment, dailyLeft)
    }
}

/// One venue as a payment would see it: rate, liquidity and the guard's answer.
struct VenueOption: Identifiable, Sendable {
    var id: String { venue.id }
    let venue: Venue
    let rateBps: BigUInt
    let available: BigUInt
    /// `IGuard.checkMargin(owner, venue, borrow)`; nil when it could not be read.
    let allowed: BigUInt?

    func usable(for borrow: BigUInt) -> Bool { available >= borrow && (allowed ?? 0) >= borrow }
}

/// What a payment would borrow, and where.
struct PaymentQuote: Sendable {
    /// CCTP domain the quote was made for: the fee depends on it.
    let domain: UInt32
    let amount: BigUInt
    let maxFee: BigUInt
    let options: [VenueOption]
    /// `bestVenue(borrow)`: the cheapest venue the guard allows.
    let recommended: Venue?

    var borrow: BigUInt { amount + maxFee }
}

/// A debt line (`DebtLine` in `IArdoise.sol`).
struct DebtLine: Identifiable, Sendable {
    let id: BigUInt
    let venue: Venue?
    let principal: BigUInt
    let repaid: BigUInt
    let accruedInterest: BigUInt
    let rateBps: BigUInt
    let destinationDomain: BigUInt
    let openedAt: Date
    let payee: String
    let memo: String

    var outstanding: BigUInt {
        let due = principal + accruedInterest
        return due > repaid ? due - repaid : 0
    }
}

/// Why a payment cannot be quoted.
enum QuoteError: LocalizedError {
    case guardNotSet

    var errorDescription: String? {
        "Payments are not live yet: the factory has no position guard."
    }
}

/// Reads an Ardoise account on Arc mainnet and builds its payments.
struct ArdoiseService: Sendable {
    let rpc = ArcRpc()

    /// The owner's Ardoise account, or nil before it is activated.
    func accountOf(owner: String) async throws -> String? {
        let out = try await rpc.call(Abis.factory, at: Deployment.factory, "accountOf", [try address(owner)])
        let account = (out["0"] as? EthereumAddress)?.address ?? ""
        return account.isEmpty || BigUInt(account.dropFirst(2), radix: 16) == 0 ? nil : account
    }

    /// Caps, guard minimum, gas balance and the position on every venue.
    func state(owner: String, account: String) async throws -> AccountState {
        async let caps = rpc.call(Abis.account, at: account, "caps")
        async let guardOut = rpc.call(Abis.account, at: account, "guard")
        async let gas = rpc.call(Abis.erc20, at: Deployment.usdc, "balanceOf", [try address(owner)])
        async let positions = withThrowingTaskGroup(of: (Int, VenuePosition).self) { group in
            for (index, venue) in Deployment.venues.enumerated() {
                group.addTask { (index, try await position(account: account, venue: venue)) }
            }
            var result: [(Int, VenuePosition)] = []
            for try await item in group { result.append(item) }
            return result.sorted { $0.0 < $1.0 }.map(\.1)
        }

        let capsOut = try await caps
        let guardAddress = (try await guardOut)["0"] as? EthereumAddress
        var minHealthFactor: BigUInt?
        if let guardAddress, BigUInt(guardAddress.address.dropFirst(2), radix: 16) != 0 {
            let out = try await rpc.call(Abis.guardAbi, at: guardAddress.address, "minHealthFactor")
            minHealthFactor = out["0"] as? BigUInt
        }
        return AccountState(
            account: account,
            perPayment: capsOut["perPayment"] as? BigUInt ?? 0,
            daily: capsOut["daily"] as? BigUInt ?? 0,
            spentToday: capsOut["spentToday"] as? BigUInt ?? 0,
            minHealthFactor: minHealthFactor,
            gasBalance: (try await gas)["0"] as? BigUInt ?? 0,
            positions: try await positions
        )
    }

    private func position(account: String, venue: Venue) async throws -> VenuePosition {
        async let rate = rpc.call(Abis.venue, at: venue.address, "rate")
        async let available = rpc.call(Abis.venue, at: venue.address, "available")
        async let health = rpc.call(Abis.account, at: account, "health", [try address(venue.address)])
        let h = try await health
        return VenuePosition(
            venue: venue,
            rateBps: (try await rate)["0"] as? BigUInt ?? 0,
            available: (try await available)["0"] as? BigUInt ?? 0,
            healthFactor: h["healthFactor"] as? BigUInt ?? 0,
            collateralUsd: h["collateralUsd"] as? BigUInt ?? 0,
            debtUsd: h["debtUsd"] as? BigUInt ?? 0
        )
    }

    /// Quotes a payment: Circle's fee for a payment to Base, then every
    /// venue's liquidity and guard answer for `amount + fee`, and `bestVenue`.
    ///
    /// - Parameters:
    ///   - owner: The smart account that owns the Ardoise account.
    ///   - account: The Ardoise account.
    ///   - amount: Amount the payee receives, USDC units.
    ///   - domain: CCTP domain of the payee's chain.
    func quote(owner: String, account: String, amount: BigUInt, domain: UInt32) async throws -> PaymentQuote {
        let maxFee = domain == Deployment.arcDomain ? 0 : try Fees.maxFee(schedule: try await Fees.schedule(to: domain), amount: amount)
        let borrow = amount + maxFee
        let guardOut = try await rpc.call(Abis.account, at: account, "guard")
        guard let guardAddress = (guardOut["0"] as? EthereumAddress)?.address,
              BigUInt(guardAddress.dropFirst(2), radix: 16) != 0 else {
            throw QuoteError.guardNotSet
        }

        var options: [VenueOption] = []
        for venue in Deployment.venues {
            async let rate = rpc.call(Abis.venue, at: venue.address, "rate")
            async let available = rpc.call(Abis.venue, at: venue.address, "available")
            async let margin = rpc.call(Abis.guardAbi, at: guardAddress, "checkMargin", [try address(owner), try address(venue.address), borrow])
            options.append(VenueOption(
                venue: venue,
                rateBps: (try await rate)["0"] as? BigUInt ?? 0,
                available: (try await available)["0"] as? BigUInt ?? 0,
                // A failed read shows as unread, never as a refusal.
                allowed: (try? await margin)?["0"] as? BigUInt
            ))
        }
        try Task.checkCancellation()
        // bestVenue reverts when no venue qualifies: no recommendation then.
        let best: [String: Any]?
        do {
            best = try await rpc.call(Abis.account, at: account, "bestVenue", [borrow])
        } catch ChainError.reverted {
            best = nil
        }
        let bestAddress = (best?["0"] as? EthereumAddress)?.address.lowercased()
        let recommended = Deployment.venues.first { $0.address.lowercased() == bestAddress }
        return PaymentQuote(domain: domain, amount: amount, maxFee: maxFee, options: options, recommended: recommended)
    }

    /// The account's debt lines, oldest first. `IArdoise.line(id)` is read
    /// from 1 until it reverts with `UnknownLine`.
    func lines(account: String) async throws -> [DebtLine] {
        var result: [DebtLine] = []
        var id = BigUInt(1)
        while id <= 200 {
            let out: [String: Any]
            do {
                out = try await rpc.call(Abis.account, at: account, "line", [id])
            } catch ChainError.reverted(let reason) where reason.hasPrefix("UnknownLine") {
                break
            }
            guard let fields = out["0"] as? [Any], fields.count == 10 else { break }
            let venueAddress = (fields[1] as? EthereumAddress)?.address.lowercased()
            let payee = (fields[8] as? Data).map { "0x" + $0.suffix(20).toHexString() } ?? ""
            result.append(DebtLine(
                id: fields[0] as? BigUInt ?? id,
                venue: Deployment.venues.first { $0.address.lowercased() == venueAddress },
                principal: fields[2] as? BigUInt ?? 0,
                repaid: fields[3] as? BigUInt ?? 0,
                accruedInterest: fields[4] as? BigUInt ?? 0,
                rateBps: fields[5] as? BigUInt ?? 0,
                destinationDomain: fields[6] as? BigUInt ?? 0,
                openedAt: Date(timeIntervalSince1970: TimeInterval(fields[7] as? BigUInt ?? 0)),
                payee: payee,
                memo: fields[9] as? String ?? ""
            ))
            id += 1
        }
        return result
    }

    /// Call data of `payVia(venue, amount, domain, payee, maxFee, memo)`.
    ///
    /// - Throws: `ChainError.invalidAddress` for a bad payee, `ChainError.encoding` otherwise.
    func payViaData(venue: Venue, amount: BigUInt, domain: UInt32, payee: String, maxFee: BigUInt, memo: String) throws -> Data {
        let contract = try Contracts.contract(Abis.account)
        let parameters: [Any] = [try address(venue.address), amount, BigUInt(domain), try Contracts.payeeBytes32(payee), maxFee, memo]
        guard let data = contract.method("payVia", parameters: parameters, extraData: nil) else {
            throw ChainError.encoding("payVia")
        }
        return data
    }

    private func address(_ value: String) throws -> EthereumAddress {
        guard let parsed = EthereumAddress(value) else { throw ChainError.invalidAddress(value) }
        return parsed
    }
}
