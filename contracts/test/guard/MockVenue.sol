// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoiseFactory} from "../../src/interfaces/IArdoiseFactory.sol";
import {IVenue} from "../../src/interfaces/IVenue.sol";

/// @title MockVenue
/// @notice Test double for a lending venue: positions are set directly by the test, and the
/// health factor follows the usual formula `collateralUsd * liquidationThreshold / debtUsd`.
/// @dev The asset is a 6-decimal dollar stablecoin priced at exactly 1 USD, like USDC. It
/// moves no tokens: `borrow` and `repay` only update the recorded debt.
contract MockVenue is IVenue {
    /// @dev Converts 6-decimal asset amounts to WAD USD values.
    uint256 private constant ASSET_TO_WAD = 1e12;
    uint256 private constant WAD = 1e18;

    /// @notice Share of the collateral value that counts towards the health factor (WAD).
    uint256 public liquidationThreshold;

    mapping(address user => uint256) private _collateralUsd;
    mapping(address user => uint256) private _debt;

    /// @param liquidationThreshold_ Liquidation threshold applied to every position (WAD).
    constructor(uint256 liquidationThreshold_) {
        liquidationThreshold = liquidationThreshold_;
    }

    /// @notice Sets a user's position.
    /// @param user Owner of the position.
    /// @param collateralUsd_ Collateral value in USD (WAD).
    /// @param debt Debt in asset decimals (6).
    function setPosition(address user, uint256 collateralUsd_, uint256 debt) external {
        _collateralUsd[user] = collateralUsd_;
        _debt[user] = debt;
    }

    /// @notice Scales a user's collateral value, as a price move of the collateral would.
    /// @param user Owner of the position.
    /// @param factor Multiplier applied to the collateral value (WAD, 0.8e18 = -20%).
    function movePrice(address user, uint256 factor) external {
        _collateralUsd[user] = _collateralUsd[user] * factor / WAD;
    }

    /// @inheritdoc IVenue
    function factory() external pure returns (IArdoiseFactory) {
        return IArdoiseFactory(address(0));
    }

    /// @inheritdoc IVenue
    function name() external pure returns (string memory) {
        return "Mock venue";
    }

    /// @inheritdoc IVenue
    function asset() external pure returns (address) {
        return address(0);
    }

    /// @inheritdoc IVenue
    function rate() external pure returns (uint256 rateBps) {
        return 500;
    }

    /// @inheritdoc IVenue
    function available() external pure returns (uint256 amount) {
        return type(uint256).max;
    }

    /// @inheritdoc IVenue
    function health(address user)
        external
        view
        returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd)
    {
        collateralUsd = _collateralUsd[user];
        debtUsd = _debt[user] * ASSET_TO_WAD;
        healthFactor = debtUsd == 0 ? type(uint256).max : healthAfter(user, 0);
    }

    /// @inheritdoc IVenue
    function healthAfter(address user, uint256 extraDebt) public view returns (uint256 healthFactor) {
        uint256 collateralUsd = _collateralUsd[user];
        if (collateralUsd == 0) return 0;
        uint256 debtUsd = (_debt[user] + extraDebt) * ASSET_TO_WAD;
        if (debtUsd == 0) return type(uint256).max;
        return collateralUsd * liquidationThreshold / debtUsd;
    }

    /// @inheritdoc IVenue
    function debtOf(address user) external view returns (uint256 amount) {
        return _debt[user];
    }

    /// @inheritdoc IVenue
    function borrow(address user, uint256 amount) external returns (uint256 borrowed) {
        _debt[user] += amount;
        emit Borrowed(user, msg.sender, amount);
        return amount;
    }

    /// @inheritdoc IVenue
    function repay(address user, uint256 amount) external returns (uint256 repaid) {
        uint256 debt = _debt[user];
        repaid = amount > debt ? debt : amount;
        _debt[user] = debt - repaid;
        emit Repaid(user, msg.sender, repaid);
    }
}
