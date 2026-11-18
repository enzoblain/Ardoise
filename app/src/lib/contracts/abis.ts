/**
 * ABIs of the deployed Ardoise contracts, copied from the Foundry build
 * (`forge build`, `contracts/out/<Contract>.sol/<Contract>.json`), one entry
 * per line. Regenerate them when a contract changes; the interfaces in
 * contracts/src/interfaces/ are frozen, so only additions are expected.
 */

/** `ArdoiseAccount`. */
export const accountAbi = [
  {"type": "function", "name": "ARC_DOMAIN", "inputs": [], "outputs": [{"name": "", "type": "uint32", "internalType": "uint32"}], "stateMutability": "pure"},
  {"type": "function", "name": "bestVenue", "inputs": [{"name": "amount", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "venue", "type": "address", "internalType": "contract IVenue"}], "stateMutability": "view"},
  {"type": "function", "name": "caps", "inputs": [], "outputs": [{"name": "perPayment", "type": "uint256", "internalType": "uint256"}, {"name": "daily", "type": "uint256", "internalType": "uint256"}, {"name": "spentToday", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "closed", "inputs": [{"name": "lineId", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "", "type": "bool", "internalType": "bool"}], "stateMutability": "view"},
  {"type": "function", "name": "factory", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IArdoiseFactory"}], "stateMutability": "view"},
  {"type": "function", "name": "guard", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IGuard"}], "stateMutability": "view"},
  {"type": "function", "name": "health", "inputs": [{"name": "venue", "type": "address", "internalType": "contract IVenue"}], "outputs": [{"name": "healthFactor", "type": "uint256", "internalType": "uint256"}, {"name": "collateralUsd", "type": "uint256", "internalType": "uint256"}, {"name": "debtUsd", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "line", "inputs": [{"name": "lineId", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "", "type": "tuple", "internalType": "struct DebtLine", "components": [{"name": "id", "type": "uint256", "internalType": "uint256"}, {"name": "venue", "type": "address", "internalType": "contract IVenue"}, {"name": "principal", "type": "uint256", "internalType": "uint256"}, {"name": "repaid", "type": "uint256", "internalType": "uint256"}, {"name": "accruedInterest", "type": "uint256", "internalType": "uint256"}, {"name": "rateBps", "type": "uint32", "internalType": "uint32"}, {"name": "destinationDomain", "type": "uint32", "internalType": "uint32"}, {"name": "openedAt", "type": "uint64", "internalType": "uint64"}, {"name": "payee", "type": "bytes32", "internalType": "bytes32"}, {"name": "memo", "type": "string", "internalType": "string"}]}], "stateMutability": "view"},
  {"type": "function", "name": "lines", "inputs": [], "outputs": [{"name": "all", "type": "tuple[]", "internalType": "struct DebtLine[]", "components": [{"name": "id", "type": "uint256", "internalType": "uint256"}, {"name": "venue", "type": "address", "internalType": "contract IVenue"}, {"name": "principal", "type": "uint256", "internalType": "uint256"}, {"name": "repaid", "type": "uint256", "internalType": "uint256"}, {"name": "accruedInterest", "type": "uint256", "internalType": "uint256"}, {"name": "rateBps", "type": "uint32", "internalType": "uint32"}, {"name": "destinationDomain", "type": "uint32", "internalType": "uint32"}, {"name": "openedAt", "type": "uint64", "internalType": "uint64"}, {"name": "payee", "type": "bytes32", "internalType": "bytes32"}, {"name": "memo", "type": "string", "internalType": "string"}]}], "stateMutability": "view"},
  {"type": "function", "name": "minFinalityThreshold", "inputs": [], "outputs": [{"name": "", "type": "uint32", "internalType": "uint32"}], "stateMutability": "view"},
  {"type": "function", "name": "owner", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "pay", "inputs": [{"name": "amount", "type": "uint256", "internalType": "uint256"}, {"name": "destinationDomain", "type": "uint32", "internalType": "uint32"}, {"name": "payee", "type": "bytes32", "internalType": "bytes32"}, {"name": "maxFee", "type": "uint256", "internalType": "uint256"}, {"name": "memo", "type": "string", "internalType": "string"}], "outputs": [{"name": "lineId", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "repay", "inputs": [{"name": "lineId", "type": "uint256", "internalType": "uint256"}, {"name": "amount", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "repaid", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "setCaps", "inputs": [{"name": "perPayment", "type": "uint256", "internalType": "uint256"}, {"name": "daily", "type": "uint256", "internalType": "uint256"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "sweep", "inputs": [], "outputs": [{"name": "repaid", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "tokenMessenger", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract ITokenMessengerV2"}], "stateMutability": "view"},
  {"type": "function", "name": "usdc", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IERC20"}], "stateMutability": "view"},
  {"type": "function", "name": "venues", "inputs": [], "outputs": [{"name": "", "type": "address[]", "internalType": "contract IVenue[]"}], "stateMutability": "view"},
  {"type": "event", "name": "CapsUpdated", "inputs": [{"name": "perPayment", "type": "uint256", "indexed": false, "internalType": "uint256"}, {"name": "daily", "type": "uint256", "indexed": false, "internalType": "uint256"}], "anonymous": false},
  {"type": "event", "name": "LineRepaid", "inputs": [{"name": "lineId", "type": "uint256", "indexed": true, "internalType": "uint256"}, {"name": "payer", "type": "address", "indexed": true, "internalType": "address"}, {"name": "amount", "type": "uint256", "indexed": false, "internalType": "uint256"}], "anonymous": false},
  {"type": "event", "name": "Paid", "inputs": [{"name": "lineId", "type": "uint256", "indexed": true, "internalType": "uint256"}, {"name": "venue", "type": "address", "indexed": true, "internalType": "contract IVenue"}, {"name": "amount", "type": "uint256", "indexed": false, "internalType": "uint256"}, {"name": "maxFee", "type": "uint256", "indexed": false, "internalType": "uint256"}, {"name": "borrowed", "type": "uint256", "indexed": false, "internalType": "uint256"}, {"name": "rateBps", "type": "uint32", "indexed": false, "internalType": "uint32"}, {"name": "destinationDomain", "type": "uint32", "indexed": false, "internalType": "uint32"}, {"name": "payee", "type": "bytes32", "indexed": false, "internalType": "bytes32"}, {"name": "memo", "type": "string", "indexed": false, "internalType": "string"}], "anonymous": false},
  {"type": "error", "name": "BorrowShortfall", "inputs": [{"name": "expected", "type": "uint256", "internalType": "uint256"}, {"name": "received", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "CapExceeded", "inputs": [{"name": "amount", "type": "uint256", "internalType": "uint256"}, {"name": "remaining", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "FeeOnArc", "inputs": [{"name": "maxFee", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "GuardNotSet", "inputs": []},
  {"type": "error", "name": "InvalidPayee", "inputs": [{"name": "payee", "type": "bytes32", "internalType": "bytes32"}]},
  {"type": "error", "name": "LineAlreadyRepaid", "inputs": [{"name": "lineId", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "NoVenueAvailable", "inputs": [{"name": "amount", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "NotOwner", "inputs": [{"name": "caller", "type": "address", "internalType": "address"}]},
  {"type": "error", "name": "PaymentRefused", "inputs": [{"name": "requested", "type": "uint256", "internalType": "uint256"}, {"name": "allowed", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "Reentrancy", "inputs": []},
  {"type": "error", "name": "TokenCallFailed", "inputs": []},
  {"type": "error", "name": "UnknownLine", "inputs": [{"name": "lineId", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "ZeroAmount", "inputs": []},
] as const;

/** `ArdoiseFactory`. */
export const factoryAbi = [
  {"type": "function", "name": "accountOf", "inputs": [{"name": "owner", "type": "address", "internalType": "address"}], "outputs": [{"name": "account", "type": "address", "internalType": "contract IArdoise"}], "stateMutability": "view"},
  {"type": "function", "name": "admin", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "createAccount", "inputs": [], "outputs": [{"name": "account", "type": "address", "internalType": "contract IArdoise"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "defaultDailyCap", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "defaultPerPaymentCap", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "guard", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IGuard"}], "stateMutability": "view"},
  {"type": "function", "name": "minFinalityThreshold", "inputs": [], "outputs": [{"name": "", "type": "uint32", "internalType": "uint32"}], "stateMutability": "view"},
  {"type": "function", "name": "setGuard", "inputs": [{"name": "newGuard", "type": "address", "internalType": "contract IGuard"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "setVenues", "inputs": [{"name": "newVenues", "type": "address[]", "internalType": "contract IVenue[]"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "tokenMessenger", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract ITokenMessengerV2"}], "stateMutability": "view"},
  {"type": "function", "name": "usdc", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IERC20"}], "stateMutability": "view"},
  {"type": "function", "name": "venues", "inputs": [], "outputs": [{"name": "", "type": "address[]", "internalType": "contract IVenue[]"}], "stateMutability": "view"},
  {"type": "event", "name": "AccountCreated", "inputs": [{"name": "owner", "type": "address", "indexed": true, "internalType": "address"}, {"name": "account", "type": "address", "indexed": true, "internalType": "contract IArdoise"}], "anonymous": false},
  {"type": "event", "name": "GuardUpdated", "inputs": [{"name": "guard", "type": "address", "indexed": false, "internalType": "contract IGuard"}], "anonymous": false},
  {"type": "event", "name": "VenuesUpdated", "inputs": [{"name": "venues", "type": "address[]", "indexed": false, "internalType": "contract IVenue[]"}], "anonymous": false},
  {"type": "error", "name": "AccountExists", "inputs": [{"name": "account", "type": "address", "internalType": "contract IArdoise"}]},
  {"type": "error", "name": "InvalidVenue", "inputs": [{"name": "venue", "type": "address", "internalType": "contract IVenue"}]},
  {"type": "error", "name": "NotAdmin", "inputs": [{"name": "caller", "type": "address", "internalType": "address"}]},
  {"type": "error", "name": "ZeroAddress", "inputs": []},
] as const;

/** `AaveV4Adapter`. */
export const venueAbi = [
  {"type": "function", "name": "asset", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "assetDecimals", "inputs": [], "outputs": [{"name": "", "type": "uint8", "internalType": "uint8"}], "stateMutability": "view"},
  {"type": "function", "name": "assetId", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "available", "inputs": [], "outputs": [{"name": "amount", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "borrow", "inputs": [{"name": "user", "type": "address", "internalType": "address"}, {"name": "amount", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "borrowed", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "debtOf", "inputs": [{"name": "user", "type": "address", "internalType": "address"}], "outputs": [{"name": "amount", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "factory", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IArdoiseFactory"}], "stateMutability": "view"},
  {"type": "function", "name": "giver", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IAaveV4GiverPositionManager"}], "stateMutability": "view"},
  {"type": "function", "name": "health", "inputs": [{"name": "user", "type": "address", "internalType": "address"}], "outputs": [{"name": "healthFactor", "type": "uint256", "internalType": "uint256"}, {"name": "collateralUsd", "type": "uint256", "internalType": "uint256"}, {"name": "debtUsd", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "healthAfter", "inputs": [{"name": "user", "type": "address", "internalType": "address"}, {"name": "extraDebt", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "healthFactor", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "hub", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IAaveV4Hub"}], "stateMutability": "view"},
  {"type": "function", "name": "name", "inputs": [], "outputs": [{"name": "", "type": "string", "internalType": "string"}], "stateMutability": "pure"},
  {"type": "function", "name": "oracle", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IAaveV4Oracle"}], "stateMutability": "view"},
  {"type": "function", "name": "rate", "inputs": [], "outputs": [{"name": "rateBps", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "repay", "inputs": [{"name": "user", "type": "address", "internalType": "address"}, {"name": "amount", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "repaid", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "reserveId", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "spoke", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IAaveV4Spoke"}], "stateMutability": "view"},
  {"type": "function", "name": "taker", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IAaveV4TakerPositionManager"}], "stateMutability": "view"},
  {"type": "event", "name": "Borrowed", "inputs": [{"name": "user", "type": "address", "indexed": true, "internalType": "address"}, {"name": "account", "type": "address", "indexed": true, "internalType": "address"}, {"name": "amount", "type": "uint256", "indexed": false, "internalType": "uint256"}], "anonymous": false},
  {"type": "event", "name": "Repaid", "inputs": [{"name": "user", "type": "address", "indexed": true, "internalType": "address"}, {"name": "payer", "type": "address", "indexed": true, "internalType": "address"}, {"name": "amount", "type": "uint256", "indexed": false, "internalType": "uint256"}], "anonymous": false},
  {"type": "error", "name": "TokenCallFailed", "inputs": []},
  {"type": "error", "name": "UnauthorizedCaller", "inputs": [{"name": "caller", "type": "address", "internalType": "address"}, {"name": "user", "type": "address", "internalType": "address"}]},
  {"type": "error", "name": "UnsupportedDecimals", "inputs": [{"name": "decimals", "type": "uint8", "internalType": "uint8"}]},
] as const;

/** `MarginGuard`. */
export const guardAbi = [
  {"type": "function", "name": "LIQUIDATION_HEALTH_FACTOR", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "MAX_SIMULATED_DROP_BPS", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "checkMargin", "inputs": [{"name": "user", "type": "address", "internalType": "address"}, {"name": "venue", "type": "address", "internalType": "contract IVenue"}, {"name": "amount", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "allowed", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "minHealthFactor", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "owner", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "setSimulatedDrop", "inputs": [{"name": "dropBps", "type": "uint256", "internalType": "uint256"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "setThresholds", "inputs": [{"name": "minHealthFactor_", "type": "uint256", "internalType": "uint256"}, {"name": "targetHealthFactor_", "type": "uint256", "internalType": "uint256"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "simulatedDropBps", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "simulatedHealth", "inputs": [{"name": "venue", "type": "address", "internalType": "contract IVenue"}, {"name": "user", "type": "address", "internalType": "address"}], "outputs": [{"name": "healthFactor", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "targetHealthFactor", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "event", "name": "SimulationUpdated", "inputs": [{"name": "dropBps", "type": "uint256", "indexed": false, "internalType": "uint256"}], "anonymous": false},
  {"type": "event", "name": "ThresholdsUpdated", "inputs": [{"name": "minHealthFactor", "type": "uint256", "indexed": false, "internalType": "uint256"}, {"name": "targetHealthFactor", "type": "uint256", "indexed": false, "internalType": "uint256"}], "anonymous": false},
  {"type": "error", "name": "InvalidSimulatedDrop", "inputs": [{"name": "dropBps", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "InvalidThresholds", "inputs": [{"name": "minHealthFactor", "type": "uint256", "internalType": "uint256"}, {"name": "targetHealthFactor", "type": "uint256", "internalType": "uint256"}]},
  {"type": "error", "name": "NotOwner", "inputs": [{"name": "caller", "type": "address", "internalType": "address"}]},
  {"type": "error", "name": "ZeroOwner", "inputs": []},
] as const;
