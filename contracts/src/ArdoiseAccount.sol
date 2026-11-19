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
/// `sweep()`. The guard is read from the factory on every call.
///
/// Venues need the owner's consent as well as the admin's: the account borrows from, approves
/// and pays only venues that are both in the factory's list and in its own accepted set. A
/// venue adapter is trusted with the account's USDC (`sweep()` approves it for what it reports
/// as debt), so a venue the admin lists later must not reach an account whose owner never
/// agreed to it. The accepted set starts as the factory's list when the account is created.
/// That snapshot trusts the list as it stands in the creation transaction, which the admin
/// may change just before it: the owner should read `acceptedVenues()` right after creating
/// the account and revoke anything unexpected before funding it or granting an allowance.
/// Only the owner changes the set afterwards, with `acceptVenue` and `revokeVenue`. A venue
/// the admin delists stays accepted and is usable again as soon as it is relisted, without
/// any event on the account: the owner should `revokeVenue` a delisted venue they no longer
/// want.
///
/// Whatever a venue reports, a debt line never costs more than its own estimate: each
/// repayment credits the line with the USDC that actually left, so the total paid through a
/// line stops at its principal plus simple interest at the rate recorded when it was opened,
/// itself capped at `MAX_LINE_RATE_BPS`. This is the whole exposure to a venue once it is
/// revoked or delisted.
contract ArdoiseAccount is IArdoise {
    /// @notice Largest number of venues an account accepts, so that `bestVenue` and `sweep()`
    /// call at most that many venues whatever the factory lists (they still read the whole
    /// factory list).
    uint256 public constant MAX_ACCEPTED_VENUES = 8;

    /// @dev CCTP domain of Arc.
    uint32 private constant ARC = 26;
    /// @dev "cctp-forward", the hook data that enables Circle's Forwarding Service.
    bytes32 private constant FORWARD_HOOK = "cctp-forward";
    uint256 private constant BPS = 10_000;

    /// @notice Highest rate recorded on a debt line, in bps a year: 100%.
    /// @dev The recorded rate only feeds the line's interest estimate, which is what a venue
    /// that is no longer usable may still be paid. The venues quote a few percent a year, and
    /// the real debt of an accepted venue is repaid by `sweep()` whatever the estimate says, so
    /// the cap costs an honest venue nothing; without it, a venue hostile at payment time could
    /// record a rate that makes its line's estimate reach the whole balance within hours.
    uint256 public constant MAX_LINE_RATE_BPS = 10_000;
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

    /// @dev Venues the owner accepted, at most `MAX_ACCEPTED_VENUES`, without duplicates.
    IVenue[] private _accepted;

    /// @notice Emitted when a venue joins the accepted set: at creation for the factory's list,
    /// then on `acceptVenue`.
    /// @param venue The accepted venue.
    event VenueAccepted(IVenue indexed venue);
    /// @notice Emitted when the owner removes a venue from the accepted set.
    /// @param venue The revoked venue.
    event VenueRevoked(IVenue indexed venue);

    /// @notice Thrown by `acceptVenue` for a venue the owner already accepted.
    /// @param venue The venue.
    error VenueAlreadyAccepted(IVenue venue);
    /// @notice Thrown by `revokeVenue` for a venue that is not in the accepted set.
    /// @param venue The venue.
    error VenueNotAccepted(IVenue venue);
    /// @notice Thrown by `acceptVenue` when the accepted set already holds
    /// `MAX_ACCEPTED_VENUES` venues.
    error TooManyVenues();
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
    /// @dev Accepts the venues the factory lists at this moment (duplicates once, and only the
    /// first `MAX_ACCEPTED_VENUES`), emitting `VenueAccepted` for each: creating the account is
    /// the owner's consent to that list, and to nothing the admin adds later.
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

        IVenue[] memory listed = IArdoiseFactory(msg.sender).venues();
        for (uint256 i = 0; i < listed.length && _accepted.length < MAX_ACCEPTED_VENUES; ++i) {
            if (_contains(_accepted, listed[i])) continue;
            _accepted.push(listed[i]);
            emit VenueAccepted(listed[i]);
        }
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
    /// @dev Only the venues that are both in the factory's list and accepted by the owner, each
    /// once, in the factory's order: the set `pay`, `payVia` and `sweep()` work with. A venue
    /// the admin lists after the account was created is absent until the owner calls
    /// `acceptVenue`; a venue the admin delists or the owner revokes leaves it at once. A
    /// delisted venue stays accepted, so it is back here as soon as the admin relists it.
    function venues() public view returns (IVenue[] memory usable) {
        IVenue[] memory listed = factory.venues();
        IVenue[] memory accepted = _accepted;
        usable = new IVenue[](accepted.length);
        uint256 count = 0;
        for (uint256 i = 0; i < listed.length && count < accepted.length; ++i) {
            if (!_contains(accepted, listed[i]) || _containsFirst(usable, count, listed[i])) continue;
            usable[count++] = listed[i];
        }
        // Shrinks the array to the venues found; it was allocated for `accepted.length`.
        assembly ("memory-safe") {
            mstore(usable, count)
        }
    }

    /// @notice Venues the owner accepted, whether or not the factory still lists them.
    /// @dev Not part of `IArdoise`. `venues()` is this set restricted to the factory's list. To
    /// be read right after `createAccount()`, and whenever the factory's list changes: a venue
    /// shown here that the factory no longer lists becomes usable again if it is relisted.
    /// @return The accepted venues, at most `MAX_ACCEPTED_VENUES`, in no particular order.
    function acceptedVenues() external view returns (IVenue[] memory) {
        return _accepted;
    }

    /// @notice Accepts a venue the factory lists, so that the account may borrow from it and
    /// `sweep()` may repay the owner's debt there. Owner only.
    /// @dev Not part of `IArdoise`. Accepting a venue trusts its adapter with the USDC the
    /// account holds: `sweep()` approves it for the debt it reports. Reverts with `NotOwner`,
    /// `UnknownVenue` if the factory does not list `venue`, `VenueAlreadyAccepted`, or
    /// `TooManyVenues` once `MAX_ACCEPTED_VENUES` are accepted (revoke one first).
    /// @param venue Venue to accept.
    function acceptVenue(IVenue venue) external onlyOwner {
        if (!_contains(factory.venues(), venue)) revert UnknownVenue(venue);
        if (_contains(_accepted, venue)) revert VenueAlreadyAccepted(venue);
        if (_accepted.length >= MAX_ACCEPTED_VENUES) revert TooManyVenues();
        _accepted.push(venue);
        emit VenueAccepted(venue);
    }

    /// @notice Removes a venue from the accepted set: the account no longer borrows from it, and
    /// `sweep()` no longer reads its health or repays the owner's whole debt there. Owner only.
    /// @dev Not part of `IArdoise`. Debt lines already opened on the venue stay repayable, with
    /// `repay` and at the end of `sweep()`. Each is credited with the USDC the venue actually
    /// takes, so the venue receives at most the sum of its open lines' estimates (principal plus
    /// simple interest at the rate recorded when the line was opened, at most
    /// `MAX_LINE_RATE_BPS`, less what was already repaid), however many times `sweep()` is
    /// called and whatever it reports. Interest runs while a line stays open. Reverts with
    /// `NotOwner` or `VenueNotAccepted`.
    /// @param venue Venue to revoke.
    function revokeVenue(IVenue venue) external onlyOwner {
        uint256 n = _accepted.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_accepted[i] != venue) continue;
            _accepted[i] = _accepted[n - 1];
            _accepted.pop();
            emit VenueRevoked(venue);
            return;
        }
        revert VenueNotAccepted(venue);
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

    // Venues are the listed ones the owner accepted, at most `MAX_ACCEPTED_VENUES`; a venue that
    // cannot answer is treated as unavailable rather than blocking payments.
    // forge-lint: disable-next-item(calls-loop)
    /// @inheritdoc IArdoise
    /// @dev Venues whose `available()` or `rate()` reverts are skipped, and so is a venue whose
    /// guard check reverts; ties go to the first venue in the factory's list. Only `venues()` are
    /// considered, so a venue the owner did not accept is never called nor chosen, whatever
    /// rate it quotes. The guard is asked in order of rate and the first venue it allows in full
    /// wins, so a cheaper venue where the owner has no position (or not enough margin) never
    /// blocks a payment another venue can make. When no venue is allowed in full, the one
    /// allowing the most is returned, and `pay()` then reverts with `PaymentRefused` and that amount. Without a guard, the cheapest
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
    /// @dev Reverts with `UnknownVenue` before the payment checks (after the owner check) when
    /// `venue` is not one of `venues()`: in the factory's list and accepted by the owner. The
    /// account therefore never borrows through an adapter the admin did not add, and a venue
    /// listed after the account was created needs `acceptVenue` first.
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
    /// @dev Only `venues()` are served this way, the listed venues the owner accepted: a venue
    /// the owner never accepted is never read, approved or paid, whatever debt and health it
    /// reports. They are served in order of health factor, lowest first (ties keep the factory's
    /// order), so the balance goes to the position closest to liquidation: with Aave V4 and
    /// Morpho as separate positions, repaying a line on the healthy one would leave the other in
    /// danger. For each venue, its open lines are repaid oldest first, then whatever remains of
    /// the owner's debt there: the line estimates use simple interest while venues compound, and
    /// the owner may have debt opened outside Ardoise. Open lines on a venue the factory no longer
    /// lists or the owner revoked come last: a line can only have been opened on a venue the
    /// owner had accepted, and such a venue receives at most what its open lines still owe by
    /// their own estimate, over any number of sweeps, since a line is credited with the USDC
    /// that left the account even when the venue reports less. Lines whose venue debt is
    /// already 0 are closed on the way at no cost. Anything left after that stays in the account.
    ///
    /// A misbehaving venue is skipped rather than blocking the others: one whose `repay`,
    /// `debtOf` or `health` reverts or returns malformed data, one that reports more than it
    /// was approved for (the report is capped at the approval), one that sends USDC to the
    /// account during `repay` (counted as nothing spent). Only the first 32 bytes of what a
    /// venue returns are read. What remains to a venue is gas: these calls forward the gas the
    /// sweep has, so a venue that burns it makes that sweep fail until its line is closed.
    ///
    /// The return value adds, for each line, the amount applied to it (the larger of the debt
    /// the venue reports as restored and the USDC it took) and, for the debt repaid beyond the
    /// lines on a usable venue, what that venue reports, never more than it was approved for.
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

    // Every external call goes to a listed venue the owner accepted, the admin-set guard, USDC
    // or CCTP, inside the non-reentrant lock; the line can only be written once the venue has
    // sent the tokens.
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
        // Capped at `MAX_LINE_RATE_BPS` first, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 rateBps = uint32(_min(venue.rate(), MAX_LINE_RATE_BPS));

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

    /// @dev Whether `venue` is one of `venues()`: listed by the factory and accepted by the owner.
    function _isVenue(IVenue venue) private view returns (bool) {
        return _contains(venues(), venue);
    }

    // Only reached from `repay` and `sweep`, both non-reentrant.
    // forge-lint: disable-next-item(calls-loop, reentrancy-no-eth, reentrancy-events, block-timestamp)
    /// @dev Repays up to `amount` of line `lineId` through its venue. `payer` is the caller for
    /// `repay` (a venue revert bubbles up) or the account itself for `sweep` (a venue revert
    /// leaves the line untouched). Returns the amount applied to the line and the USDC spent,
    /// both at most `amount` and at most what the line owes by its estimate.
    /// The amount applied is the larger of the debt the venue says it restored and the USDC it
    /// took: with honest venues the two are equal, and a venue that takes tokens while reporting
    /// less would otherwise keep its line open and be paid the same estimate again on every
    /// call. Counting what left bounds the total spent on a line by its estimate.
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
            if (spent > repaid) repaid = spent;
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
    /// the approval cleared, so one failing venue cannot block the others. Nothing the venue
    /// returns or does can make this revert for the account, short of using up the gas: a
    /// missing or short return value counts as nothing restored, `repaid` is capped at `amount`
    /// (the venue was approved for no more), and `spent` is 0 if the venue sent tokens instead
    /// of taking them. `spent` is at most `amount`.
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
        uint256 restored;
        (ok, restored) = _venueCall(venue, abi.encodeCall(IVenue.repay, (owner, amount)));
        if (!ok) {
            if (external_) {
                // The venue's return data is still the last one: nothing was called since.
                assembly ("memory-safe") {
                    let reason := mload(0x40)
                    returndatacopy(reason, 0, returndatasize())
                    // forge-lint: disable-next-line(require-revert-in-loop)
                    revert(reason, returndatasize())
                }
            }
            _call(usdc.approve(address(venue), 0));
            return (ok, repaid, spent); // repaid and spent still zero: nothing was repaid
        }
        repaid = _min(restored, amount);
        uint256 balanceAfter = usdc.balanceOf(address(this));
        spent = balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0;
        if (spent < amount) {
            _call(usdc.approve(address(venue), 0));
            if (external_) _call(usdc.transfer(payer, amount - spent));
        }
    }

    // Only reached from `sweep`, which is non-reentrant.
    // forge-lint: disable-next-item(calls-loop, reentrancy-no-eth, reentrancy-events)
    /// @dev Applies `balance` to the open lines on `venue`, oldest first, from index `first`. With
    /// `venue` zero, it takes the open lines whose venue is not in `listed` (the venues already
    /// served) instead. Returns the amount applied to the lines and the balance left.
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

    // The list holds at most `MAX_ACCEPTED_VENUES` venues, all accepted by the owner.
    // forge-lint: disable-next-item(calls-loop)
    /// @dev `list` sorted by the owner's health factor on each venue, lowest first, keeping the
    /// list's order on ties; a venue that cannot report its health goes last.
    function _byHealth(IVenue[] memory list) private view returns (IVenue[] memory) {
        uint256 n = list.length;
        uint256[] memory hf = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            (bool ok, uint256 h) = _venueRead(list[i], abi.encodeCall(IVenue.health, (owner)));
            hf[i] = ok ? h : type(uint256).max;
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
        return _containsFirst(list, list.length, venue);
    }

    /// @dev Whether `venue` is among the first `count` entries of `list`.
    function _containsFirst(IVenue[] memory list, uint256 count, IVenue venue) private pure returns (bool) {
        for (uint256 i = 0; i < count; ++i) {
            if (list[i] == venue) return true;
        }
        return false;
    }

    // forge-lint: disable-next-item(calls-loop)
    /// @dev The owner's debt on `venue`; `ok` is false if the venue cannot answer.
    function _debtOf(IVenue venue) private view returns (bool ok, uint256 debt) {
        return _venueRead(venue, abi.encodeCall(IVenue.debtOf, (owner)));
    }

    /// @dev Reads the first word a venue returns for a view call. `ok` is false if the call
    /// reverts or returns less than 32 bytes. A low-level call, because `try` does not catch
    /// malformed return data and copies all of it, whatever its size.
    function _venueRead(IVenue venue, bytes memory data) private view returns (bool ok, uint256 word) {
        assembly ("memory-safe") {
            ok := staticcall(gas(), venue, add(data, 0x20), mload(data), 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            if ok { word := mload(0x00) }
        }
    }

    /// @dev Calls a venue and reads the first word it returns, 0 if it returns less than 32
    /// bytes. `ok` is false only if the call reverts; the revert data is then the last return
    /// data. A low-level call, for the same reasons as `_venueRead`.
    function _venueCall(IVenue venue, bytes memory data) private returns (bool ok, uint256 word) {
        assembly ("memory-safe") {
            ok := call(gas(), venue, 0, add(data, 0x20), mload(data), 0x00, 0x20)
            if and(ok, gt(returndatasize(), 0x1f)) { word := mload(0x00) }
        }
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
