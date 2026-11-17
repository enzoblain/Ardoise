// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {IArdoiseFactory} from "../interfaces/IArdoiseFactory.sol";
import {IVenue} from "../interfaces/IVenue.sol";
import {
    IAaveV4GiverPositionManager,
    IAaveV4Hub,
    IAaveV4Oracle,
    IAaveV4Spoke,
    IAaveV4TakerPositionManager
} from "./aave/IAaveV4.sol";

/// @title AaveV4Adapter
/// @notice `IVenue` for one borrowable reserve (USDC on Arc) of an Aave V4 Spoke.
/// @dev The user's position stays on the Spoke under the user's own address. Borrowing goes
/// through the Taker position manager, which spends the allowance the user granted to this
/// adapter (`approveBorrow`); repaying goes through the Giver position manager. The user must have
/// approved both managers on the Spoke (`setUserPositionManager`). See docs/api.md.
contract AaveV4Adapter is IVenue {
    /// @dev Aave V4 rates are RAY (1e27); 1 bps = 1e23 in RAY.
    uint256 private constant RAY_PER_BPS = 1e23;
    uint256 private constant RAY = 1e27;
    /// @dev Aave V4 "units of Value" are 1e26 per USD; WAD USD is 1e18 per USD.
    uint256 private constant VALUE_PER_WAD = 1e8;
    /// @dev Aave V4 `ReserveFlags` bits (src/spoke/libraries/ReserveFlagsMap.sol).
    uint8 private constant PAUSED_MASK = 0x01;
    uint8 private constant FROZEN_MASK = 0x02;
    uint8 private constant BORROWABLE_MASK = 0x04;

    /// @inheritdoc IVenue
    IArdoiseFactory public immutable factory;
    /// @notice Aave V4 Spoke holding the user positions.
    IAaveV4Spoke public immutable spoke;
    /// @notice Aave V4 Hub lending the asset to the Spoke, read from the Spoke reserve.
    IAaveV4Hub public immutable hub;
    /// @notice Spoke oracle (USD prices with 8 decimals).
    IAaveV4Oracle public immutable oracle;
    /// @notice Position manager that borrows on a user's behalf within the user's allowance.
    IAaveV4TakerPositionManager public immutable taker;
    /// @notice Position manager that repays on a user's behalf.
    IAaveV4GiverPositionManager public immutable giver;
    /// @notice Spoke reserve of the borrowed asset.
    uint256 public immutable reserveId;
    /// @notice Hub asset id of the borrowed asset.
    uint256 public immutable assetId;
    /// @inheritdoc IVenue
    address public immutable asset;
    /// @notice Decimals of the borrowed asset.
    uint8 public immutable assetDecimals;

    /// @notice Thrown when a token transfer or approval returns false.
    error TokenCallFailed();

    /// @notice Thrown by the constructor for an asset with more than 18 decimals, which the
    /// Aave V4 value conversion does not support.
    /// @param decimals The asset's decimals.
    error UnsupportedDecimals(uint8 decimals);

    /// @notice Reads the Hub, asset and oracle from the Spoke reserve, so they cannot be
    /// misconfigured.
    /// @param factory_ Registry of Ardoise accounts allowed to borrow.
    /// @param spoke_ Aave V4 Spoke holding the user positions.
    /// @param taker_ Aave V4 Taker position manager.
    /// @param giver_ Aave V4 Giver position manager.
    /// @param reserveId_ Spoke reserve of the borrowed asset (0 for USDC on the Arc Main Spoke).
    constructor(
        IArdoiseFactory factory_,
        IAaveV4Spoke spoke_,
        IAaveV4TakerPositionManager taker_,
        IAaveV4GiverPositionManager giver_,
        uint256 reserveId_
    ) {
        factory = factory_;
        spoke = spoke_;
        taker = taker_;
        giver = giver_;
        reserveId = reserveId_;
        IAaveV4Spoke.Reserve memory reserve = spoke_.getReserve(reserveId_);
        if (reserve.decimals > 18) revert UnsupportedDecimals(reserve.decimals);
        hub = IAaveV4Hub(reserve.hub);
        assetId = reserve.assetId;
        asset = reserve.underlying;
        assetDecimals = reserve.decimals;
        oracle = IAaveV4Oracle(spoke_.ORACLE());
    }

    /// @inheritdoc IVenue
    function name() external pure returns (string memory) {
        return "Aave V4";
    }

    /// @inheritdoc IVenue
    /// @dev The Hub's drawn rate. Aave V4 adds a risk premium that depends on the user's
    /// collateral (`UserAccountData.riskPremium`), so a cirBTC borrower pays somewhat more; the
    /// base rate is what is comparable across users and venues.
    function rate() external view returns (uint256 rateBps) {
        return hub.getAssetDrawnRate(assetId) / RAY_PER_BPS;
    }

    /// @inheritdoc IVenue
    /// @dev The lower of the Hub's liquidity and what is left under the Spoke's draw cap, with
    /// the same terms as the Hub's draw check (owed plus the Spoke's deficit). 0 when the Spoke
    /// would refuse any borrow: reserve paused, frozen or not borrowable, Spoke inactive or
    /// halted on the Hub. This lets `pay()` fall back to another venue instead of reverting.
    function available() external view returns (uint256 amount) {
        uint8 flags = spoke.getReserve(reserveId).flags;
        if (flags & (PAUSED_MASK | FROZEN_MASK) != 0 || flags & BORROWABLE_MASK == 0) return 0;
        IAaveV4Hub.SpokeData memory spokeData = hub.getSpoke(assetId, address(spoke));
        if (!spokeData.active || spokeData.halted) return 0;
        amount = hub.getAssetLiquidity(assetId);
        if (spokeData.drawCap != hub.MAX_ALLOWED_SPOKE_CAP()) {
            uint256 cap = uint256(spokeData.drawCap) * 10 ** assetDecimals;
            uint256 used = hub.getSpokeTotalOwed(assetId, address(spoke)) + _ceilDiv(spokeData.deficitRay, RAY);
            uint256 room = cap > used ? cap - used : 0;
            if (room < amount) amount = room;
        }
    }

    /// @inheritdoc IVenue
    function health(address user) external view returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd) {
        IAaveV4Spoke.UserAccountData memory data = spoke.getUserAccountData(user);
        healthFactor = data.healthFactor;
        collateralUsd = data.totalCollateralValue / VALUE_PER_WAD;
        debtUsd = data.totalDebtValueRay / RAY / VALUE_PER_WAD;
    }

    /// @inheritdoc IVenue
    /// @dev Same formula as the Spoke: health factor = sum(collateral value x collateral factor)
    /// / debt value, with the extra debt valued at the oracle price. The Spoke only exposes the
    /// floored average collateral factor, and the debt value is rounded up to whole units of
    /// Value (1e-26 USD) so that `avgCollateralFactor x collateral x RAY` cannot overflow; both
    /// make the result at most a few wei lower than the Spoke's. Two limits: it ignores the
    /// interest that accrues between this call and the borrow, and it uses the collateral factors
    /// the position was last refreshed with, while a borrow first refreshes them to the current
    /// ones; if governance lowers a collateral factor, the result is higher than the health
    /// factor the borrow will leave until the position is next refreshed. Reverts on overflow for
    /// absurd amounts (`extraDebt` around 1e57).
    function healthAfter(address user, uint256 extraDebt) external view returns (uint256 healthFactor) {
        IAaveV4Spoke.UserAccountData memory data = spoke.getUserAccountData(user);
        if (data.totalCollateralValue == 0) return 0;
        uint256 debtValue = _ceilDiv(data.totalDebtValueRay, RAY) + _toValue(extraDebt);
        if (debtValue == 0) return type(uint256).max;
        return (data.avgCollateralFactor * data.totalCollateralValue) / debtValue;
    }

    /// @inheritdoc IVenue
    function debtOf(address user) external view returns (uint256 amount) {
        return spoke.getUserTotalDebt(reserveId, user);
    }

    /// @inheritdoc IVenue
    function borrow(address user, uint256 amount) external returns (uint256 borrowed) {
        // The user's allowance is granted to this shared adapter: only the user's own account,
        // as recorded by the factory, may spend it.
        if (address(factory.accountOf(user)) != msg.sender) revert UnauthorizedCaller(msg.sender, user);
        // The Taker's first return value is drawn shares, which the adapter does not need.
        // forge-lint: disable-next-line(unused-return)
        (, borrowed) = taker.borrowOnBehalfOf(address(spoke), reserveId, amount, user);
        _call(IERC20(asset).transfer(msg.sender, borrowed));
        // The external calls are the trusted Taker and USDC, which runs no recipient code.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Borrowed(user, msg.sender, borrowed);
    }

    /// @inheritdoc IVenue
    /// @dev The Giver pulls exactly `min(amount, debt)`, which the adapter has already capped, so
    /// nothing is normally left over. As a safeguard, whatever the Giver did not pull goes back to
    /// the payer and the leftover approval is cleared. The Spoke may restore slightly less than
    /// the Giver pulled because of share rounding; that dust stays in the Giver and `repaid` is
    /// the debt actually restored.
    function repay(address user, uint256 amount) external returns (uint256 repaid) {
        uint256 debt = spoke.getUserTotalDebt(reserveId, user);
        uint256 toRepay = amount < debt ? amount : debt;
        if (toRepay == 0) return 0;
        IERC20 token = IERC20(asset);
        uint256 balanceBefore = token.balanceOf(address(this));
        _call(token.transferFrom(msg.sender, address(this), toRepay));
        _call(token.approve(address(giver), toRepay));
        // forge-lint: disable-next-line(unused-return)
        (, repaid) = giver.repayOnBehalfOf(address(spoke), reserveId, toRepay, user);
        uint256 unused = token.balanceOf(address(this)) - balanceBefore;
        if (unused > 0) {
            _call(token.approve(address(giver), 0));
            _call(token.transfer(msg.sender, unused));
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit Repaid(user, msg.sender, repaid);
    }

    /// @dev Aave V4 `toValue`: amount x price (8 decimals) scaled to 18 decimals.
    function _toValue(uint256 amount) private view returns (uint256) {
        return amount * oracle.getReservePrice(reserveId) * 10 ** (18 - assetDecimals);
    }

    /// @dev Rounds `a / b` up.
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Reverts with `TokenCallFailed` when a token call returned false.
    function _call(bool ok) private pure {
        if (!ok) revert TokenCallFailed();
    }
}
