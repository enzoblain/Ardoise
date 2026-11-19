import BigInt
import Foundation

/// One row of Circle's fee schedule for a CCTP route
/// (`GET /v2/burn/USDC/fees/{source}/{destination}?forward=true`).
struct IrisFee: Decodable, Sendable {
    struct ForwardFee: Decodable, Sendable {
        let low: Double
        let med: Double
        let high: Double
    }

    let finalityThreshold: Int
    let minimumFee: Double
    let forwardFee: ForwardFee?
}

/// The `maxFee` a payment to another chain borrows on top of its amount,
/// computed exactly like the web app's `computeMaxFee` (`app/src/lib/fees.ts`).
enum Fees {
    // Fast transfers use the lowest finality threshold Iris lists.
    private static let fastFinality = 1000
    // Protocol fees in parts per 1e10, so fractional basis points stay integers.
    private static let parts = BigUInt(10_000_000_000)

    /// The protocol fee plus the forwarder's highest fee, in USDC units.
    ///
    /// - Parameters:
    ///   - schedule: Circle's fee schedule for the route.
    ///   - amount: Amount the payee must receive, in USDC units.
    /// - Returns: The fee to pass as `maxFee`.
    /// - Throws: `FeeError.noFastTransfer` when the schedule has no fast transfer.
    static func maxFee(schedule: [IrisFee], amount: BigUInt) throws -> BigUInt {
        guard let fast = schedule.first(where: { $0.finalityThreshold == fastFinality }) else {
            throw FeeError.noFastTransfer
        }
        let forward = BigUInt(fast.forwardFee?.high ?? 0)
        // Round to whole parts first: 1.1 * 1e6 must not become 1100000.0000000002.
        let rate = BigUInt((fast.minimumFee * 1_000_000).rounded())
        let protocolFee = ceilDiv((amount + forward) * rate, parts - rate)
        return protocolFee + forward
    }

    /// Fetches Circle's fee schedule from Arc to a destination domain.
    static func schedule(to domain: UInt32) async throws -> [IrisFee] {
        let url = URL(string: "\(Deployment.irisUrl)/v2/burn/USDC/fees/\(Deployment.arcDomain)/\(domain)?forward=true")!
        let (data, response) = try await URLSession.shared.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw FeeError.quoteFailed }
        return try JSONDecoder().decode([IrisFee].self, from: data)
    }

    private static func ceilDiv(_ a: BigUInt, _ b: BigUInt) -> BigUInt {
        (a + b - 1) / b
    }
}

enum FeeError: LocalizedError {
    case noFastTransfer
    case quoteFailed

    var errorDescription: String? {
        switch self {
        case .noFastTransfer: return "Circle lists no fast transfer for this route."
        case .quoteFailed: return "Circle's fee quote failed."
        }
    }
}
