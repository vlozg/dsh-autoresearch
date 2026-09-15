/**
 * FSD shared-layer gateway to the host↔client wire contract
 * (src/shared/wire.ts — the typechecker-shared cross-face shapes).
 *
 * This is the ONLY client file allowed to reach outside src/client: every
 * layer imports the contract from here (`shared/wire`), so FSD's one-way
 * dependency rule holds and the two faces stay decoupled. Type-only — erased
 * at build, zero runtime coupling to the host hexagon.
 */
export type * from "../../shared/wire";
