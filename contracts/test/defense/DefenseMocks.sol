// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArdoise} from "../../src/interfaces/IArdoise.sol";
import {IGuard} from "../../src/interfaces/IGuard.sol";
import {IVenue} from "../../src/interfaces/IVenue.sol";
import {MockToken} from "../venues/mocks/MockAaveV4.sol";

/// @notice Factory double for the alarm: accounts, venues and guard set by the test.
contract DefenseFactoryMock {
    mapping(address => IArdoise) public accountOf;
    IVenue[] internal _venues;
    IGuard public guard;

    /// @notice Sets the account of `owner`.
    function setAccount(address owner, address account) external {
        accountOf[owner] = IArdoise(account);
    }

    /// @notice Sets the venue list.
    function setVenues(IVenue[] calldata list) external {
        _venues = list;
    }

    /// @notice Sets the guard.
    function setGuard(IGuard guard_) external {
        guard = guard_;
    }

    /// @notice The venue list.
    function venues() external view returns (IVenue[] memory) {
        return _venues;
    }
}

/// @notice MessageTransmitter double on the source chain: records `sendMessage`.
contract MessageTransmitterMock {
    struct Sent {
        uint32 destinationDomain;
        bytes32 recipient;
        bytes32 destinationCaller;
        uint32 minFinalityThreshold;
        bytes messageBody;
    }

    /// @notice Last message sent.
    Sent public last;
    /// @notice Number of messages sent.
    uint256 public count;

    /// @notice Records the message.
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external {
        last = Sent(destinationDomain, recipient, destinationCaller, minFinalityThreshold, messageBody);
        ++count;
    }
}

/// @notice Chainlink feed double.
contract FeedMock {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    /// @notice Sets the answer and its timestamp.
    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    /// @notice Latest round.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice SwapRouter02 double: swaps `tokenIn` for USDC at `usdcPerUnit` (USDC units per whole
/// `tokenIn`), worsened by `slippageBps`, minting the USDC; can be made to revert.
contract SwapRouterMock {
    MockToken public immutable usdc;
    uint256 public usdcPerUnit;
    uint256 public slippageBps;
    bool public broken;

    constructor(MockToken usdc_, uint256 usdcPerUnit_) {
        usdc = usdc_;
        usdcPerUnit = usdcPerUnit_;
    }

    /// @notice Sets the execution price penalty and the failure switch.
    function setQuirks(uint256 slippageBps_, bool broken_) external {
        slippageBps = slippageBps_;
        broken = broken_;
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps exactly `amountIn`.
    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256 out) {
        require(!broken, "router broken");
        out = _out(p.tokenIn, p.amountIn);
        require(out >= p.amountOutMinimum, "Too little received");
        MockToken(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        usdc.mint(p.recipient, out);
    }

    /// @notice Swaps for exactly `amountOut`.
    function exactOutputSingle(ExactOutputSingleParams calldata p) external returns (uint256 amountIn) {
        require(!broken, "router broken");
        uint256 unit = 10 ** MockToken(p.tokenIn).decimals();
        amountIn = (p.amountOut * unit * 10_000 + usdcPerUnit * (10_000 - slippageBps) - 1)
            / (usdcPerUnit * (10_000 - slippageBps));
        require(amountIn <= p.amountInMaximum, "Too much requested");
        MockToken(p.tokenIn).transferFrom(msg.sender, address(this), amountIn);
        usdc.mint(p.recipient, p.amountOut);
    }

    function _out(address tokenIn, uint256 amountIn) internal view returns (uint256) {
        uint256 unit = 10 ** MockToken(tokenIn).decimals();
        return amountIn * usdcPerUnit * (10_000 - slippageBps) / (unit * 10_000);
    }
}

/// @notice Account double whose public `sweep()` applies a balance to the owner's debt on a
/// `MockVenue`, like the real account would.
contract SweepingAccountMock {
    /// @notice Number of `sweep()` calls.
    uint256 public sweeps;
    /// @notice When true, `sweep()` reverts.
    bool public broken;
    address internal venue;
    address internal owner;
    uint256 internal collateralUsd;
    uint256 internal debtAfterSweep;

    /// @notice Sets what the next sweep does to the owner's position.
    function setSweepEffect(address venue_, address owner_, uint256 collateralUsd_, uint256 debtAfterSweep_) external {
        venue = venue_;
        owner = owner_;
        collateralUsd = collateralUsd_;
        debtAfterSweep = debtAfterSweep_;
    }

    /// @notice Makes `sweep()` revert.
    function setBroken(bool broken_) external {
        broken = broken_;
    }

    /// @notice Applies the configured repayment.
    function sweep() external returns (uint256) {
        require(!broken, "sweep broken");
        ++sweeps;
        if (venue != address(0)) {
            (bool ok,) = venue.call(
                abi.encodeWithSignature("setPosition(address,uint256,uint256)", owner, collateralUsd, debtAfterSweep)
            );
            require(ok, "setPosition failed");
        }
        return 0;
    }
}

/// @notice Venue whose reads all revert, to check that the alarm skips it.
contract RevertingVenueMock {
    /// @notice Always reverts.
    function health(address) external pure returns (uint256, uint256, uint256) {
        revert("venue down");
    }

    /// @notice Always reverts.
    function debtOf(address) external pure returns (uint256) {
        revert("venue down");
    }
}
