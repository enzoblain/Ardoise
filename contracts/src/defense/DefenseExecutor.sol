// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {IMessageHandlerV2} from "../cctp/IMessageTransmitterV2.sol";
import {ITokenMessengerV2} from "../cctp/ITokenMessengerV2.sol";
import {DefenseMessage} from "./DefenseMessage.sol";

/// @notice Chainlink price feed.
interface IAggregatorV3 {
    /// @notice Decimals of the answer.
    function decimals() external view returns (uint8);
    /// @notice Latest round: `answer` is the price, `updatedAt` its timestamp.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Uniswap V3 SwapRouter02 single-pool swaps (no deadline field in SwapRouter02).
interface ISwapRouter02 {
    /// @notice Parameters of `exactInputSingle`.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Parameters of `exactOutputSingle`.
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps exactly `amountIn` for at least `amountOutMinimum`.
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    /// @notice Swaps at most `amountInMaximum` for exactly `amountOut`.
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
}

/// @title DefenseExecutor
/// @notice On Base, turns an alarm attested by Circle into a repayment: when `DefenseAlarm` on Arc
/// proves that an owner's Ardoise position is under the guard's minimum, this contract pulls the
/// owner's pre-authorized assets here, in the order and within the limits of the owner's policy,
/// swaps non-USDC assets to USDC on Uniswap V3 within a slippage bound against Chainlink, and
/// burns the USDC through CCTP with Circle's Forwarding Service to the owner's Ardoise account on
/// Arc, where `sweep()` applies it to the debt.
/// @dev Trust model: only CCTP messages delivered by the MessageTransmitter, from the Arc domain
/// and from the `DefenseAlarm` address, attested at finality 2000 or more, are acted on. The
/// destination is always the account named in the message; there is no admin, no withdrawal and
/// no arbitrary call. The owner bounds what can be taken with allowances and the policy caps.
/// A relayer (the keeper, or anyone) only submits the attested message.
contract DefenseExecutor is IMessageHandlerV2 {
    uint256 private constant BPS = 10_000;
    /// @notice Highest slippage a policy may allow (10%).
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000;
    /// @dev "cctp-forward": Circle's Forwarding Service mints on Arc without a relayer.
    bytes32 private constant FORWARD_HOOK = "cctp-forward";

    /// @notice Why an alarm was consumed without a burn.
    enum IgnoreReason {
        Expired,
        NoPolicy,
        NotEnoughFunds,
        TooSoon
    }

    /// @notice Swap route and price feed of an asset the executor can sell for USDC.
    struct SwapAsset {
        IAggregatorV3 feed;
        uint24 poolFee;
    }

    /// @notice An owner's policy. `assets[i]` may be taken up to `caps[i]` (in its own units) per
    /// `period` seconds; USDC is used as is, other assets are sold for USDC.
    struct Policy {
        address[] assets;
        uint256[] caps;
        uint64 period;
        uint16 maxSlippageBps;
        uint256 maxFee;
    }

    /// @notice Deployment parameters.
    /// @param messageTransmitter CCTP V2 MessageTransmitter on this chain.
    /// @param tokenMessenger CCTP V2 TokenMessenger on this chain.
    /// @param alarm `DefenseAlarm` address on Arc.
    /// @param arcDomain CCTP domain of Arc (26).
    /// @param usdc USDC on this chain.
    /// @param swapRouter Uniswap V3 SwapRouter02.
    /// @param burnFinality CCTP finality of the burn to Arc (1000 fast, 2000 standard).
    /// @param maxPriceAge Oldest Chainlink answer accepted, in seconds.
    /// @param minDefenseInterval Minimum time between two burns for the same owner, in seconds:
    /// longer than a burn can take to be minted on Arc, so that a new alarm raised before the
    /// previous funds arrived cannot take the owner's funds again.
    struct Config {
        address messageTransmitter;
        ITokenMessengerV2 tokenMessenger;
        address alarm;
        uint32 arcDomain;
        IERC20 usdc;
        ISwapRouter02 swapRouter;
        uint32 burnFinality;
        uint256 maxPriceAge;
        uint256 minDefenseInterval;
    }

    /// @notice An asset that can be sold for USDC: its Chainlink USD feed and Uniswap V3 fee tier.
    struct SwapAssetConfig {
        address asset;
        IAggregatorV3 feed;
        uint24 poolFee;
    }

    /// @dev Amount of an asset taken in the current period.
    struct Usage {
        uint64 periodStart;
        uint256 spent;
    }

    /// @notice CCTP V2 MessageTransmitter on this chain, the only caller of the handlers.
    address public immutable messageTransmitter;
    /// @notice CCTP V2 TokenMessenger on this chain.
    ITokenMessengerV2 public immutable tokenMessenger;
    /// @notice `DefenseAlarm` on Arc, the only accepted message sender.
    address public immutable alarm;
    /// @notice CCTP domain of Arc (26), the only accepted source and the burn destination.
    uint32 public immutable arcDomain;
    /// @notice USDC on this chain.
    IERC20 public immutable usdc;
    /// @notice Uniswap V3 SwapRouter02.
    ISwapRouter02 public immutable swapRouter;
    /// @notice CCTP finality of the burn back to Arc (1000 fast, 2000 standard).
    uint32 public immutable burnFinality;
    /// @notice Oldest Chainlink answer accepted, in seconds.
    uint256 public immutable maxPriceAge;
    /// @notice Minimum time between two burns for the same owner, in seconds.
    uint256 public immutable minDefenseInterval;

    /// @notice Assets that can be sold for USDC, set at deployment.
    mapping(address asset => SwapAsset) public swapAssets;
    /// @notice Alarms already consumed.
    mapping(uint64 nonce => bool) public alarmUsed;
    /// @notice Timestamp of each owner's last burn to Arc.
    mapping(address owner => uint256) public lastDefenseAt;

    mapping(address owner => Policy) private _policies;
    mapping(address owner => mapping(address asset => Usage)) private _usage;
    uint256 private _locked = 1;

    /// @notice Emitted when an owner sets a policy.
    event PolicySet(
        address indexed owner, address[] assets, uint256[] caps, uint64 period, uint16 maxSlippageBps, uint256 maxFee
    );
    /// @notice Emitted when an owner clears their policy.
    event PolicyCleared(address indexed owner);
    /// @notice Emitted for each asset taken from an owner during a defense.
    /// @param asset The asset.
    /// @param amountIn Amount of `asset` taken.
    /// @param usdcOut USDC it provided (equal to `amountIn` for USDC).
    event AssetUsed(address indexed owner, uint64 indexed nonce, address asset, uint256 amountIn, uint256 usdcOut);
    /// @notice Emitted when a swap fails; the asset goes back to the owner and the next one is tried.
    event SwapFailed(address indexed owner, uint64 indexed nonce, address asset, uint256 amountIn);
    /// @notice Emitted when USDC is burned to the owner's account on Arc.
    /// @param amount USDC burned; the account receives `amount` minus the fee, at most `maxFee`.
    event DefenseExecuted(
        address indexed owner, address indexed account, uint64 indexed nonce, uint256 amount, uint256 maxFee
    );
    /// @notice Emitted when an alarm is consumed without a burn.
    event AlarmIgnored(address indexed owner, uint64 indexed nonce, IgnoreReason reason);

    /// @notice Thrown when a handler is called by anyone but the MessageTransmitter.
    error NotMessageTransmitter(address caller);
    /// @notice Thrown for a message from another domain or sender than `DefenseAlarm` on Arc.
    error UnexpectedSender(uint32 sourceDomain, bytes32 sender);
    /// @notice Thrown for a message attested below finality 2000.
    error UnfinalizedMessage(uint32 finalityThresholdExecuted);
    /// @notice Thrown when an alarm nonce is delivered twice.
    error AlarmAlreadyUsed(uint64 nonce);
    /// @notice Thrown by `setPolicy` for an invalid policy.
    error InvalidPolicy();
    /// @notice Thrown when a Chainlink answer is not positive or older than `maxPriceAge`.
    error StalePrice(address feed);
    /// @notice Thrown by the constructor for a zero address or an unusable swap asset.
    error InvalidConfig();
    /// @notice Thrown when a token call returns false.
    error TokenCallFailed();
    /// @notice Thrown on reentrancy.
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // Validation reverts inside the configuration loop are intended.
    // forge-lint: disable-next-item(require-revert-in-loop)
    /// @param config Addresses and parameters, see `Config`.
    /// @param assets Assets that can be sold for USDC (WETH for the demo), with their feed and pool.
    constructor(Config memory config, SwapAssetConfig[] memory assets) {
        if (
            config.messageTransmitter == address(0) || address(config.tokenMessenger) == address(0)
                || config.alarm == address(0) || address(config.usdc) == address(0)
                || address(config.swapRouter) == address(0)
        ) revert InvalidConfig();
        messageTransmitter = config.messageTransmitter;
        tokenMessenger = config.tokenMessenger;
        alarm = config.alarm;
        arcDomain = config.arcDomain;
        usdc = config.usdc;
        swapRouter = config.swapRouter;
        burnFinality = config.burnFinality;
        maxPriceAge = config.maxPriceAge;
        minDefenseInterval = config.minDefenseInterval;
        for (uint256 i = 0; i < assets.length; ++i) {
            SwapAssetConfig memory c = assets[i];
            if (c.asset == address(config.usdc) || address(c.feed) == address(0)) revert InvalidConfig();
            swapAssets[c.asset] = SwapAsset(c.feed, c.poolFee);
        }
    }

    // ----- Owner policy -----

    // Validation reverts inside the loops are intended.
    // forge-lint: disable-next-item(require-revert-in-loop)
    /// @notice Sets the caller's policy. The caller must also approve this contract for each asset.
    /// @dev Reverts with `InvalidPolicy` for empty or mismatched lists, a duplicate or unsupported
    /// asset, a zero period or a slippage above `MAX_SLIPPAGE_BPS`. Resets nothing already spent
    /// in the current period. Emits `PolicySet`.
    /// @param assets Assets in the order they are used; USDC or assets in `swapAssets`.
    /// @param caps Maximum taken per period for each asset, in the asset's units.
    /// @param period Length of a cap period, in seconds.
    /// @param maxSlippageBps Largest shortfall of a swap against the Chainlink price.
    /// @param maxFee Largest CCTP fee (protocol + forwarder) the owner accepts per defense, in USDC.
    function setPolicy(
        address[] calldata assets,
        uint256[] calldata caps,
        uint64 period,
        uint16 maxSlippageBps,
        uint256 maxFee
    ) external {
        if (assets.length == 0 || assets.length != caps.length || period == 0 || maxSlippageBps > MAX_SLIPPAGE_BPS) {
            revert InvalidPolicy();
        }
        for (uint256 i = 0; i < assets.length; ++i) {
            if (assets[i] != address(usdc) && address(swapAssets[assets[i]].feed) == address(0)) {
                revert InvalidPolicy();
            }
            for (uint256 j = 0; j < i; ++j) {
                if (assets[j] == assets[i]) revert InvalidPolicy();
            }
        }
        _policies[msg.sender] = Policy(assets, caps, period, maxSlippageBps, maxFee);
        emit PolicySet(msg.sender, assets, caps, period, maxSlippageBps, maxFee);
    }

    /// @notice Removes the caller's policy; later alarms for the caller are ignored.
    function clearPolicy() external {
        delete _policies[msg.sender];
        emit PolicyCleared(msg.sender);
    }

    /// @notice The policy of `owner` (empty lists when none).
    /// @param owner The owner.
    /// @return The policy.
    function policyOf(address owner) external view returns (Policy memory) {
        return _policies[owner];
    }

    /// @notice Amount of `asset` that can still be taken from `owner` in the current period.
    /// @param owner The owner.
    /// @param asset The asset.
    /// @return The remaining cap, 0 if the asset is not in the policy.
    function remainingCap(address owner, address asset) public view returns (uint256) {
        Policy storage p = _policies[owner];
        for (uint256 i = 0; i < p.assets.length; ++i) {
            if (p.assets[i] != asset) continue;
            Usage storage u = _usage[owner][asset];
            // forge-lint: disable-next-line(block-timestamp)
            uint256 spent = block.timestamp >= u.periodStart + p.period ? 0 : u.spent;
            return p.caps[i] > spent ? p.caps[i] - spent : 0;
        }
        return 0;
    }

    // ----- CCTP handlers -----

    /// @inheritdoc IMessageHandlerV2
    /// @dev Reverts (so the message can be relayed again) for a wrong caller, source, sender,
    /// a replayed alarm or a malformed body. An expired alarm, a missing policy or funds that do
    /// not cover the fee, or an alarm within `minDefenseInterval` of the owner's last burn (its
    /// funds may still be on their way to Arc) consume the alarm without a burn (`AlarmIgnored`).
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external nonReentrant returns (bool) {
        if (msg.sender != messageTransmitter) {
            revert NotMessageTransmitter(msg.sender);
        }
        if (sourceDomain != arcDomain || sender != bytes32(uint256(uint160(alarm)))) {
            revert UnexpectedSender(sourceDomain, sender);
        }
        if (finalityThresholdExecuted < 2000) revert UnfinalizedMessage(finalityThresholdExecuted);
        DefenseMessage.Alarm memory a = DefenseMessage.decode(messageBody);
        if (alarmUsed[a.nonce]) revert AlarmAlreadyUsed(a.nonce);
        alarmUsed[a.nonce] = true;
        _defend(a);
        return true;
    }

    /// @inheritdoc IMessageHandlerV2
    /// @dev Always reverts: only finalized alarms are acted on.
    function handleReceiveUnfinalizedMessage(uint32, bytes32, uint32 finalityThresholdExecuted, bytes calldata)
        external
        pure
        returns (bool)
    {
        revert UnfinalizedMessage(finalityThresholdExecuted);
    }

    // ----- Internals -----

    // The handler is non-reentrant, and every token and the router are fixed at deployment (USDC
    // and the configured swap assets), so no call here can come back in.
    // forge-lint: disable-next-item(calls-loop, reentrancy-events, reentrancy-no-eth)
    function _defend(DefenseMessage.Alarm memory a) private {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > a.expiry) {
            emit AlarmIgnored(a.owner, a.nonce, IgnoreReason.Expired);
            return;
        }
        uint256 last = lastDefenseAt[a.owner];
        // forge-lint: disable-next-line(block-timestamp)
        if (last != 0 && block.timestamp < last + minDefenseInterval) {
            emit AlarmIgnored(a.owner, a.nonce, IgnoreReason.TooSoon);
            return;
        }
        Policy storage p = _policies[a.owner];
        if (p.assets.length == 0) {
            emit AlarmIgnored(a.owner, a.nonce, IgnoreReason.NoPolicy);
            return;
        }

        uint256 maxFee = p.maxFee;
        uint256 before = usdc.balanceOf(address(this));
        uint256 remaining = a.amountNeeded + maxFee;
        for (uint256 i = 0; i < p.assets.length && remaining > 0; ++i) {
            uint256 got = _take(a, p, p.assets[i], remaining);
            remaining = got >= remaining ? 0 : remaining - got;
        }
        uint256 gathered = usdc.balanceOf(address(this)) - before;

        if (gathered <= maxFee) {
            if (gathered > 0) _call(usdc.transfer(a.owner, gathered));
            emit AlarmIgnored(a.owner, a.nonce, IgnoreReason.NotEnoughFunds);
            return;
        }
        lastDefenseAt[a.owner] = block.timestamp;
        _call(usdc.approve(address(tokenMessenger), gathered));
        tokenMessenger.depositForBurnWithHook(
            gathered,
            arcDomain,
            bytes32(uint256(uint160(a.account))),
            address(usdc),
            bytes32(0),
            maxFee,
            burnFinality,
            abi.encodePacked(FORWARD_HOOK)
        );
        emit DefenseExecuted(a.owner, a.account, a.nonce, gathered, maxFee);
    }

