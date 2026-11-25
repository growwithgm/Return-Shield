import { describe, it, expect, afterEach } from 'vitest';
import {
  CODE_LENGTH, DEFAULT_RETURN_POSTCODE, RETURN_PREFIX,
  checkLetter, coreOf, coreWithParcel, hasValidCheckLetter, isReturnCode,
  postcodeOf, returnCodeFor, returnPostcode, sameParcelDifferentLeg,
} from '@/lib/carriers/correos/return-code';

/**
 * The second code every Correos return travels under.
 *
 * THE TWENTY PAIRS BELOW ARE REAL. The operator collected them on 25 November
 * from Correos' public tracker, alongside 87 more originals and two further
 * codes — 109 in all — and the arithmetic in return-code.ts reproduces the
 * check letter of every one of them and derives all twenty returns exactly
 * from their originals. That is the whole reason the catch-up is allowed to
 * compute a code and poll it rather than wait for Correos to tell us one: it
 * is not a guess that happened to work twice.
 *
 * If a pair here ever fails, the arithmetic is wrong and every derived code in
 * the database is suspect. Do not adjust a vector to make the suite pass.
 */

/** original → the code its return travels under. From Correos' own tracker. */
const REAL_PAIRS: readonly (readonly [string, string])[] = [
  ['PKA6TP9800129340147006H', 'DXA6TP9800129340128012S'],
  ['PKA6TP9800108200128822S', 'DXA6TP9800108200128012F'],
  ['PKA6TP9800120280111130R', 'DXA6TP9800120280128012D'],
  ['PKA6TP9800123300104740Y', 'DXA6TP9800123300128012M'],
  ['PKA6TP9800129980129660B', 'DXA6TP9800129980128012W'],
  ['PKA6TP9800138300137007Z', 'DXA6TP9800138300128012B'],
  ['PKA6TP9800105960120150B', 'DXA6TP9800105960128012V'],
  ['PKA6TP9800117480139600K', 'DXA6TP9800117480128012V'],
  ['PKA6TP9800119670108303C', 'DXA6TP9800119670128012C'],
  ['PKA6TP9800123990115007L', 'DXA6TP9800123990128012C'],
  ['PKA6TP9800120000104720K', 'DXA6TP9800120000128012E'],
  ['PKA6TP9800138750141009C', 'DXA6TP9800138750128012C'],
  ['PKA6TP9800123530150002A', 'DXA6TP9800123530128012X'],
  ['PKA6TP9800138990146021W', 'DXA6TP9800138990128012A'],
  ['PKA6TP9800132500108226B', 'DXA6TP9800132500128012F'],
  ['PKA6TP9800100700141500T', 'DXA6TP9800100700128012G'],
  ['PKA6TP9800105730117003D', 'DXA6TP9800105730128012N'],
  ['PKA6TP9800109950146035R', 'DXA6TP9800109950128012C'],
  ['PKA6TP9800101750103179Q', 'DXA6TP9800101750128012X'],
  ['PKA6TP9800106680139011V', 'DXA6TP9800106680128012V'],
] as const;

const CRISTINA = 'PKA6TP9800129340147006H';
const CRISTINA_RETURN = 'DXA6TP9800129340128012S';

afterEach(() => { delete process.env.RETURN_POSTCODE; });

describe('deriving the return code', () => {
  it.each(REAL_PAIRS)('derives %s → %s', (original, expected) => {
    expect(returnCodeFor(original, DEFAULT_RETURN_POSTCODE)).toBe(expected);
  });

  it('reproduces the check letter of every real code, both legs', () => {
    // 40 codes, each validated against its own last character. If the
    // arithmetic were wrong in a way that happened to be self-consistent, this
    // is what would catch it.
    for (const [original, ret] of REAL_PAIRS) {
      expect(hasValidCheckLetter(original), original).toBe(true);
      expect(hasValidCheckLetter(ret), ret).toBe(true);
    }
  });

  it('keeps the core and the parcel number, and changes only the postcode', () => {
    expect(coreWithParcel(CRISTINA)).toBe('A6TP98001293401');
    expect(coreWithParcel(CRISTINA_RETURN)).toBe(coreWithParcel(CRISTINA));
    expect(postcodeOf(CRISTINA)).toBe('47006');
    expect(postcodeOf(CRISTINA_RETURN)).toBe(DEFAULT_RETURN_POSTCODE);
    expect(CRISTINA_RETURN.startsWith(RETURN_PREFIX)).toBe(true);
  });

  it('drops the parcel number for the core an EXPEDICIÓN carries', () => {
    expect(coreOf(CRISTINA)).toBe('A6TP980012934');
    expect(coreOf(CRISTINA)).toHaveLength(13);
  });

  it('refuses to derive one from anything that is not a 23-character code', () => {
    // A 16-character EXPEDICIÓN names the shipment and carries no parcel
    // number. Inventing "01" would give the code of the first box whether or
    // not that is the box in hand.
    expect(returnCodeFor('PKA6TP980012934D')).toBeNull();
    expect(returnCodeFor('PKA6TP980012934')).toBeNull();
    expect(returnCodeFor('HELLO')).toBeNull();
    expect(returnCodeFor('')).toBeNull();
  });

  it('refuses to derive a return of a return', () => {
    // It would quietly succeed: the core survives, so out comes a plausible
    // code with a fresh letter that names nothing.
    expect(returnCodeFor(CRISTINA_RETURN)).toBeNull();
  });

  it('reads a code written in lower case, with spaces and punctuation', () => {
    expect(returnCodeFor(' pka6tp9800129340147006-h ')).toBe(CRISTINA_RETURN);
    expect(hasValidCheckLetter(' pka6tp9800129340147006 h ')).toBe(true);
  });
});

