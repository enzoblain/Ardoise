import BigInt
import Foundation
import Web3Core

/// Read-only access to Arc mainnet: `eth_call` on a contract, with the ABI
/// encoding and decoding done by web3swift.
struct ArcRpc: Sendable {
    let url: URL

    init(url: URL = Deployment.arcRpc) {
        self.url = url
    }

    /// Calls a view function and returns its decoded outputs, keyed by output
    /// name and by position ("0", "1"…).
    ///
    /// - Parameters:
    ///   - abi: The contract's ABI (JSON).
    ///   - address: The contract.
    ///   - method: Function name.
    ///   - parameters: Arguments, as web3swift expects them (`EthereumAddress`, `BigUInt`…).
    /// - Returns: The decoded outputs.
    /// - Throws: `ChainError.reverted` with the decoded contract error when the
    ///   call reverts, `ChainError.rpc` for any other failure.
    func call(_ abi: String, at address: String, _ method: String, _ parameters: [Any] = []) async throws -> [String: Any] {
        let contract = try Contracts.contract(abi, at: address)
        guard let data = contract.method(method, parameters: parameters, extraData: nil) else {
            throw ChainError.encoding(method)
        }
        let result = try await ethCall(to: address, data: data)
        switch result {
        case .success(let output):
            return try contract.decodeReturnData(method, data: output)
        case .failure(let revertData):
            throw ChainError.reverted(Contracts.describeRevert(revertData, abi: abi))
        }
    }

    private enum CallResult {
        case success(Data)
        case failure(Data)
    }

    private func ethCall(to: String, data: Data) async throws -> CallResult {
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [["to": to, "data": data.toHexString().addHexPrefix()], "latest"],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ChainError.rpc("Arc RPC answered \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any] else {
            throw ChainError.rpc("Arc RPC returned no JSON")
        }
        if let error = json["error"] as? [String: Any] {
            // A revert carries the contract error in `data`.
            if let revert = error["data"] as? String, let revertData = Data.fromHex(revert) {
                return .failure(revertData)
            }
            throw ChainError.rpc(error["message"] as? String ?? "Arc RPC error")
        }
        guard let hex = json["result"] as? String, let output = Data.fromHex(hex) else {
            throw ChainError.rpc("Arc RPC returned no result")
        }
        return .success(output)
    }
}

/// ABI helpers shared by reads and the payment call.
enum Contracts {
    /// Parses an ABI, optionally bound to an address.
    static func contract(_ abi: String, at address: String? = nil) throws -> EthereumContract {
        try EthereumContract(abi, at: address.flatMap { EthereumAddress($0) })
    }

    /// The name of the contract error in revert data, with its arguments when
    /// the ABI declares it.
    static func describeRevert(_ data: Data, abi: String) -> String {
        guard let contract = try? contract(abi),
              let decoded = contract.decodeEthError(data),
              let name = contract.errors.first(where: { $0.value.methodEncoding == data.prefix(4) })?.key else {
            return data.isEmpty ? "reverted" : "reverted with \(data.prefix(4).toHexString().addHexPrefix())"
        }
        let args = decoded.filter { Int($0.key) == nil && $0.key != "_abiErrorName" }
            .sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value)" }
        return args.isEmpty ? name : "\(name)(\(args.joined(separator: ", ")))"
    }

    /// Left-pads an EVM address to the bytes32 payee CCTP and `payVia` take.
    static func payeeBytes32(_ address: String) throws -> Data {
        guard let parsed = EthereumAddress(address) else { throw ChainError.invalidAddress(address) }
        return Data(repeating: 0, count: 12) + parsed.addressData
    }
}

/// Errors from Arc reads and payments, worded for the screen.
enum ChainError: LocalizedError {
    case rpc(String)
    case reverted(String)
    case encoding(String)
    case invalidAddress(String)

    var errorDescription: String? {
        switch self {
        case .rpc(let message): return message
        case .reverted(let reason): return "The contract refused: \(reason)"
        case .encoding(let method): return "Could not encode \(method)"
        case .invalidAddress(let address): return "\(address) is not a valid address"
        }
    }
}