    // Same reasons as `_defend`, its only caller.
    // forge-lint: disable-next-item(calls-loop, reentrancy-events, reentrancy-no-eth, require-revert-in-loop)
    /// @dev Takes up to `needed` USDC worth of `asset` from the owner, within cap, allowance and
    /// balance. Returns the USDC obtained.
    function _take(DefenseMessage.Alarm memory a, Policy storage p, address asset, uint256 needed)
        private
        returns (uint256 usdcOut)
    {
        IERC20 token = IERC20(asset);
        uint256 available =
            _min(remainingCap(a.owner, asset), _min(token.balanceOf(a.owner), token.allowance(a.owner, address(this))));
        if (available == 0) return 0;

        if (asset == address(usdc)) {
            uint256 take = _min(available, needed);
            _pull(a.owner, asset, take, p.period);
            emit AssetUsed(a.owner, a.nonce, asset, take, take);
            return take;
        }

        SwapAsset memory s = swapAssets[asset];
        (uint256 price, uint256 priceUnit) = _price(s.feed);
        uint256 unit = 10 ** token.decimals();
        // Amount of `asset` worth `needed` USDC at the oracle price, plus the slippage allowance.
        uint256 fair = _ceilDiv(needed * unit * priceUnit, price * 1e6);
        uint256 maxIn = _ceilDiv(fair * (BPS + p.maxSlippageBps), BPS);
        uint256 amountIn = _min(available, maxIn);
        _pull(a.owner, asset, amountIn, p.period);
        _call(token.approve(address(swapRouter), amountIn));

        uint256 used = 0;
        if (amountIn == maxIn) {
            try swapRouter.exactOutputSingle(
                ISwapRouter02.ExactOutputSingleParams(asset, address(usdc), s.poolFee, address(this), needed, maxIn, 0)
            ) returns (
                uint256 spentIn
            ) {
                used = spentIn;
                usdcOut = needed;
            } catch {}
        } else {
            uint256 minOut = amountIn * price * 1e6 * (BPS - p.maxSlippageBps) / (unit * priceUnit * BPS);
            try swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(
                    asset, address(usdc), s.poolFee, address(this), amountIn, minOut, 0
                )
            ) returns (
                uint256 out
            ) {
                used = amountIn;
                usdcOut = out;
            } catch {}
        }
        _call(token.approve(address(swapRouter), 0));

