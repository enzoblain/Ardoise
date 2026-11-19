import Foundation

/// The parts of the contract ABIs the app calls, copied from the Foundry build
/// (`contracts/out/`), the same entries as the web app's `abis.ts`.
enum Abis {
    static let factory = """
    [
      {"type":"function","name":"accountOf","stateMutability":"view","inputs":[{"name":"owner","type":"address"}],"outputs":[{"name":"account","type":"address"}]}
    ]
    """

    private static let debtLine = """
    {"name":"","type":"tuple","components":[{"name":"id","type":"uint256"},{"name":"venue","type":"address"},{"name":"principal","type":"uint256"},{"name":"repaid","type":"uint256"},{"name":"accruedInterest","type":"uint256"},{"name":"rateBps","type":"uint32"},{"name":"destinationDomain","type":"uint32"},{"name":"openedAt","type":"uint64"},{"name":"payee","type":"bytes32"},{"name":"memo","type":"string"}]}
    """

    static let account = """
    [
      {"type":"function","name":"guard","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"caps","stateMutability":"view","inputs":[],"outputs":[{"name":"perPayment","type":"uint256"},{"name":"daily","type":"uint256"},{"name":"spentToday","type":"uint256"}]},
      {"type":"function","name":"bestVenue","stateMutability":"view","inputs":[{"name":"amount","type":"uint256"}],"outputs":[{"name":"venue","type":"address"}]},
      {"type":"function","name":"health","stateMutability":"view","inputs":[{"name":"venue","type":"address"}],"outputs":[{"name":"healthFactor","type":"uint256"},{"name":"collateralUsd","type":"uint256"},{"name":"debtUsd","type":"uint256"}]},
      {"type":"function","name":"line","stateMutability":"view","inputs":[{"name":"lineId","type":"uint256"}],"outputs":[\(debtLine)]},
      {"type":"function","name":"payVia","stateMutability":"nonpayable","inputs":[{"name":"venue","type":"address"},{"name":"amount","type":"uint256"},{"name":"destinationDomain","type":"uint32"},{"name":"payee","type":"bytes32"},{"name":"maxFee","type":"uint256"},{"name":"memo","type":"string"}],"outputs":[{"name":"lineId","type":"uint256"}]},
      {"type":"error","name":"PaymentRefused","inputs":[{"name":"requested","type":"uint256"},{"name":"allowed","type":"uint256"}]},
      {"type":"error","name":"CapExceeded","inputs":[{"name":"amount","type":"uint256"},{"name":"remaining","type":"uint256"}]},
      {"type":"error","name":"NoVenueAvailable","inputs":[{"name":"amount","type":"uint256"}]},
      {"type":"error","name":"UnknownVenue","inputs":[{"name":"venue","type":"address"}]},
      {"type":"error","name":"InvalidPayee","inputs":[{"name":"payee","type":"bytes32"}]},
      {"type":"error","name":"UnknownLine","inputs":[{"name":"lineId","type":"uint256"}]}
    ]
    """

    static let venue = """
    [
      {"type":"function","name":"rate","stateMutability":"view","inputs":[],"outputs":[{"name":"rateBps","type":"uint256"}]},
      {"type":"function","name":"available","stateMutability":"view","inputs":[],"outputs":[{"name":"amount","type":"uint256"}]}
    ]
    """

    static let guardAbi = """
    [
      {"type":"function","name":"minHealthFactor","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"checkMargin","stateMutability":"view","inputs":[{"name":"user","type":"address"},{"name":"venue","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"name":"allowed","type":"uint256"}]}
    ]
    """

    static let erc20 = """
    [
      {"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"name":"account","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}
    ]
    """
}