describe('the returns postcode', () => {
  it('is 28012 unless RETURN_POSTCODE says otherwise', () => {
    expect(returnPostcode()).toBe('28012');
    process.env.RETURN_POSTCODE = '08830';
    expect(returnPostcode()).toBe('08830');
  });

  it('changes the derived code, letter and all', () => {
    const madrid = returnCodeFor(CRISTINA, '28012');
    const elsewhere = returnCodeFor(CRISTINA, '08012');

    expect(elsewhere).not.toBe(madrid);
    expect(elsewhere).toHaveLength(CODE_LENGTH);
    expect(postcodeOf(elsewhere!)).toBe('08012');
    expect(hasValidCheckLetter(elsewhere!)).toBe(true);
  });

  it('falls back when the variable is nonsense, rather than making bad codes', () => {
    // A postcode of the wrong length produces a code of the wrong length,
    // which Correos would simply never answer — and nothing would say why.
    process.env.RETURN_POSTCODE = 'nonsense';
    expect(returnPostcode()).toBe('28012');
    process.env.RETURN_POSTCODE = '123';
    expect(returnPostcode()).toBe('28012');
    process.env.RETURN_POSTCODE = '';
    expect(returnPostcode()).toBe('28012');
  });
});

describe('the check letter, and what it is worth', () => {
  it('refuses a code with one character wrong', () => {
    expect(hasValidCheckLetter('PKA6TP9800129350147006H')).toBe(false);
    expect(hasValidCheckLetter('PKA6TP9800129340147006X')).toBe(false);
  });

  it('refuses something that is not 23 characters at all', () => {
    expect(hasValidCheckLetter('PKA6TP980012934D')).toBe(false);
    expect(hasValidCheckLetter('HELLO')).toBe(false);
    expect(hasValidCheckLetter('')).toBe(false);
  });

  it('CANNOT see two characters swapped, and that is worth knowing', () => {
    /*
     * The check letter is a plain sum of the other 22 characters, and a sum
     * does not care what order it is added in. Measured over ten real codes:
     * 0 of 2,114 transpositions caught, against 97.3% of single-character
     * substitutions.
     *
     * Asserted rather than left unsaid, because "the check letter validates
     * the code" is the kind of sentence that grows into "a typo cannot get
     * through". A Code128 misread is a wrong character or a wrong length,
     * which is what this is for; it is not proof that a number is real.
     */
    const swapped = 'PKA6TP9800129430147006H'; // 34 → 43, same sum
    expect(swapped).not.toBe(CRISTINA);
    expect(hasValidCheckLetter(swapped)).toBe(true);
  });

  it('is computed over the first 22 characters', () => {
    expect(checkLetter(CRISTINA.slice(0, 22))).toBe(CRISTINA[22]);
    expect(checkLetter(CRISTINA_RETURN.slice(0, 22))).toBe(CRISTINA_RETURN[22]);
  });
});

describe('telling the two legs apart', () => {
  it('knows a return code by its prefix', () => {
    expect(isReturnCode(CRISTINA_RETURN)).toBe(true);
    expect(isReturnCode(CRISTINA)).toBe(false);
    expect(isReturnCode('dxa6tp9800129340128012s')).toBe(true);
  });

  it('pairs a return with its original', () => {
    for (const [original, ret] of REAL_PAIRS) {
      expect(sameParcelDifferentLeg(original, ret), `${original} ↔ ${ret}`).toBe(true);
      expect(sameParcelDifferentLeg(ret, original)).toBe(true);
    }
  });

  it('does not pair two different parcels, or a code with itself', () => {
    expect(sameParcelDifferentLeg(CRISTINA, 'PKA6TP9800108200128822S')).toBe(false);
    expect(sameParcelDifferentLeg(CRISTINA, CRISTINA)).toBe(false);
    expect(sameParcelDifferentLeg(CRISTINA_RETURN, CRISTINA_RETURN)).toBe(false);
    // Same core, different parcel number: box 01 and box 02 are two parcels.
    expect(sameParcelDifferentLeg('PKA6TP9800129340147006H', 'DXA6TP9800129340228012N')).toBe(false);
  });
});
