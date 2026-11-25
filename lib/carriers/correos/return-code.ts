import { envOr } from '@/lib/env';

/**
 * The second tracking code every Correos return travels under.
 *
 * THIS IS THE THING THE SYSTEM DID NOT KNOW. When Correos sends a parcel back
 * to us they do not add events to the original code — they create a NEW
 * shipment, with its own code, whose destination is our warehouse. The original
 * code's last event is the one that says a return was started, and then it goes
 * quiet for ever. So a parcel that came back on 19 November still read "Wrong
 * address, 18 November" a week later, and nothing in the database had ever
 * reached `returned`: the leg that ends at our door is always the second code.
 *
 *   PKA6TP9800129340147006H   the parcel out to the customer
 *   DXA6TP9800129340128012S   the same parcel coming back to us
 *
 * A 23-character Correos code is five fields:
 *
 *   PK A6TP980012934 01 47006 H
 *   │  │             │  │     └ check letter over the other 22
 *   │  │             │  └─────── destination postcode
 *   │  │             └────────── parcel number within the shipment
 *   │  └──────────────────────── the core: this shipment, 13 characters
 *   └─────────────────────────── the product prefix
 *
 * The return keeps the prefix `DX`, the SAME core and parcel number, and
 * carries the postcode of wherever returns are delivered — 28012 for this
 * business. Only the check letter is recomputed. So the return code can be
 * worked out from the original with no network call at all, which is what
 * lets the catch-up fix eighty-seven parcels that were sent before any of
 * this existed.
 *
 * VERIFIED, NOT INFERRED. The operator collected 109 real codes — 87 originals,
 * 20 returns and two more — and `checkLetter` reproduces the check letter of
 * every one of them, while `returnCodeFor` derives all 20 real return codes
 * exactly from their originals. The pairs are in tests/return-code.test.ts and
 * they are the reason this is arithmetic rather than a guess.
 *
 * WHAT IT IS NOT. This is the check letter for a 23-character code and nothing
 * else. The 16-character EXPEDICIÓN that Correos' tracker reports as
 * `expeditionCode` ends in a letter computed some other way — `PKA6TP980012934`
 * works out to `T` here and the real expedición is `PKA6TP980012934D` — so this
 * must never be used to validate one. It would reject every expedición we have.
 *
 * AND WHAT IT CATCHES, measured over ten real codes rather than assumed:
 *
 *   · one wrong character — 97.3% of them. The 2.7% it cannot see are the
 *     thirteen pairs whose values are exactly 23 apart: 0/N 1/O 2/P 3/Q 4/R
 *     5/S 6/T 7/U 8/V 9/W A/X B/Y C/Z.
 *   · a random string — all but one in 36.
 *   · TWO CHARACTERS SWAPPED — none of them, ever. A sum does not care what
 *     order it is added in, so every transposition of a valid code is also
 *     valid. 0 of 2,114 caught.
 *
 * Which is the right trade for what it is for: a Code128 misread is a wrong
 * character or a wrong length, and both of those it sees. It is a guard
 * against a bad read, not proof that a number is real — the only proof of that
 * is a parcel with the code on it.
 */

/**
 * The same 23 letters the Spanish DNI uses, in the same order.
 *
 * Correos did not invent a checksum; they took the national one. Which is why
 * the `+ 10` below is there and why it looks arbitrary: it is the offset that
 * makes the whole set of real codes come out right, and it was found by
 * fitting 109 of them rather than reasoned from a specification nobody has.
 */
const CHECK_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/**
 * Which journey an event belongs to.
 *
 * Return events are stored on the SAME shipment row — it is one parcel and the
 * operator reads one timeline — so this is what keeps them from being read as
 * progress towards the customer. See db/migrations/0008_return_leg.sql.
 */
export type EventLeg = 'outbound' | 'return';

/**
 * Where a return code came from.
 *
 * `correos` — they named it themselves, in `associatedShipments`.
 * `derived` — worked out here from the original.
 *
 * Kept apart so a code Correos confirmed is never recomputed: moving the
 * returns address changes what we would derive, and must not rewrite a code
 * they told us.
 */
export type ReturnCodeSource = 'correos' | 'derived';

/** The prefix every return shipment carries. */
export const RETURN_PREFIX = 'DX';

/** A full Correos tracking code: prefix, core, parcel number, postcode, letter. */
export const CODE_LENGTH = 23;

