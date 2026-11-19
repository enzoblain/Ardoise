// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {ITokenMessengerV2} from "./cctp/ITokenMessengerV2.sol";
import {DebtLine, IArdoise} from "./interfaces/IArdoise.sol";
import {IArdoiseFactory} from "./interfaces/IArdoiseFactory.sol";
import {IGuard} from "./interfaces/IGuard.sol";
import {IVenue} from "./interfaces/IVenue.sol";

/// @title ArdoiseAccount
/// @notice A user's Ardoise account: each payment borrows exactly what it needs on the venue the
/// owner picks (`payVia`) or the cheapest one (`pay`), once the guard has checked the margin, delivers it on Arc or through CCTP
/// with Circle's Forwarding Service, and records one debt line.
/// @dev Deployed by `ArdoiseFactory`, one per owner. The collateral position stays in the owner's
/// wallet; the account only borrows within the allowances the owner granted to each venue
/// adapter, and only holds USDC between a borrow and its delivery or while it waits for
/// `sweep()`. Venues and guard are read from the factory on every call.
contract ArdoiseAccount is IArdoise {
    /// @dev CCTP domain of Arc.
    uint32 private constant ARC = 26;
    /// @dev "cctp-forward", the hook data that enables Circle's Forwarding Service.
    bytes32 private constant FORWARD_HOOK = "cctp-forward";
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    /// @notice Factory that deployed the account and holds the venue list and the guard.
    IArdoiseFactory public immutable factory;
    /// @inheritdoc IArdoise
    address public immutable owner;
    /// @notice USDC, the asset borrowed and paid.
    IERC20 public immutable usdc;
    /// @notice Circle CCTP V2 TokenMessenger used for payments to other chains.
    ITokenMessengerV2 public immutable tokenMessenger;
    /// @notice Finality threshold passed to CCTP (2000, standard: attested in about 0.5 s from
    /// Arc, where Circle offers no separate fast transfer).
    uint32 public immutable minFinalityThreshold;

    /// @dev Stored form of a debt line; `accruedInterest` is computed on read.
    struct Line {
        IVenue venue;
        uint256 principal;
        uint256 repaid;
        uint32 rateBps;
        uint32 destinationDomain;
        uint64 openedAt;
        bool closed;
        bytes32 payee;
        string memo;
    }

    /// @dev Debt lines; line `id` is at index `id - 1`.
    Line[] private _lines;
    /// @dev Index of the oldest line that may still be open, so `sweep()` skips repaid ones.
    uint256 private _firstOpen;

    uint256 private _perPaymentCap;
    uint256 private _dailyCap;
    uint256 private _spentToday;
    uint256 private _spentDay;

    uint256 private _locked = 1;

    /// @notice Thrown when a payment amount is zero.
    error ZeroAmount();
    /// @notice Thrown when a payment on Arc carries a CCTP fee.
    /// @param maxFee The rejected fee.
    error FeeOnArc(uint256 maxFee);
    /// @notice Thrown when a venue sends less than the payment needs.
    /// @param expected Amount requested from the venue.
    /// @param received Amount the account received.
    error BorrowShortfall(uint256 expected, uint256 received);
    /// @notice Thrown when a token transfer or approval returns false.
    error TokenCallFailed();
    /// @notice Thrown on a reentrant call to `pay`, `repay` or `sweep`.
    error Reentrancy();
    /// @notice Thrown by `pay` while the factory has no guard: payments wait for one, repayments
    /// and `sweep` do not.
    error GuardNotSet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // The factory always passes its caller as the owner, which cannot be the zero address.
    // forge-lint: disable-next-item(missing-zero-check)
    /// @notice Deploys the account of `owner_`; the caller is the factory.
    /// @param owner_ Wallet that owns the account and the collateral position.
    /// @param usdc_ USDC token.
    /// @param tokenMessenger_ CCTP V2 TokenMessenger.
    /// @param minFinalityThreshold_ CCTP finality threshold for payments to other chains.
    /// @param perPaymentCap Initial maximum amount per payment, in USDC.
    /// @param dailyCap Initial maximum total of payments per UTC day, in USDC.
    constructor(
        address owner_,
        IERC20 usdc_,
        ITokenMessengerV2 tokenMessenger_,
        uint32 minFinalityThreshold_,
        uint256 perPaymentCap,
        uint256 dailyCap
    ) {
        factory = IArdoiseFactory(msg.sender);
        owner = owner_;
        usdc = usdc_;
        tokenMessenger = tokenMessenger_;
        minFinalityThreshold = minFinalityThreshold_;
        _setCaps(perPaymentCap, dailyCap);
    }

    // ----- Configuration -----

    /// @inheritdoc IArdoise
    function ARC_DOMAIN() external pure returns (uint32) {
        return ARC;
    }

    /// @inheritdoc IArdoise
    function guard() public view returns (IGuard) {
        return factory.guard();
    }

    /// @inheritdoc IArdoise
    function venues() public view returns (IVenue[] memory) {
        return factory.venues();
    }

    // forge-lint: disable-next-item(block-timestamp)
    /// @inheritdoc IArdoise
    function caps() external view returns (uint256 perPayment, uint256 daily, uint256 spentToday) {
        return (_perPaymentCap, _dailyCap, _spentDay == _today() ? _spentToday : 0);
    }

    /// @inheritdoc IArdoise
    function setCaps(uint256 perPayment, uint256 daily) external onlyOwner {
        _setCaps(perPayment, daily);
    }

    // ----- Payments -----

    // Venues come from the admin-set factory list, which stays short; a venue that cannot answer
    // is treated as unavailable rather than blocking payments.
    // forge-lint: disable-next-item(calls-loop)
    /// @inheritdoc IArdoise
    /// @dev Venues whose `available()` or `rate()` reverts are skipped, and so is a venue whose
    /// guard check reverts; ties go to the first venue in the factory's list. The guard is asked
    /// in order of rate and the first venue it allows in full wins, so a cheaper venue where the
    /// owner has no position (or not enough margin) never blocks a payment another venue can
    /// make. When no venue is allowed in full, the one allowing the most is returned, and
    /// `pay()` then reverts with `PaymentRefused` and that amount. Without a guard, the cheapest
    /// venue with enough liquidity is returned. A guard check that reverts on every venue ends in
    /// `NoVenueAvailable`, which hides the guard's own error. Cost: a venue the guard allows only
    /// in part costs its full search (about 25 `healthAfter` calls), and `pay()` asks the guard
    /// again for the chosen venue; acceptable with the factory's two venues.
    function bestVenue(uint256 amount) public view returns (IVenue venue) {
        IVenue[] memory list = venues();
        uint256 n = list.length;
        uint256[] memory rates = new uint256[](n);
        bool[] memory candidate = new bool[](n);
        for (uint256 i = 0; i < n; ++i) {
            try list[i].available() returns (uint256 liquidity) {
                if (liquidity < amount) continue;
            } catch {
                continue;
            }
            try list[i].rate() returns (uint256 rateBps) {
                rates[i] = rateBps;
                candidate[i] = true;
            } catch {
                continue;
            }
        }
        IGuard currentGuard = guard();
        uint256 mostAllowed = 0;
        venue = IVenue(address(0));
        for (uint256 k = 0; k < n; ++k) {
            // Next candidate in order of rate, the earlier one on a tie.
            uint256 next = n;
            for (uint256 i = 0; i < n; ++i) {
                if (candidate[i] && (next == n || rates[i] < rates[next])) next = i;
            }
            if (next == n) break;
            candidate[next] = false;
            if (address(currentGuard) == address(0)) return list[next];
            try currentGuard.checkMargin(owner, list[next], amount) returns (uint256 allowed) {
                if (allowed >= amount) return list[next];
                if (address(venue) == address(0) || allowed > mostAllowed) {
                    venue = list[next];
                    mostAllowed = allowed;
                }
            } catch {
                continue;
            }
        }
        if (address(venue) == address(0)) revert NoVenueAvailable(amount);
    }

    /// @inheritdoc IArdoise
    /// @dev Same checks, delivery and reverts as `payVia`, on the venue `bestVenue(amount + maxFee)`
    /// returns; the caps are checked before the venue is chosen.
    function pay(uint256 amount, uint32 destinationDomain, bytes32 payee, uint256 maxFee, string calldata memo)
        external
        nonReentrant
        onlyOwner
        returns (uint256 lineId)
    {
        return _pay(IVenue(address(0)), amount, destinationDomain, payee, maxFee, memo);
    }

    /// @inheritdoc IArdoise
    /// @dev Reverts with `UnknownVenue` before any other check when `venue` is not in the
    /// factory's list, so the owner can never borrow through an adapter the admin did not add.
    function payVia(
        IVenue venue,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 payee,
        uint256 maxFee,
        string calldata memo
    ) external nonReentrant onlyOwner returns (uint256 lineId) {
        if (address(venue) == address(0) || !_isVenue(venue)) revert UnknownVenue(venue);
        return _pay(venue, amount, destinationDomain, payee, maxFee, memo);
    }

    // ----- Repayments -----

    /// @inheritdoc IArdoise
    /// @dev Repays through the line's venue on behalf of the owner; whatever the venue does not
    /// pull goes back to the caller. The line also closes when the owner's debt on that venue
    /// reaches 0, which covers debt repaid directly on the venue. Non-reentrant.
    function repay(uint256 lineId, uint256 amount) external nonReentrant returns (uint256 repaid) {
        Line storage l = _line(lineId);
        if (l.closed) revert LineAlreadyRepaid(lineId);
        (repaid,) = _repayLine(lineId, l, amount, msg.sender);
    }

    // Repays through each line's venue inside the non-reentrant lock.
    // forge-lint: disable-next-item(calls-loop, reentrancy-no-eth, reentrancy-events)
    /// @inheritdoc IArdoise
    /// @dev Venues are served in order of health factor, lowest first (ties keep the factory's
    /// order), so the balance goes to the position closest to liquidation: with Aave V4 and
    /// Morpho as separate positions, repaying a line on the healthy one would leave the other in
    /// danger. For each venue, its open lines are repaid oldest first, then whatever remains of
    /// the owner's debt there: the line estimates use simple interest while venues compound, and
    /// the owner may have debt opened outside Ardoise. Open lines on a venue the factory no longer
    /// lists come last. Lines whose venue debt is already 0 are closed on the way at no cost; a
    /// venue that refuses the repayment is skipped rather than blocking the sweep, so the keeper
    /// is never stuck behind one line. Anything left after that stays in the account.
    function sweep() external nonReentrant returns (uint256 repaid) {
        uint256 balance = usdc.balanceOf(address(this));
        uint256 count = _lines.length;
        uint256 first = _firstOpen;
        while (first < count && _lines[first].closed) ++first;
        _firstOpen = first;
        if (balance == 0) return 0;

        IVenue[] memory order = _byHealth(venues());
        uint256 done;
        for (uint256 v = 0; v < order.length && balance > 0; ++v) {
            (done, balance) = _sweepLines(order, order[v], first, balance);
            repaid += done;
            (bool ok, uint256 debt) = _debtOf(order[v]);
            if (!ok || debt == 0 || balance == 0) continue;
            (, uint256 venueRepaid, uint256 spent) = _venueRepay(order[v], _min(balance, debt), address(this));
            repaid += venueRepaid;
            balance -= spent;
        }
        (done,) = _sweepLines(order, IVenue(address(0)), first, balance);
        repaid += done;
    }

    /// @notice Whether a debt line is closed: fully repaid by its own estimate, or its venue
    /// debt reached 0.
    /// @dev Not part of `IArdoise`: `DebtLine` has no closed flag, and a line closed because the
    /// venue debt reached 0 may show `repaid` below `principal`. Reverts with `UnknownLine`.
    /// @param lineId Debt line identifier.
    /// @return True if `repay` would revert with `LineAlreadyRepaid`.
    function closed(uint256 lineId) external view returns (bool) {
        return _line(lineId).closed;
    }

    // ----- Views -----

    /// @inheritdoc IArdoise
    function lines() external view returns (DebtLine[] memory all) {
        all = new DebtLine[](_lines.length);
        for (uint256 i = 0; i < all.length; ++i) {
            all[i] = _toDebtLine(i + 1, _lines[i]);
        }
    }

    /// @inheritdoc IArdoise
    function line(uint256 lineId) external view returns (DebtLine memory) {
        return _toDebtLine(lineId, _line(lineId));
    }

    /// @inheritdoc IArdoise
    function health(IVenue venue) external view returns (uint256 healthFactor, uint256 collateralUsd, uint256 debtUsd) {
        return venue.health(owner);
    }

    // ----- Internals -----

    // Every external call goes to the admin-set venue and guard, USDC or CCTP, inside the
    // non-reentrant lock; the line can only be written once the venue has sent the tokens.
    // forge-lint: disable-next-item(reentrancy-no-eth, reentrancy-events, unused-return)
    /// @dev Shared by `pay` and `payVia`: `venue` is the zero address for `pay`, which then takes
    /// `bestVenue`. Reverts with `ZeroAmount`, `FeeOnArc` when `maxFee` is not 0 for a payment on
    /// Arc, `InvalidPayee`, `CapExceeded`, `NoVenueAvailable` (also when the chosen venue lacks
    /// the liquidity), `GuardNotSet` while the factory has no guard, `PaymentRefused`, and
    /// `BorrowShortfall` if the venue sends less than `amount + maxFee`. Payees on the known
    /// non-EVM CCTP domains (Noble 4, Solana 5, Sui 8, Aptos 9) may use all 32 bytes; every other
    /// domain needs a left-padded EVM address. A payment to another chain burns `amount + maxFee`
    /// through CCTP with the Forwarding Service, which mints on the destination without the payee
    /// paying gas; anything the venue sends beyond that stays in the account for `sweep()`.
    function _pay(
        IVenue venue,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 payee,
        uint256 maxFee,
        string calldata memo
    ) private returns (uint256 lineId) {
        if (amount == 0) revert ZeroAmount();
        if (destinationDomain == ARC && maxFee != 0) revert FeeOnArc(maxFee);
        _checkPayee(destinationDomain, payee);
        uint256 total = amount + maxFee;
        _spend(total);

        if (address(venue) == address(0)) {
            venue = bestVenue(total);
        } else if (venue.available() < total) {
            revert NoVenueAvailable(total);
        }
        IGuard currentGuard = guard();
        if (address(currentGuard) == address(0)) revert GuardNotSet();
        uint256 allowed = currentGuard.checkMargin(owner, venue, total);
        if (allowed < total) revert PaymentRefused(total, allowed);
        // Capped at type(uint32).max first, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 rateBps = uint32(_min(venue.rate(), type(uint32).max));

        uint256 balanceBefore = usdc.balanceOf(address(this));
        venue.borrow(owner, total);
        uint256 borrowed = usdc.balanceOf(address(this)) - balanceBefore;
        if (borrowed < total) revert BorrowShortfall(total, borrowed);

        _lines.push(
            Line({
                venue: venue,
                principal: borrowed,
                repaid: 0,
                rateBps: rateBps,
                destinationDomain: destinationDomain,
                // forge-lint: disable-next-line(unsafe-typecast)
                openedAt: uint64(block.timestamp), // fits until the year 584 billion
                closed: false,
                payee: payee,
                memo: memo
            })
        );
        lineId = _lines.length;

        if (destinationDomain == ARC) {
            _call(usdc.transfer(address(uint160(uint256(payee))), total));
        } else {
            _call(usdc.approve(address(tokenMessenger), total));
            tokenMessenger.depositForBurnWithHook(
                total,
                destinationDomain,
                payee,
                address(usdc),
                bytes32(0),
                maxFee,
                minFinalityThreshold,
                abi.encodePacked(FORWARD_HOOK)
            );
        }

        emit Paid(lineId, venue, amount, maxFee, borrowed, rateBps, destinationDomain, payee, memo);
    }

    /// @dev Whether `venue` is in the factory's venue list.
    function _isVenue(IVenue venue) private view returns (bool) {
        return _contains(venues(), venue);
    }

    // Only reached from `repay` and `sweep`, both non-reentrant.
    // forge-lint: disable-next-item(calls-loop, reentrancy-no-eth, reentrancy-events, block-timestamp)
    /// @dev Repays up to `amount` of line `lineId` through its venue. `payer` is the caller for
    /// `repay` (a venue revert bubbles up) or the account itself for `sweep` (a venue revert
    /// leaves the line untouched). Returns the debt the venue restored and the USDC spent.
    function _repayLine(uint256 lineId, Line storage l, uint256 amount, address payer)
        private
        returns (uint256 repaid, uint256 spent)
    {
        uint256 toRepay = _min(amount, _outstanding(l));
        IVenue venue = l.venue;

        if (toRepay > 0) {
            bool ok;
            (ok, repaid, spent) = _venueRepay(venue, toRepay, payer);
            if (!ok) return (0, 0);
            l.repaid += repaid;
        }

        // The estimate may differ from what the venue charges: the venue's debt is the truth.
        (bool known, uint256 venueDebt) = _debtOf(venue);
        bool done = l.repaid >= l.principal + _interest(l) || (known && venueDebt == 0);
        if (done) l.closed = true;
        if (repaid > 0 || done) emit LineRepaid(lineId, payer, repaid);
    }

    // Only reached from `repay` and `sweep`, both non-reentrant.
    // forge-lint: disable-next-item(calls-loop, reentrancy-no-eth)
    /// @dev Repays `amount` of the owner's debt on `venue`, pulling it from `payer` unless the
    /// payer is the account itself, and refunding what the venue does not take. For an external
    /// payer a venue revert bubbles up; for the account (`sweep`) it returns `ok = false` with
    /// the approval cleared, so one failing venue cannot block the others.
    function _venueRepay(IVenue venue, uint256 amount, address payer)
        private
        returns (bool ok, uint256 repaid, uint256 spent)
    {
        uint256 balanceBefore = usdc.balanceOf(address(this));
        bool external_ = payer != address(this);
        if (external_) {
            // `payer` is always `msg.sender` here: `repay` is the only caller that passes another
            // address than the account.
            // forge-lint: disable-next-line(arbitrary-send-erc20)
            _call(usdc.transferFrom(payer, address(this), amount));
            balanceBefore += amount;
        }
        _call(usdc.approve(address(venue), amount));
        try venue.repay(owner, amount) returns (uint256 restored) {
            repaid = restored;
            ok = true;
        } catch (bytes memory reason) {
            if (external_) {
                assembly ("memory-safe") {
                    // forge-lint: disable-next-line(require-revert-in-loop)
                    revert(add(reason, 32), mload(reason))
                }
            }
            _call(usdc.approve(address(venue), 0));
            return (ok, repaid, spent); // all still zero: nothing was repaid
        }
        spent = balanceBefore - usdc.balanceOf(address(this));
        if (spent < amount) {
            _call(usdc.approve(address(venue), 0));
            if (external_) _call(usdc.transfer(payer, amount - spent));
        }
    }

    // Only reached from `sweep`, which is non-reentrant.
    // forge-lint: disable-next-item(calls-loop, reentrancy-no-eth, reentrancy-events)
    /// @dev Applies `balance` to the open lines on `venue`, oldest first, from index `first`. With
    /// `venue` zero, it takes the open lines whose venue is not in `listed` instead. Returns the
    /// debt repaid and the balance left.
    function _sweepLines(IVenue[] memory listed, IVenue venue, uint256 first, uint256 balance)
        private
        returns (uint256 repaid, uint256 left)
    {
        left = balance;
        uint256 count = _lines.length;
        for (uint256 i = first; i < count && left > 0; ++i) {
            Line storage l = _lines[i];
            if (l.closed) continue;
            if (address(venue) == address(0) ? _contains(listed, l.venue) : l.venue != venue) continue;
            (uint256 lineRepaid, uint256 spent) = _repayLine(i + 1, l, left, address(this));
            repaid += lineRepaid;
            left -= spent;
        }
    }

    // The venue list is admin-set and short.
    // forge-lint: disable-next-item(calls-loop)
    /// @dev `list` sorted by the owner's health factor on each venue, lowest first, keeping the
    /// list's order on ties; a venue that cannot report its health goes last.
    function _byHealth(IVenue[] memory list) private view returns (IVenue[] memory) {
        uint256 n = list.length;
        uint256[] memory hf = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            hf[i] = type(uint256).max;
            try list[i].health(owner) returns (uint256 h, uint256, uint256) {
                hf[i] = h;
            } catch {}
        }
        // Insertion sort, stable: the list holds a handful of venues.
        for (uint256 i = 1; i < n; ++i) {
            IVenue venue = list[i];
            uint256 h = hf[i];
            uint256 j = i;
            while (j > 0 && hf[j - 1] > h) {
                list[j] = list[j - 1];
                hf[j] = hf[j - 1];
                --j;
            }
            list[j] = venue;
            hf[j] = h;
        }
        return list;
    }

    function _contains(IVenue[] memory list, IVenue venue) private pure returns (bool) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == venue) return true;
        }
        return false;
    }

    // forge-lint: disable-next-item(calls-loop)
    /// @dev The owner's debt on `venue`; `ok` is false if the venue cannot answer.
    function _debtOf(IVenue venue) private view returns (bool ok, uint256 debt) {
        try venue.debtOf(owner) returns (uint256 d) {
            ok = true;
            debt = d;
        } catch {}
    }

    // The timestamp only feeds an interest estimate; a few seconds of drift are irrelevant.
    // forge-lint: disable-next-item(block-timestamp)
    /// @dev Simple interest at the line's rate since it was opened, rounded down so that repaying
    /// the principal right after a payment closes the line instead of leaving 1 wei open; the
    /// venue's debt, not this estimate, is what is owed. Once a line is closed, the interest it
    /// shows is what was repaid beyond the principal.
    function _interest(Line storage l) private view returns (uint256) {
        if (l.closed) return l.repaid > l.principal ? l.repaid - l.principal : 0;
        return l.principal * l.rateBps * (block.timestamp - l.openedAt) / (BPS * YEAR);
    }

    // The timestamp only feeds the interest estimate.
    // forge-lint: disable-next-item(block-timestamp)
    /// @dev What the line still owes by its own estimate.
    function _outstanding(Line storage l) private view returns (uint256) {
        if (l.closed) return 0;
        uint256 due = l.principal + _interest(l);
        return due > l.repaid ? due - l.repaid : 0;
    }

    function _toDebtLine(uint256 lineId, Line storage l) private view returns (DebtLine memory) {
        return DebtLine({
            id: lineId,
            venue: l.venue,
            principal: l.principal,
            repaid: l.repaid,
            accruedInterest: _interest(l),
            rateBps: l.rateBps,
            destinationDomain: l.destinationDomain,
            openedAt: l.openedAt,
            payee: l.payee,
            memo: l.memo
        });
    }

    function _line(uint256 lineId) private view returns (Line storage) {
        if (lineId == 0 || lineId > _lines.length) revert UnknownLine(lineId);
        return _lines[lineId - 1];
    }

    // UTC days come from the timestamp; drift of a few seconds around midnight is acceptable.
    // forge-lint: disable-next-item(block-timestamp)
    /// @dev Checks both caps and records `total` as spent today.
    function _spend(uint256 total) private {
        uint256 day = _today();
        uint256 spent = _spentDay == day ? _spentToday : 0;
        uint256 dailyLeft = _dailyCap > spent ? _dailyCap - spent : 0;
        uint256 remaining = _min(_perPaymentCap, dailyLeft);
        if (total > remaining) revert CapExceeded(total, remaining);
        _spentDay = day;
        _spentToday = spent + total;
    }

    function _checkPayee(uint32 domain, bytes32 payee) private pure {
        if (payee == bytes32(0)) revert InvalidPayee(payee);
        bool nonEvm = domain == 4 || domain == 5 || domain == 8 || domain == 9;
        if (!nonEvm && uint256(payee) >> 160 != 0) revert InvalidPayee(payee);
    }

    function _setCaps(uint256 perPayment, uint256 daily) private {
        _perPaymentCap = perPayment;
        _dailyCap = daily;
        emit CapsUpdated(perPayment, daily);
    }

    function _today() private view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _call(bool ok) private pure {
        // Called from the sweep loop: one failed transfer must stop the whole sweep.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (!ok) revert TokenCallFailed();
    }
}
