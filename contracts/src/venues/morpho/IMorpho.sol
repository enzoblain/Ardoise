// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Parameters identifying a Morpho market; its id is `keccak256(abi.encode(params))`.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice A Morpho market's totals, as `IMorpho.market` returns them.
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

/// @title IMorpho
/// @notice The part of Morpho (Morpho Blue) the adapter uses, from
/// https://github.com/morpho-org/morpho-blue/blob/main/src/interfaces/IMorpho.sol.
interface IMorpho {
    /// @notice Parameters of the market `id`.
    function idToMarketParams(bytes32 id)
        external
        view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);

    /// @notice Totals of the market `id`, as of its last interest accrual.
    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );

    /// @notice Position of `user` in the market `id`.
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    /// @notice Whether `authorized` may manage `authorizer`'s positions (borrow and withdraw).
    function isAuthorized(address authorizer, address authorized) external view returns (bool);

    /// @notice Supplies `assets` of collateral for `onBehalf`, pulled from the caller (user setup).
    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;

    /// @notice Authorizes (or revokes) `authorized` to manage the caller's positions (user setup).
    function setAuthorization(address authorized, bool newIsAuthorized) external;

    /// @notice Accrues the market's interest up to the current block.
    function accrueInterest(MarketParams memory marketParams) external;

    /// @notice Borrows `assets` (or `shares`) on behalf of `onBehalf`, sent to `receiver`; the
    /// caller must be `onBehalf` or authorized by it.
    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    /// @notice Repays `assets` (or `shares`) of `onBehalf`'s debt, pulled from the caller; anyone
    /// may repay for anyone.
    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);
}

/// @title IMorphoOracle
/// @notice Price of one unit of collateral in units of loan token, scaled by 1e36.
interface IMorphoOracle {
    /// @notice The price.
    function price() external view returns (uint256);
}

/// @title IMorphoIrm
/// @notice A Morpho interest rate model.
interface IMorphoIrm {
    /// @notice Borrow rate per second (WAD) of a market in the given state, without changing it.
    function borrowRateView(MarketParams memory marketParams, Market memory market) external view returns (uint256);
}