/** Where each field starts and ends, as string indices. */
const PREFIX = [0, 2] as const;
/** The core plus the parcel number: the part a return keeps unchanged. */
const CORE_WITH_PARCEL = [2, 17] as const;
/** The core alone, which is all a 16-character EXPEDICIÓN carries. */
const CORE = [2, 15] as const;
const POSTCODE = [17, 22] as const;

/** A–Z and 0–9 only, uppercase. The same normalisation the Scanner uses. */
function normalise(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Digits are worth their value; letters carry on from there, A = 10. */
function valueOf(c: string): number {
  return /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
}

/**
 * The check letter for the first 22 characters of a code.
 *
 * Exported because the Scanner validates every barcode it reads with it: a
 * misread bar or a mistyped character almost always breaks the sum, which
 * turns a silently wrong parcel number into a refusal the worker sees while
 * the label is still in their hand.
 */
export function checkLetter(body: string): string {
  const sum = [...normalise(body)].reduce((n, c) => n + valueOf(c), 0);
  return CHECK_LETTERS[((sum % 23) + 10) % 23];
}

/** Is this a 23-character code whose last letter matches the other 22? */
export function hasValidCheckLetter(code: string): boolean {
  const clean = normalise(code);
  if (clean.length !== CODE_LENGTH) return false;
  return checkLetter(clean.slice(0, CODE_LENGTH - 1)) === clean[CODE_LENGTH - 1];
}

/** The part a code shares with its return: the core and the parcel number. */
export function coreWithParcel(code: string): string {
  return normalise(code).slice(...CORE_WITH_PARCEL);
}

/**
 * The core alone, 13 characters.
 *
 * This is the widest thing a 16-character EXPEDICIÓN can be matched on, since
 * an expedición names the shipment and carries no parcel number.
 */
export function coreOf(code: string): string {
  return normalise(code).slice(...CORE);
}

/** True for a code with the return prefix. */
export function isReturnCode(code: string): boolean {
  return normalise(code).startsWith(RETURN_PREFIX);
}

/**
 * Where returns are delivered. `RETURN_POSTCODE`, default 28012.
 *
 * A variable rather than a constant because it is a property of this business's
 * returns address, not of Correos: a warehouse move changes it, and every
 * return code derived afterwards has to carry the new one. Codes Correos
 * themselves told us are unaffected — those are stored with
 * `return_code_source = 'correos'` and never recomputed.
 */
export const DEFAULT_RETURN_POSTCODE = '28012';

export function returnPostcode(): string {
  const raw = normalise(envOr('RETURN_POSTCODE', DEFAULT_RETURN_POSTCODE));
  // A postcode that is not five digits would produce codes of the wrong length
  // that Correos would simply never answer. The default is better than that.
  return /^\d{5}$/.test(raw) ? raw : DEFAULT_RETURN_POSTCODE;
}

/**
 * The code this parcel's return will travel under, worked out from the
 * original.
 *
 * Null rather than a guess when the input is not a 23-character code. A
 * 16-character EXPEDICIÓN cannot produce one: it carries no parcel number, and
 * inventing "01" would give a code for the first box of a shipment whether or
 * not that is the box in question.
 */
export function returnCodeFor(
  original: string,
  postcode: string = returnPostcode(),
): string | null {
  const clean = normalise(original);
  if (clean.length !== CODE_LENGTH) return null;
  // Deriving a return code from a return code would be nonsense, and quietly
  // produces something plausible: the core survives, so it comes back with a
  // different postcode and a fresh letter.
  if (isReturnCode(clean)) return null;

  const body = RETURN_PREFIX + clean.slice(...CORE_WITH_PARCEL) + normalise(postcode);
  if (body.length !== CODE_LENGTH - 1) return null;
  return body + checkLetter(body);
}

/** The postcode printed inside a 23-character code. */
export function postcodeOf(code: string): string | null {
  const clean = normalise(code);
  if (clean.length !== CODE_LENGTH) return null;
  return clean.slice(...POSTCODE);
}

/**
 * Do these two codes name the same parcel, one out and one back?
 *
 * Different prefixes, the same core and parcel number. Used by the Scanner to
 * put a DX label under the order it belongs to, and deliberately NOT used to
 * decide state: that comes from the return code stored on the shipment.
 */
export function sameParcelDifferentLeg(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (x.length !== CODE_LENGTH || y.length !== CODE_LENGTH) return false;
  if (x.slice(...PREFIX) === y.slice(...PREFIX)) return false;
  return coreWithParcel(x) === coreWithParcel(y);
}