        if (used == 0) emit SwapFailed(a.owner, a.nonce, asset, amountIn);
        else emit AssetUsed(a.owner, a.nonce, asset, used, usdcOut);
        // Give back what the swap did not use, and take it off the period's spending.
        if (amountIn > used) {
            _usage[a.owner][asset].spent -= amountIn - used;
            _call(token.transfer(a.owner, amountIn - used));
        }
    }

    // Same reasons as `_defend`.
    // forge-lint: disable-next-item(calls-loop, reentrancy-no-eth, require-revert-in-loop)
    /// @dev Pulls `amount` of `asset` from `owner` and records it against the current period.
    function _pull(address owner, address asset, uint256 amount, uint64 period) private {
        Usage storage u = _usage[owner][asset];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= u.periodStart + period) {
            // forge-lint: disable-next-line(unsafe-typecast)
            u.periodStart = uint64(block.timestamp);
            u.spent = 0;
        }
        u.spent += amount;
        // `owner` comes from an alarm attested by Circle and proven on Arc; the owner approved
        // this contract and capped what it may take through the policy.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        _call(IERC20(asset).transferFrom(owner, address(this), amount));
    }

    // Only the answer and its timestamp matter; round ids are not used.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop, unused-return)
    /// @dev Positive and fresh Chainlink answer, and 10^decimals of the feed.
    function _price(IAggregatorV3 feed) private view returns (uint256 price, uint256 unit) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        // forge-lint: disable-next-line(block-timestamp)
        if (answer <= 0 || updatedAt + maxPriceAge < block.timestamp) revert StalePrice(address(feed));
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint256(answer), 10 ** feed.decimals()); // answer > 0 checked above
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _call(bool ok) private pure {
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (!ok) revert TokenCallFailed();
    }
}
