// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoise} from "../../../src/interfaces/IArdoise.sol";
import {IGuard} from "../../../src/interfaces/IGuard.sol";
import {IArdoiseFactory} from "../../../src/interfaces/IArdoiseFactory.sol";
import {IVenue} from "../../../src/interfaces/IVenue.sol";
import {IAaveV4Hub, IAaveV4Spoke} from "../../../src/venues/aave/IAaveV4.sol";

/// @notice Minimal ERC-20 with public minting, standing in for USDC in the adapter tests.
contract MockToken {
    /// @notice Token decimals.
    uint8 public immutable decimals;
    /// @notice Balance of each holder.
    mapping(address => uint256) public balanceOf;
    /// @notice Allowance of each spender per owner.
    mapping(address => mapping(address => uint256)) public allowance;

    /// @param decimals_ Token decimals.
    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    /// @notice Creates `amount` tokens for `to`.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    /// @notice ERC-20 `approve`.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @notice ERC-20 `transfer`.
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// @notice ERC-20 `transferFrom`.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice One contract playing the Aave V4 Spoke, Hub, oracle and Taker and Giver position
/// managers, with every value the adapter reads settable by the test.
/// @dev Mirrors the Aave V4 behaviours the adapter depends on: the Taker sends the borrowed
/// tokens to its caller and checks the caller's borrow allowance; the Giver rejects
/// `type(uint256).max`, caps the repayment at the debt and pulls the tokens from its caller.
contract MockAaveV4 {
    /// @notice Borrowed asset.
    MockToken public immutable token;
    /// @notice Hub asset id reported for every reserve.
    uint16 public constant ASSET_ID = 7;

    /// @notice Hub drawn rate, RAY.
    uint256 public drawnRate;
    /// @notice Hub liquidity, token decimals.
    uint256 public liquidity;
    /// @notice Spoke draw cap, whole tokens.
    uint40 public drawCap;
    /// @notice What the spoke owes the Hub, token decimals.
    uint256 public spokeOwed;
    /// @notice Oracle price, 8 decimals.
    uint256 public price = 1e8;
    /// @notice Debt restored short of what the Giver pulls, to model Spoke share rounding.
    uint256 public repayDust;
    /// @notice Amount the Giver pulls short of what it is asked. The real Giver never does; this
    /// exercises the adapter's refund safeguard.
    uint256 public giverShortfall;
    /// @notice Reserve flags (`ReserveFlags` bits); defaults to borrowable, as on Arc mainnet.
    uint8 public reserveFlags = 0x0C;
    /// @notice Decimals reported by `getReserve`; defaults to the token's.
    uint8 public reserveDecimals;
    /// @notice Spoke status on the Hub.
    bool public spokeActive = true;
    /// @notice Spoke halted on the Hub.
    bool public spokeHalted;
    /// @notice Spoke deficit on the Hub, RAY.
    uint200 public spokeDeficitRay;

    /// @notice Account data returned for each user.
    mapping(address => IAaveV4Spoke.UserAccountData) internal accountData;
    /// @notice Debt of each user on the borrowed reserve.
    mapping(address => uint256) public debt;
    /// @notice Borrow allowance per user and spender.
    mapping(address => mapping(address => uint256)) public borrowAllowance;
    /// @notice Last `onBehalfOf` the Taker borrowed for.
    address public lastBorrowFor;

    /// @notice Thrown by the Taker when the caller's allowance is too low.
    error InsufficientBorrowAllowance(uint256 allowance, uint256 amount);
    /// @notice Thrown by the Giver for `type(uint256).max`.
    error RepayOnBehalfMaxUintNotAllowed();

    /// @param token_ Borrowed asset.
    constructor(MockToken token_) {
        token = token_;
        reserveDecimals = token_.decimals();
        drawCap = type(uint40).max;
    }

    // ----- Test setters -----

    /// @notice Sets the Hub values `rate()` and `available()` read.
    function setHub(uint256 rate_, uint256 liquidity_, uint40 drawCap_, uint256 spokeOwed_) external {
        drawnRate = rate_;
        liquidity = liquidity_;
        drawCap = drawCap_;
        spokeOwed = spokeOwed_;
    }

    /// @notice Sets the reserve flags and decimals `getReserve` reports.
    function setReserve(uint8 flags, uint8 decimals_) external {
        reserveFlags = flags;
        reserveDecimals = decimals_;
    }

    /// @notice Sets the Spoke status and deficit `getSpoke` reports.
    function setSpokeStatus(bool active, bool halted, uint200 deficitRay) external {
        spokeActive = active;
        spokeHalted = halted;
        spokeDeficitRay = deficitRay;
    }

    /// @notice Sets the oracle price (8 decimals).
    function setPrice(uint256 price_) external {
        price = price_;
    }

    /// @notice Sets the account data returned for `user`.
    function setAccountData(address user, IAaveV4Spoke.UserAccountData memory data) external {
        accountData[user] = data;
    }

    /// @notice Sets the debt of `user`.
    function setDebt(address user, uint256 amount) external {
        debt[user] = amount;
    }

    /// @notice Sets the Spoke rounding dust and the Giver shortfall.
    function setRepayQuirks(uint256 dust, uint256 shortfall) external {
        repayDust = dust;
        giverShortfall = shortfall;
    }

    /// @notice Sets the borrow allowance `user` grants to `spender` (Taker `approveBorrow`).
    function approveBorrow(address user, address spender, uint256 amount) external {
        borrowAllowance[user][spender] = amount;
    }

    // ----- Spoke -----

    /// @notice Spoke `getReserve`: this contract is the Hub.
    function getReserve(uint256) external view returns (IAaveV4Spoke.Reserve memory reserve) {
        reserve.underlying = address(token);
        reserve.hub = address(this);
        reserve.assetId = ASSET_ID;
        reserve.decimals = reserveDecimals;
        reserve.flags = reserveFlags;
    }

    /// @notice Spoke `ORACLE`: this contract is the oracle.
    function ORACLE() external view returns (address) {
        return address(this);
    }

    /// @notice Spoke `getUserAccountData`.
    function getUserAccountData(address user) external view returns (IAaveV4Spoke.UserAccountData memory) {
        return accountData[user];
    }

    /// @notice Spoke `getUserTotalDebt`.
    function getUserTotalDebt(uint256, address user) external view returns (uint256) {
        return debt[user];
    }

    // ----- Hub -----

    /// @notice Hub `getAssetDrawnRate`.
    function getAssetDrawnRate(uint256 assetId) external view returns (uint256) {
        require(assetId == ASSET_ID, "asset");
        return drawnRate;
    }

    /// @notice Hub `getAssetLiquidity`.
    function getAssetLiquidity(uint256 assetId) external view returns (uint256) {
        require(assetId == ASSET_ID, "asset");
        return liquidity;
    }

    /// @notice Hub `getSpoke`; only the draw cap, status and deficit are meaningful.
    function getSpoke(uint256 assetId, address) external view returns (IAaveV4Hub.SpokeData memory data) {
        require(assetId == ASSET_ID, "asset");
        data.drawCap = drawCap;
        data.active = spokeActive;
        data.halted = spokeHalted;
        data.deficitRay = spokeDeficitRay;
    }

    /// @notice Hub `getSpokeTotalOwed`.
    function getSpokeTotalOwed(uint256 assetId, address) external view returns (uint256) {
        require(assetId == ASSET_ID, "asset");
        return spokeOwed;
    }

    /// @notice Hub `MAX_ALLOWED_SPOKE_CAP`.
    function MAX_ALLOWED_SPOKE_CAP() external pure returns (uint40) {
        return type(uint40).max;
    }

    // ----- Oracle -----

    /// @notice Oracle `getReservePrice`.
    function getReservePrice(uint256) external view returns (uint256) {
        return price;
    }

    // ----- Position managers -----

    /// @notice Taker `borrowOnBehalfOf`: spends the caller's allowance and sends the tokens to it.
    function borrowOnBehalfOf(address, uint256, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256)
    {
        uint256 allowed = borrowAllowance[onBehalfOf][msg.sender];
        if (allowed < amount) revert InsufficientBorrowAllowance(allowed, amount);
        borrowAllowance[onBehalfOf][msg.sender] = allowed - amount;
        debt[onBehalfOf] += amount;
        lastBorrowFor = onBehalfOf;
        token.mint(msg.sender, amount);
        return (amount, amount);
    }

    /// @notice Giver `repayOnBehalfOf`: caps at the debt and pulls the tokens from the caller.
    function repayOnBehalfOf(address, uint256, uint256 amount, address onBehalfOf) external returns (uint256, uint256) {
        if (amount == type(uint256).max) revert RepayOnBehalfMaxUintNotAllowed();
        uint256 owed = debt[onBehalfOf];
        uint256 pulled = (amount > owed ? owed : amount) - giverShortfall;
        token.transferFrom(msg.sender, address(this), pulled);
        uint256 restored = pulled - repayDust;
        debt[onBehalfOf] = owed - restored;
        return (restored, restored);
    }
}

/// @notice Factory stand-in whose `accountOf` the test sets directly.
contract MockFactory is IArdoiseFactory {
    mapping(address => IArdoise) internal accounts;

    /// @notice Records `account` as the account of `owner`.
    function setAccount(address owner, address account) external {
        accounts[owner] = IArdoise(account);
    }

    /// @inheritdoc IArdoiseFactory
    function accountOf(address owner) external view returns (IArdoise) {
        return accounts[owner];
    }

    /// @inheritdoc IArdoiseFactory
    function createAccount() external pure returns (IArdoise) {
        revert("unused");
    }

    /// @inheritdoc IArdoiseFactory
    function venues() external pure returns (IVenue[] memory) {
        revert("unused");
    }

    /// @inheritdoc IArdoiseFactory
    function guard() external pure returns (IGuard) {
        revert("unused");
    }

    /// @inheritdoc IArdoiseFactory
    function setVenues(IVenue[] calldata) external pure {
        revert("unused");
    }

    /// @inheritdoc IArdoiseFactory
    function setGuard(IGuard) external pure {
        revert("unused");
    }
}
