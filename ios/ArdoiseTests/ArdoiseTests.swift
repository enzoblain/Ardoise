import BigInt
import XCTest
@testable import Ardoise

/// The fee cases match the web app's `app/src/lib/fees.test.ts`, so both
/// apps borrow the same `maxFee` for the same quote.
final class FeesTests: XCTestCase {
    private func fee(_ minimumFee: Double, high: Double? = nil) -> IrisFee {
        IrisFee(finalityThreshold: 1000, minimumFee: minimumFee, forwardFee: high.map { .init(low: 0, med: 0, high: $0) })
    }

    func testAddsTheHighForwarderEstimateToAZeroProtocolFee() throws {
        XCTAssertEqual(try Fees.maxFee(schedule: [fee(0, high: 54_508)], amount: 20_000_000), 54_508)
    }

    func testChargesTheProtocolFeeOnTheBurnedAmount() throws {
        XCTAssertEqual(try Fees.maxFee(schedule: [fee(1.3, high: 50_000)], amount: 20_000_000), 52_607)
    }

    func testRoundsFractionalBpsExactlyAndNeverDown() throws {
        XCTAssertEqual(try Fees.maxFee(schedule: [fee(1.1)], amount: 100_000_000), 11_002)
        XCTAssertEqual(try Fees.maxFee(schedule: [fee(1.3)], amount: 1), 1)
    }

    func testFailsWithoutAFastTransfer() {
        XCTAssertThrowsError(try Fees.maxFee(schedule: [IrisFee(finalityThreshold: 2000, minimumFee: 0, forwardFee: nil)], amount: 1))
    }
}

final class FormatTests: XCTestCase {
    func testUsdcKeepsTwoDecimalsAndDropsTrailingZeros() {
        XCTAssertEqual(Format.usdc(20_000_000), "20.00")
        XCTAssertEqual(Format.usdc(54_508), "0.054508")
        XCTAssertEqual(Format.usdc(1_500_000), "1.50")
    }

    func testParsesAmounts() {
        XCTAssertEqual(Format.parseUsdc("20"), 20_000_000)
        XCTAssertEqual(Format.parseUsdc("0,5"), 500_000)
        XCTAssertEqual(Format.parseUsdc(".25"), 250_000)
        XCTAssertNil(Format.parseUsdc("0"))
        XCTAssertNil(Format.parseUsdc("1.0000001"))
        XCTAssertNil(Format.parseUsdc("abc"))
    }

    func testHealthFactorAndMargin() {
        let wad = Format.wad
        XCTAssertEqual(Format.healthFactor(wad * 195 / 100), "1.95")
        XCTAssertEqual(Format.healthFactor(Format.noDebt), "∞")
        XCTAssertEqual(Format.margin(wad * 2), 0.5, accuracy: 1e-9)
        XCTAssertEqual(Format.margin(wad), 0)
        XCTAssertEqual(Format.margin(Format.noDebt), 1)
    }
}

final class EncodingTests: XCTestCase {
    func testPayeeIsLeftPaddedToBytes32() throws {
        let payee = try Contracts.payeeBytes32("0xdf41621b35b0c3512d1177DE1423747900fC7a77")
        XCTAssertEqual(payee.count, 32)
        XCTAssertEqual(payee.prefix(12), Data(repeating: 0, count: 12))
        XCTAssertThrowsError(try Contracts.payeeBytes32("0x1234"))
    }

    func testPayViaCallDataUsesTheContractSelector() throws {
        let data = try ArdoiseService().payViaData(
            venue: Deployment.venues[1], amount: 1_000_000, domain: Deployment.baseDomain,
            payee: "0xdf41621b35b0c3512d1177DE1423747900fC7a77", maxFee: 54_508, memo: "Logo design"
        )
        // keccak256("payVia(address,uint256,uint32,bytes32,uint256,string)")[0..4], from `cast sig`.
        XCTAssertEqual(data.prefix(4).map { String(format: "%02x", $0) }.joined(), Self.payViaSelector)
        // Six head words, then the memo's length and padded bytes.
        XCTAssertEqual(data.count, 4 + 32 * 6 + 32 + 32)
    }

    static let payViaSelector = "6d928fbc"
}
