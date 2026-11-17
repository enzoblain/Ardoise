import { parseAbi } from "viem";

/**
 * Events of `IArdoise` (contracts/src/interfaces/IArdoise.sol). The
 * statement is built from these alone, as the interface intends.
 */
export const ardoiseEventsAbi = parseAbi([
  "event Paid(uint256 indexed lineId, address indexed venue, uint256 amount, uint256 maxFee, uint256 borrowed, uint32 rateBps, uint32 destinationDomain, bytes32 payee, string memo)",
  "event LineRepaid(uint256 indexed lineId, address indexed payer, uint256 amount)",
]);
