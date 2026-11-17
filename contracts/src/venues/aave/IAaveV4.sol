// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal views of the Aave V4 contracts the Aave adapter uses, copied from
/// https://github.com/aave/aave-v4 (src/spoke/interfaces/ISpoke.sol, src/hub/interfaces/IHub.sol,
/// src/position-manager/). Only the members the adapter calls are declared.

/// @notice Aave V4 Spoke (the Arc Main Spoke holds the user positions).
interface IAaveV4Spoke {
    /// @dev `flags` is a packed `ReserveFlags` value type in Aave V4; it ABI-encodes as uint8.
    struct Reserve {
        address underlying;
        address hub;
        uint16 assetId;
        uint8 decimals;
        uint24 collateralRisk;
        uint8 flags;
        uint32 dynamicConfigKey;
    }

    /// @dev Values are in "units of Value": 1e26 per USD (oracle price with 8 decimals, scaled to
    /// 18 decimals). `healthFactor` and `avgCollateralFactor` are WAD; `riskPremium` is BPS.
    struct UserAccountData {
        uint256 riskPremium;
        uint256 avgCollateralFactor;
        uint256 healthFactor;
        uint256 totalCollateralValue;
        uint256 totalDebtValueRay;
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    /// @return The reserve's configuration (underlying token, hub, hub asset id, decimals).
    function getReserve(uint256 reserveId) external view returns (Reserve memory);
    /// @return The user's position across every reserve of the Spoke.
    function getUserAccountData(address user) external view returns (UserAccountData memory);
    /// @return The user's debt on `reserveId`, drawn and premium, in token decimals.
    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);
    /// @return The Spoke oracle.
    function ORACLE() external view returns (address);
}

/// @notice Aave V4 Hub (pools the liquidity lent to every spoke).
interface IAaveV4Hub {
    struct SpokeData {
        uint120 drawnShares;
        uint120 premiumShares;
        int200 premiumOffsetRay;
        uint120 addedShares;
        uint40 addCap;
        uint40 drawCap;
        uint24 riskPremiumThreshold;
        bool active;
        bool halted;
        uint200 deficitRay;
    }

    /// @return Yearly drawn (borrow) rate, RAY.
    function getAssetDrawnRate(uint256 assetId) external view returns (uint256);
    /// @return Liquidity of the asset the Hub can lend right now, in token decimals.
    function getAssetLiquidity(uint256 assetId) external view returns (uint256);
    /// @return The spoke's configuration for the asset; caps are in whole tokens.
    function getSpoke(uint256 assetId, address spoke) external view returns (SpokeData memory);
    /// @return What the spoke owes the Hub for the asset (drawn, premium, deficit), token decimals.
    function getSpokeTotalOwed(uint256 assetId, address spoke) external view returns (uint256);
    /// @return The cap value meaning "no cap".
    function MAX_ALLOWED_SPOKE_CAP() external view returns (uint40);
}

/// @notice Aave V4 oracle of a spoke.
interface IAaveV4Oracle {
    /// @return Price of the reserve's asset in USD, 8 decimals.
    function getReservePrice(uint256 reserveId) external view returns (uint256);
}

/// @notice Aave V4 position manager that borrows on a user's behalf within an allowance.
interface IAaveV4TakerPositionManager {
    /// @notice Borrows on the Spoke for `onBehalfOf`, spending the allowance `onBehalfOf` granted
    /// to the caller, and sends the tokens to the caller.
    /// @return shares Drawn shares added.
    /// @return amount_ Amount borrowed and sent to the caller.
    function borrowOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256 shares, uint256 amount_);
}

/// @notice Aave V4 position manager that lets anyone repay a user's debt.
interface IAaveV4GiverPositionManager {
    /// @notice Repays up to the debt of `onBehalfOf`, pulling the tokens from the caller.
    /// Rejects `type(uint256).max`.
    /// @return shares Drawn shares restored.
    /// @return amount_ Debt restored, premium included.
    function repayOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256 shares, uint256 amount_);
}
