import BigInt
import Foundation
import Web3Core

/// Where a passkey account stands in its one-time setup, read on Arc.
/// Mirrors `SetupState` in the web app's `app/src/lib/setup.ts`.
struct SetupState: Sendable {
    /// cirBTC supplied on the Aave V4 Main Spoke, 8 decimals.
    let collateral: BigUInt
    /// cirBTC on the smart account, not supplied yet, 8 decimals.
    let walletCirBtc: BigUInt
    let collateralEnabled: Bool
    let takerApproved: Bool
    let giverApproved: Bool
    /// The Ardoise account, nil before `createAccount()`.
    let account: String?
    /// USDC the Aave adapter may still borrow for the owner.
    let borrowAllowance: BigUInt
    /// The per-payment cap (the factory's default before the account exists).
    let perPaymentCap: BigUInt
    /// USDC on the smart account, which pays its gas on Arc, 6 decimals.
    let gasBalance: BigUInt

    /// Whether cirBTC is on the account or already supplied.
    var funded: Bool { walletCirBtc > 0 || collateral > 0 }
    /// Whether the account holds enough USDC to pay for the activation.
    var hasGas: Bool { gasBalance >= Setup.minGas }
    /// Whether the account was activated before and only its borrow allowance
    /// ran out: payments use it up, and it is renewed in one signature.
    var needsRenewalOnly: Bool {
        account != nil && takerApproved && giverApproved && collateral > 0 && collateralEnabled
            && borrowAllowance < perPaymentCap
    }
    /// Whether the account can pay: everything the web app's setup checks is done.
    var ready: Bool {
        account != nil && takerApproved && giverApproved && borrowAllowance >= perPaymentCap
            && collateral > 0 && collateralEnabled
    }
}

/// The one-time setup of a passkey account, run in one user operation:
/// supply the cirBTC it holds, enable it as collateral, authorize Aave's
/// position managers, create the Ardoise account and allow the Aave adapter
/// to borrow. Same calls, in the same order, as the web app's `activationCalls`.
enum Setup {
    /// Borrow allowance given to the shared adapter: three days at the default
    /// daily cap (20 USDC), finite as `docs/api.md` recommends.
    static let borrowCap = BigUInt(60_000_000)
    /// USDC the account should hold before activating (6 decimals): the bundler
    /// checks the EntryPoint prefund, and the activation deploys the account
    /// and batches seven calls (0.106 USDC was prefunded for one transfer in test 0.2).
    static let minGas = BigUInt(500_000)

    /// Reads the setup state of `owner` on Arc.
    static func read(owner: String) async throws -> SetupState {
        let rpc = ArcRpc()
        let user = try address(owner)
        async let supplied = rpc.call(Abis.aaveSpoke, at: Deployment.aaveSpoke, "getUserSuppliedAssets", [BigUInt(Deployment.cirBtcReserveId), user])
        async let held = rpc.call(Abis.erc20, at: Deployment.cirBtc, "balanceOf", [user])
        async let status = rpc.call(Abis.aaveSpoke, at: Deployment.aaveSpoke, "getUserReserveStatus", [BigUInt(Deployment.cirBtcReserveId), user])
        async let taker = rpc.call(Abis.aaveSpoke, at: Deployment.aaveSpoke, "isPositionManager", [user, try address(Deployment.aaveTaker)])
        async let giver = rpc.call(Abis.aaveSpoke, at: Deployment.aaveSpoke, "isPositionManager", [user, try address(Deployment.aaveGiver)])
        async let accountOut = rpc.call(Abis.factory, at: Deployment.factory, "accountOf", [user])
        async let allowance = rpc.call(
            Abis.aaveTaker, at: Deployment.aaveTaker, "borrowAllowance",
            [try address(Deployment.aaveSpoke), BigUInt(Deployment.usdcReserveId), user, try address(Deployment.aaveAdapter)]
        )
        async let defaultCap = rpc.call(Abis.factory, at: Deployment.factory, "defaultPerPaymentCap")
        async let gas = rpc.call(Abis.erc20, at: Deployment.usdc, "balanceOf", [user])

        let accountAddress = (try await accountOut)["0"] as? EthereumAddress
        let account = accountAddress.flatMap { BigUInt($0.address.dropFirst(2), radix: 16) == 0 ? nil : $0.address }
        // Once the account exists, its own cap counts: the owner may have raised it.
        var cap = (try await defaultCap)["0"] as? BigUInt ?? 0
        if let account {
            cap = (try await rpc.call(Abis.account, at: account, "caps"))["perPayment"] as? BigUInt ?? cap
        }
        return SetupState(
            collateral: (try await supplied)["0"] as? BigUInt ?? 0,
            walletCirBtc: (try await held)["0"] as? BigUInt ?? 0,
            collateralEnabled: (try await status)["0"] as? Bool ?? false,
            takerApproved: (try await taker)["0"] as? Bool ?? false,
            giverApproved: (try await giver)["0"] as? Bool ?? false,
            account: account,
            borrowAllowance: (try await allowance)["0"] as? BigUInt ?? 0,
            perPaymentCap: cap,
            gasBalance: (try await gas)["0"] as? BigUInt ?? 0
        )
    }

    /// The calls that bring `owner` from `state` to ready, in order; empty when ready.
    static func calls(state: SetupState, owner: String) throws -> [(to: String, data: Data)] {
        let user = try address(owner)
        let cirBtcReserve = BigUInt(Deployment.cirBtcReserveId)
        var calls: [(to: String, data: Data)] = []
        if state.walletCirBtc > 0 {
            calls.append((Deployment.cirBtc, try encode(Abis.erc20, "approve", [try address(Deployment.aaveSpoke), state.walletCirBtc])))
            calls.append((Deployment.aaveSpoke, try encode(Abis.aaveSpoke, "supply", [cirBtcReserve, state.walletCirBtc, user])))
        }
        if !state.collateralEnabled && state.funded {
            calls.append((Deployment.aaveSpoke, try encode(Abis.aaveSpoke, "setUsingAsCollateral", [cirBtcReserve, true, user])))
        }
        if !state.takerApproved {
            calls.append((Deployment.aaveSpoke, try encode(Abis.aaveSpoke, "setUserPositionManager", [try address(Deployment.aaveTaker), true])))
        }
        if !state.giverApproved {
            calls.append((Deployment.aaveSpoke, try encode(Abis.aaveSpoke, "setUserPositionManager", [try address(Deployment.aaveGiver), true])))
        }
        if state.account == nil {
            calls.append((Deployment.factory, try encode(Abis.factory, "createAccount", [])))
        }
        // Renewed once it no longer covers a full payment, not only when empty.
        if state.borrowAllowance < state.perPaymentCap {
            calls.append((Deployment.aaveTaker, try encode(
                Abis.aaveTaker, "approveBorrow",
                [try address(Deployment.aaveSpoke), BigUInt(Deployment.usdcReserveId), try address(Deployment.aaveAdapter), borrowCap]
            )))
        }
        return calls
    }

    private static func encode(_ abi: String, _ method: String, _ parameters: [Any]) throws -> Data {
        guard let data = try Contracts.contract(abi).method(method, parameters: parameters, extraData: nil) else {
            throw ChainError.encoding(method)
        }
        return data
    }

    private static func address(_ value: String) throws -> EthereumAddress {
        guard let parsed = EthereumAddress(value) else { throw ChainError.invalidAddress(value) }
        return parsed
    }
}
