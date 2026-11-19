// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoiseFactory} from "../../src/interfaces/IArdoiseFactory.sol";
import {IGuard} from "../../src/interfaces/IGuard.sol";
import {IVenue} from "../../src/interfaces/IVenue.sol";
import {MockToken} from "../venues/mocks/MockAaveV4.sol";

/// @notice Venue double that moves real (mock) tokens: `borrow` mints to the caller and records
/// debt, `repay` pulls at most the debt. Rate, liquidity and health are set by the test, and it
/// can misbehave on demand (revert, send short, reenter the account).
contract TokenVenue is IVenue {
    /// @notice Ways `repay` can misbehave without reverting. Except for `ReportsMax`, no debt
    /// is restored.
    enum RepayQuirk {
        None,
        /// Takes the whole amount and returns 0.
        TakesAllReportsNothing,
        /// Takes the amount less 1 wei and returns 0.
        TakesLessReportsNothing,
        /// Takes nothing, sends 1 wei of the token to the caller and returns 0.
        SendsDust,
        /// Takes the whole amount and returns no data at all.
        ReturnsNothing,
        /// Repays honestly but returns `type(uint256).max`.
        ReportsMax
    }

    /// @inheritdoc IVenue
    IArdoiseFactory public immutable factory;
    /// @notice Token lent.
    MockToken public immutable token;

    /// @notice Rate returned by `rate()`, in bps.
    uint256 public rateBps;
    /// @notice Liquidity returned by `available()`.
    uint256 public liquidity;
    /// @notice Health factor returned by `health`.
    uint256 public currentHealth = 2e18;
    /// @notice Health factor returned by `healthAfter`, whatever the amount.
    uint256 public projectedHealth = type(uint256).max;
    /// @notice When true, `available()` reverts.
    bool public broken;
    /// @notice Amount `borrow` sends short of what is asked.
    uint256 public shortfall;
    /// @notice Amount `borrow` sends on top of what is asked (venue rounding).
    uint256 public surplus;
    /// @notice When true, `repay` reverts.
    bool public repayBroken;
    /// @notice How `repay` misbehaves, if at all.
    RepayQuirk public repayQuirk;
    /// @notice Call made back into `msg.sender` during `borrow`, if set.
    bytes public reentryCall;
    /// @notice Debt of each user.
    mapping(address => uint256) public debtOf;
    /// @notice Number of `borrow` calls.
    uint256 public borrowCount;

    /// @param factory_ Factory whose accounts may borrow.
    /// @param token_ Token lent.
    /// @param rateBps_ Initial rate.
    /// @param liquidity_ Initial liquidity.
    constructor(IArdoiseFactory factory_, MockToken token_, uint256 rateBps_, uint256 liquidity_) {
        factory = factory_;
        token = token_;
        rateBps = rateBps_;
        liquidity = liquidity_;
    }

    /// @notice Sets rate and liquidity.
    function setMarket(uint256 rateBps_, uint256 liquidity_) external {
        rateBps = rateBps_;
        liquidity = liquidity_;
    }

    /// @notice Sets the health factor `health` returns.
    function setHealth(uint256 healthFactor) external {
        currentHealth = healthFactor;
    }

    /// @notice Sets the misbehaviours.
    function setQuirks(bool broken_, uint256 shortfall_, uint256 surplus_) external {
        broken = broken_;
        shortfall = shortfall_;
        surplus = surplus_;
    }

    /// @notice Makes `repay` revert or work again.
    function setRepayBroken(bool broken_) external {
        repayBroken = broken_;
    }

    /// @notice Makes `repay` misbehave, or behave again with `RepayQuirk.None`.
    function setRepayQuirk(RepayQuirk quirk) external {
        repayQuirk = quirk;
    }

    /// @notice Sets the call made back into the borrower during `borrow`.
    function setReentry(bytes calldata data) external {
        reentryCall = data;
    }

    /// @notice Sets the debt of `user`.
    function setDebt(address user, uint256 amount) external {
        debtOf[user] = amount;
    }

    /// @inheritdoc IVenue
    function name() external pure returns (string memory) {
        return "Token venue";
    }

    /// @inheritdoc IVenue
    function asset() external view returns (address) {
        return address(token);
    }

    /// @inheritdoc IVenue
    function rate() external view returns (uint256) {
        return rateBps;
    }

    /// @inheritdoc IVenue
    function available() external view returns (uint256) {
        require(!broken, "broken");
        return liquidity;
    }

    /// @inheritdoc IVenue
    function health(address) external view returns (uint256, uint256, uint256) {
        return (currentHealth, 100e18, 50e18);
    }

    /// @inheritdoc IVenue
    function healthAfter(address, uint256) external view returns (uint256) {
        return projectedHealth;
    }

    /// @inheritdoc IVenue
    function borrow(address user, uint256 amount) external returns (uint256 borrowed) {
        if (address(factory.accountOf(user)) != msg.sender) revert UnauthorizedCaller(msg.sender, user);
        ++borrowCount;
        if (reentryCall.length > 0) {
            (bool ok, bytes memory ret) = msg.sender.call(reentryCall);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        borrowed = amount + surplus - shortfall;
        debtOf[user] += borrowed;
        token.mint(msg.sender, borrowed);
        emit Borrowed(user, msg.sender, borrowed);
    }

    /// @inheritdoc IVenue
    function repay(address user, uint256 amount) external returns (uint256 repaid) {
        require(!repayBroken, "repay refused");
        RepayQuirk quirk = repayQuirk;
        if (quirk == RepayQuirk.TakesAllReportsNothing) {
            token.transferFrom(msg.sender, address(this), amount);
            return 0;
        }
        if (quirk == RepayQuirk.TakesLessReportsNothing) {
            token.transferFrom(msg.sender, address(this), amount - 1);
            return 0;
        }
        if (quirk == RepayQuirk.SendsDust) {
            token.mint(msg.sender, 1);
            return 0;
        }
        if (quirk == RepayQuirk.ReturnsNothing) {
            token.transferFrom(msg.sender, address(this), amount);
            assembly {
                return(0, 0)
            }
        }
        repaid = amount < debtOf[user] ? amount : debtOf[user];
        if (repaid == 0) return 0;
        token.transferFrom(msg.sender, address(this), repaid);
        debtOf[user] -= repaid;
        emit Repaid(user, msg.sender, repaid);
        if (quirk == RepayQuirk.ReportsMax) return type(uint256).max;
    }
}

/// @notice Venue a compromised admin could list: it passes `setVenues`, quotes a rate of 0 with
/// unlimited liquidity, reports the worst health and an unlimited debt for everyone, and sends
/// whatever it is approved for to `thief`.
contract GreedyVenue is IVenue {
    /// @inheritdoc IVenue
    IArdoiseFactory public immutable factory;
    /// @notice Token it claims to lend.
    MockToken public immutable token;
    /// @notice Receiver of everything `repay` pulls.
    address public immutable thief;

    /// @param factory_ Factory it claims to trust.
    /// @param token_ Token it claims to lend.
    /// @param thief_ Receiver of the repayments.
    constructor(IArdoiseFactory factory_, MockToken token_, address thief_) {
        factory = factory_;
        token = token_;
        thief = thief_;
    }

    /// @inheritdoc IVenue
    function name() external pure returns (string memory) {
        return "Greedy venue";
    }

    /// @inheritdoc IVenue
    function asset() external view returns (address) {
        return address(token);
    }

    /// @inheritdoc IVenue
    function rate() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IVenue
    function available() external pure returns (uint256) {
        return type(uint256).max;
    }

    /// @inheritdoc IVenue
    function health(address) external pure returns (uint256, uint256, uint256) {
        return (0, 0, 1e30);
    }

    /// @inheritdoc IVenue
    function healthAfter(address, uint256) external pure returns (uint256) {
        return type(uint256).max;
    }

    /// @inheritdoc IVenue
    function debtOf(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    /// @inheritdoc IVenue
    /// @dev Fronts the payment from its own balance, so that the account would record a line.
    function borrow(address, uint256 amount) external returns (uint256) {
        token.transfer(msg.sender, amount);
        return amount;
    }

    /// @inheritdoc IVenue
    function repay(address, uint256 amount) external returns (uint256) {
        token.transferFrom(msg.sender, thief, amount);
        return amount;
    }
}

/// @notice Guard double: allows everything, or at most `cap`.
contract MockGuard is IGuard {
    /// @notice Largest amount allowed; `type(uint256).max` allows everything.
    uint256 public cap = type(uint256).max;
    /// @notice Arguments of the last `checkMargin` call.
    address public lastUser;
    /// @notice Venue of the last `checkMargin` call.
    IVenue public lastVenue;

    /// @notice Per-venue caps set with `setVenueCap`, which override `cap` for that venue.
    mapping(IVenue => uint256) public venueCap;
    mapping(IVenue => bool) public hasVenueCap;
    /// @notice Venues whose check reverts.
    mapping(IVenue => bool) public broken;

    /// @notice Sets the largest amount allowed.
    function setCap(uint256 cap_) external {
        cap = cap_;
    }

    /// @notice Sets the largest amount allowed on one venue, as when the owner's position there
    /// is smaller or missing.
    function setVenueCap(IVenue venue, uint256 cap_) external {
        venueCap[venue] = cap_;
        hasVenueCap[venue] = true;
    }

    /// @notice Makes the check revert for one venue.
    function setBroken(IVenue venue, bool broken_) external {
        broken[venue] = broken_;
    }

    /// @inheritdoc IGuard
    function checkMargin(address, IVenue venue, uint256 amount) external view returns (uint256) {
        require(!broken[venue], "guard: venue unreadable");
        uint256 limit = hasVenueCap[venue] ? venueCap[venue] : cap;
        return amount < limit ? amount : limit;
    }

    /// @inheritdoc IGuard
    function minHealthFactor() external pure returns (uint256) {
        return 1.25e18;
    }

    /// @inheritdoc IGuard
    function targetHealthFactor() external pure returns (uint256) {
        return 1.5e18;
    }
}

/// @notice CCTP V2 TokenMessenger double: records the last `depositForBurnWithHook` and pulls
/// (burns) the tokens like the real one.
contract MockTokenMessenger {
    /// @notice Arguments of the last burn.
    struct Burn {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    /// @notice Last burn.
    Burn public last;
    /// @notice Number of burns.
    uint256 public burnCount;

    /// @notice Records the call and pulls `amount` of `burnToken` from the caller.
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        last = Burn(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData
        );
        ++burnCount;
        MockToken(burnToken).transferFrom(msg.sender, address(this), amount);
    }
}
