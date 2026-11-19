// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {IArdoiseFactory} from "../interfaces/IArdoiseFactory.sol";
import {IVenue} from "../interfaces/IVenue.sol";
import {IMorpho, IMorphoIrm, IMorphoOracle, Market, MarketParams} from "./morpho/IMorpho.sol";

/// @title MorphoAdapter
/// @notice `IVenue` for one Morpho market (cirBTC/USDC on Arc): borrows its loan token against
/// the user's collateral in that market.
/// @dev The user's position stays in Morpho under the user's own address. The user supplies
/// collateral with `supplyCollateral(params, amount, user, "")` and authorizes this adapter with
/// `setAuthorization(adapter, true)`. Morpho's authorization is not capped: an authorized address
/// may borrow and withdraw collateral for the user. This adapter has no function that withdraws
/// collateral, and only `factory.accountOf(user)` may make it borrow, so the authorization can
/// only be used for the account's own payments, within the account's caps and the guard. See
/// docs/api.md.
contract MorphoAdapter is IVenue {
    uint256 private constant WAD = 1e18;
    /// @dev Morpho's oracle prices are scaled by 1e36.
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    /// @dev Morpho's virtual shares and assets (SharesMathLib), used to convert borrow shares.
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    /// @inheritdoc IVenue
    IArdoiseFactory public immutable factory;
    /// @notice The Morpho contract holding every market.
    IMorpho public immutable morpho;
    /// @notice Id of the market this adapter borrows from.
    bytes32 public immutable marketId;
    /// @inheritdoc IVenue
    address public immutable asset;
    /// @notice The market's collateral token.
    address public immutable collateralToken;
    /// @notice The market's oracle, interest rate model and liquidation LTV (WAD).
    address public immutable oracle;
    address public immutable irm;
    uint256 public immutable lltv;
    /// @notice Decimals of the loan token.
    uint8 public immutable assetDecimals;

    /// @notice Thrown when a token transfer or approval returns false.
    error TokenCallFailed();

    /// @notice Thrown by the constructor when `marketId` is not a created Morpho market.
    /// @param marketId The id.
    error UnknownMarket(bytes32 marketId);

    /// @notice Thrown by the constructor for a loan token with more than 18 decimals.
    /// @param decimals The loan token's decimals.
    error UnsupportedDecimals(uint8 decimals);

    /// @notice Reads the market's parameters from Morpho, so they cannot be misconfigured.
    /// @param factory_ Registry of Ardoise accounts allowed to borrow.
    /// @param morpho_ The Morpho contract.
    /// @param marketId_ The market to borrow from.
    constructor(IArdoiseFactory factory_, IMorpho morpho_, bytes32 marketId_) {
        factory = factory_;
        morpho = morpho_;
        marketId = marketId_;
        (address loanToken, address collateral, address oracle_, address irm_, uint256 lltv_) =
            morpho_.idToMarketParams(marketId_);
        if (loanToken == address(0)) revert UnknownMarket(marketId_);
        uint8 decimals = IERC20(loanToken).decimals();
        if (decimals > 18) revert UnsupportedDecimals(decimals);
        asset = loanToken;
        collateralToken = collateral;
        oracle = oracle_;
        irm = irm_;
        lltv = lltv_;
        assetDecimals = decimals;
    }

    /// @inheritdoc IVenue
    function name() external pure returns (string memory) {
        return "Morpho";
    }

    /// @inheritdoc IVenue
    /// @dev The interest rate model's per-second rate for the market as last accrued, scaled to
    /// a yearly APR, as the app shows it.
    function rate() external view returns (uint256 rateBps) {
        if (irm == address(0)) return 0;
        return IMorphoIrm(irm).borrowRateView(_params(), _market()) * SECONDS_PER_YEAR * 10_000 / WAD;
    }

    /// @inheritdoc IVenue
    /// @dev The market's supply minus its borrows, interest included: Morpho lends a market's
    /// supply only to that market's borrowers.
    function available() external view returns (uint256 amount) {
        // Accrued interest raises supply and borrows alike, so the last accrual's totals give
        // the same difference without asking the interest rate model.
        Market memory m = _market();
        return m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0;
    }

    /// @inheritdoc IVenue
    /// @dev Morpho's oracle prices the collateral in loan token, not in USD: values here count
    /// one unit of the loan token (USDC) as one dollar.
    function health(address user) external view returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd) {
        (uint256 collateral, uint256 debt) = _position(user);
        uint256 collateralValue = collateral * IMorphoOracle(oracle).price() / ORACLE_PRICE_SCALE;
        uint256 toWad = 10 ** (18 - assetDecimals);
        // Whole loan-token units, scaled up: no precision a loan token does not have is lost.
        // forge-lint: disable-next-line(divide-before-multiply)
        collateralUsd = collateralValue * toWad;
        debtUsd = debt * toWad;
        healthFactor = _healthFactor(collateral, debt);
    }

    /// @inheritdoc IVenue
    /// @dev Morpho's own health test: collateral x price x LLTV against the debt, liquidation
    /// below 1.0. The debt includes the interest accrued since the market's last update. The
    /// extra debt is counted as assets, while Morpho rounds the shares of a new borrow up, so the
    /// debt after a borrow may exceed the projection by a few wei.
    function healthAfter(address user, uint256 extraDebt) external view returns (uint256 healthFactor) {
        (uint256 collateral, uint256 debt) = _position(user);
        if (collateral == 0) return 0;
        return _healthFactor(collateral, debt + extraDebt);
    }

    /// @inheritdoc IVenue
    function debtOf(address user) external view returns (uint256 amount) {
        (, amount) = _position(user);
    }

    /// @inheritdoc IVenue
    function borrow(address user, uint256 amount) external returns (uint256 borrowed) {
        // The user's Morpho authorization is granted to this shared adapter: only the user's own
        // account, as recorded by the factory, may use it.
        if (address(factory.accountOf(user)) != msg.sender) revert UnauthorizedCaller(msg.sender, user);
        // forge-lint: disable-next-line(unused-return)
        (borrowed,) = morpho.borrow(_params(), amount, 0, user, msg.sender);
        // The only external call is the trusted Morpho contract.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Borrowed(user, msg.sender, borrowed);
    }

    /// @inheritdoc IVenue
    /// @dev Accrues interest first, so the debt is exact. A full repayment is made by shares,
    /// which clears the position without leaving dust; Morpho pulls exactly the debt in that
    /// case. Whatever Morpho did not pull goes back to the payer.
    function repay(address user, uint256 amount) external returns (uint256 repaid) {
        MarketParams memory params = _params();
        morpho.accrueInterest(params);
        // forge-lint: disable-next-line(unused-return)
        (, uint128 borrowShares,) = morpho.position(marketId, user);
        Market memory m = _market();
        uint256 debt = _toAssetsUp(borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
        uint256 toRepay = amount < debt ? amount : debt;
        if (toRepay == 0) return 0;
        IERC20 token = IERC20(asset);
        uint256 balanceBefore = token.balanceOf(address(this));
        _call(token.transferFrom(msg.sender, address(this), toRepay));
        _call(token.approve(address(morpho), toRepay));
        // forge-lint: disable-next-line(unused-return)
        (repaid,) = toRepay == debt
            ? morpho.repay(params, 0, borrowShares, user, "")
            : morpho.repay(params, toRepay, 0, user, "");
        uint256 unused = token.balanceOf(address(this)) - balanceBefore;
        if (unused > 0) {
            _call(token.approve(address(morpho), 0));
            _call(token.transfer(msg.sender, unused));
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit Repaid(user, msg.sender, repaid);
    }

    /// @dev The market's parameters.
    function _params() private view returns (MarketParams memory) {
        return MarketParams({loanToken: asset, collateralToken: collateralToken, oracle: oracle, irm: irm, lltv: lltv});
    }

    /// @dev The market's totals as of its last accrual.
    function _market() private view returns (Market memory m) {
        (m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee) =
            morpho.market(marketId);
    }

    /// @dev The market's totals with the interest accrued since its last update, as Morpho's
    /// `accrueInterest` would compute them (MorphoBalancesLib.expectedMarketBalances, borrow side).
    function _expectedMarket() private view returns (Market memory m) {
        m = _market();
        uint256 elapsed = block.timestamp - m.lastUpdate;
        // Interest accrues per second, as in Morpho itself; a validator's few seconds of drift
        // change the estimate by that much interest only.
        // forge-lint: disable-next-line(block-timestamp)
        if (elapsed == 0 || m.totalBorrowAssets == 0 || irm == address(0)) return m;
        uint256 borrowRate = IMorphoIrm(irm).borrowRateView(_params(), m);
        uint256 interest = uint256(m.totalBorrowAssets) * _wTaylorCompounded(borrowRate, elapsed) / WAD;
        // Bounded by Morpho's own uint128 totals for any realistic rate and period.
        // forge-lint: disable-next-line(unsafe-typecast)
        m.totalBorrowAssets += uint128(interest);
        // forge-lint: disable-next-line(unsafe-typecast)
        m.totalSupplyAssets += uint128(interest);
    }

    /// @dev The user's collateral and debt, interest included.
    function _position(address user) private view returns (uint256 collateral, uint256 debt) {
        // forge-lint: disable-next-line(unused-return)
        (, uint128 borrowShares, uint128 collateral_) = morpho.position(marketId, user);
        Market memory m = _expectedMarket();
        return (collateral_, _toAssetsUp(borrowShares, m.totalBorrowAssets, m.totalBorrowShares));
    }

    /// @dev Health factor (WAD) of a position: the most it may borrow at the LLTV over its debt.
    function _healthFactor(uint256 collateral, uint256 debt) private view returns (uint256) {
        if (debt == 0) return type(uint256).max;
        // Rounded in the same order as Morpho's `_isHealthy`, so the result matches its test:
        // a position is borrowable exactly when this is at least 1e18.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 maxBorrow = collateral * IMorphoOracle(oracle).price() / ORACLE_PRICE_SCALE * lltv / WAD;
        // forge-lint: disable-next-line(divide-before-multiply)
        return maxBorrow * WAD / debt;
    }

    /// @dev Morpho's SharesMathLib.toAssetsUp.
    function _toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) private pure returns (uint256) {
        uint256 numerator = shares * (totalAssets + VIRTUAL_ASSETS);
        uint256 denominator = totalShares + VIRTUAL_SHARES;
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }

    /// @dev Morpho's MathLib.wTaylorCompounded: e^(x*n) - 1 to the third order.
    function _wTaylorCompounded(uint256 x, uint256 n) private pure returns (uint256) {
        uint256 firstTerm = x * n;
        uint256 secondTerm = firstTerm * firstTerm / (2 * WAD);
        // Same rounding as Morpho's MathLib, so the estimate matches its accrual.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 thirdTerm = secondTerm * firstTerm / (3 * WAD);
        return firstTerm + secondTerm + thirdTerm;
    }

    /// @dev Reverts with `TokenCallFailed` when a token call returned false.
    function _call(bool ok) private pure {
        if (!ok) revert TokenCallFailed();
    }
}
