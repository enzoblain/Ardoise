// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoiseFactory} from "../interfaces/IArdoiseFactory.sol";
import {IVenue} from "../interfaces/IVenue.sol";
import {
    IAaveV4GiverPositionManager,
    IAaveV4Hub,
    IAaveV4Oracle,
    IAaveV4Spoke,
    IAaveV4TakerPositionManager
} from "./aave/IAaveV4.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

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

    IArdoiseFactory public immutable factory;
    IAaveV4Spoke public immutable spoke;
    IAaveV4Hub public immutable hub;
    IAaveV4Oracle public immutable oracle;
    IAaveV4TakerPositionManager public immutable taker;
    IAaveV4GiverPositionManager public immutable giver;
    uint256 public immutable reserveId;
    uint256 public immutable assetId;
    address public immutable asset;
    uint8 public immutable assetDecimals;

    /// @notice Thrown when a token transfer or approval returns false.
    error TokenCallFailed();

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
    /// @dev The Hub's drawn rate; a user with a risk premium pays slightly more.
    function rate() external view returns (uint256 rateBps) {
        return hub.getAssetDrawnRate(assetId) / RAY_PER_BPS;
    }

    /// @inheritdoc IVenue
    /// @dev The lower of the Hub's liquidity and what is left under the Spoke's draw cap.
    function available() external view returns (uint256 amount) {
        amount = hub.getAssetLiquidity(assetId);
        uint40 drawCap = hub.getSpoke(assetId, address(spoke)).drawCap;
        if (drawCap != hub.MAX_ALLOWED_SPOKE_CAP()) {
            uint256 cap = uint256(drawCap) * 10 ** assetDecimals;
            uint256 owed = hub.getSpokeTotalOwed(assetId, address(spoke));
            uint256 room = cap > owed ? cap - owed : 0;
            if (room < amount) amount = room;
        }
    }

    /// @inheritdoc IVenue
    function health(address user)
        external
        view
        returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd)
    {
        IAaveV4Spoke.UserAccountData memory data = spoke.getUserAccountData(user);
        healthFactor = data.healthFactor;
        collateralUsd = data.totalCollateralValue / VALUE_PER_WAD;
        debtUsd = data.totalDebtValueRay / RAY / VALUE_PER_WAD;
    }

    /// @inheritdoc IVenue
    /// @dev Same formula as the Spoke: health factor = sum(collateral value x collateral factor)
    /// / debt value, with the extra debt valued at the oracle price. Ignores the interest that
    /// accrues between this call and the borrow.
    function healthAfter(address user, uint256 extraDebt) external view returns (uint256 healthFactor) {
        IAaveV4Spoke.UserAccountData memory data = spoke.getUserAccountData(user);
        if (data.totalCollateralValue == 0) return 0;
        uint256 debtValueRay = data.totalDebtValueRay + _toValue(extraDebt) * RAY;
        if (debtValueRay == 0) return type(uint256).max;
        return (data.avgCollateralFactor * data.totalCollateralValue * RAY) / debtValueRay;
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
        (, borrowed) = taker.borrowOnBehalfOf(address(spoke), reserveId, amount, user);
        _call(IERC20Minimal(asset).transfer(msg.sender, borrowed));
        emit Borrowed(user, msg.sender, borrowed);
    }

    /// @inheritdoc IVenue
    function repay(address user, uint256 amount) external returns (uint256 repaid) {
        uint256 debt = spoke.getUserTotalDebt(reserveId, user);
        uint256 toRepay = amount < debt ? amount : debt;
        if (toRepay == 0) return 0;
        _call(IERC20Minimal(asset).transferFrom(msg.sender, address(this), toRepay));
        _call(IERC20Minimal(asset).approve(address(giver), toRepay));
        (, repaid) = giver.repayOnBehalfOf(address(spoke), reserveId, toRepay, user);
        // The Giver pulls at most the debt; return any rounding remainder to the payer.
        if (repaid < toRepay) _call(IERC20Minimal(asset).transfer(msg.sender, toRepay - repaid));
        emit Repaid(user, msg.sender, repaid);
    }

    /// @dev Aave V4 `toValue`: amount x price (8 decimals) scaled to 18 decimals.
    function _toValue(uint256 amount) private view returns (uint256) {
        return amount * oracle.getReservePrice(reserveId) * 10 ** (18 - assetDecimals);
    }

    function _call(bool ok) private pure {
        if (!ok) revert TokenCallFailed();
    }
}
