import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { say } from '@/lib/activity';
import { returnCodeFor, returnPostcode } from '@/lib/carriers/correos/return-code';
import { trackpub } from '@/lib/carriers/correos/trackpub';
import { getSetting, setSetting } from '@/lib/settings';
import { assignReturnCodes, pollReturnLegs, returnSignalSql } from './return-leg';
import type { ReturnLegProbe } from './return-probe';
import { remapKnownEvents } from './remap';

/**
 * The catch-up: eighty-seven parcels that came back before the system could
 * see it.
 *
 * Every one of them was sent while Return Shield watched only the outbound
 * code, so the moment Correos started the return the parcel went quiet and
 * stayed wherever the last event had left it — "Coming back" for fifty-eight,
 * "Wrong address" for twenty-nine, and `returned` for none, ever. The code
 * each of them came back under can be worked out from its own tracking number
 * (lib/carriers/correos/return-code.ts), so this does not need anybody to type
 * anything: it derives the codes, asks Correos about them, and files the
 * answers as the return leg.
 *
 * TWO PRESSES, like the TikTok handover, and for the same reason: the first
 * one writes nothing and says what the second one will do. See
 * lib/orders/tiktok-handover.ts, whose shape this follows deliberately —
 * `applyReturnCatchUp` re-runs the same read the preview did rather than
 * trusting a snapshot the operator may have been looking at for ten minutes.
 *
 * SAFE TO PRESS TWICE. Deriving a code that is already stored writes nothing;
 * re-mapping events that already have the right state writes nothing; and the
 * lookup queue excludes every parcel whose return has already been delivered,
 * so a second press asks only about the ones still travelling.
 */

/** How many parcels a single press will work through. */
const CATCH_UP_LIMIT = 500;

export interface ReturnCatchUpPreview {
  /**
   * Parcels Correos has said are coming back, by any of the three signals the
   * mapper reads. The number the rest of this is about.
   */
  comingBack: number;
  /** Of those, how many already know the code they come back under. */
  haveCode: number;
  /** How many codes this would work out from the original. */
  wouldDerive: number;
  /**
   * Parcels whose own tracking code cannot produce a return code: not a
   * 23-character Correos number at all, or already one. Nothing is invented
   * for these and they are left exactly as they are.
   */
  cannotDerive: number;
  /**
   * Parcels sitting in "Wrong address" that are really returns — Correos sent
   * "Dirección incorrecta" in phase DEVOLUCION and the old mapping read the
   * wording instead of the phase. These leave the Wrong-address worklist.
   */
  leavingWrongAddress: number;
  /** Return legs this would put to Correos. */
  wouldAsk: number;
  /** The postcode the derived codes will carry. `RETURN_POSTCODE`. */
  returnPostcode: string;
  /**
   * One worked example, so the operator can check the arithmetic against
   * Correos' own tracker before pressing anything: `['PKA6TP…', 'DXA6TP…']`.
   * Empty when there is nothing to do.
   */
  example: [string, string] | null;
  /**
   * What is NOT knowable before asking.
   *
   * How many parcels end up in Returned depends entirely on what Correos say
   * about each return code, and nothing in this database can answer that. The
   * operator's own count off Correos' tracker was 69 of 87 already delivered
   * back — but that is their research, not ours, and printing it as a
   * prediction would be inventing a number. So the preview says the honest
   * thing instead, and this is the sentence it says it with.
   */
  unknowable: string;
}

export interface ReturnCatchUpResult extends ReturnCatchUpPreview {
  /** Codes written. */
  derived: number;
  /** Event rows whose meaning changed, and parcels re-projected because of it. */
  remappedEvents: number;
  remappedParcels: number;
  /** What Correos actually said, including whether they answer a DX code. */
  probe: ReturnLegProbe;
  /** Parcels that are in `returned` now. */
  returnedNow: number;
}

interface CountsRow {
  coming_back: number;
  have_code: number;
  wrong_address: number;
  cannot_derive: number;
}

interface ExampleRow {
  shipping_code: string;
}

/**
 * The one query both halves use.
 *
 * Shared on purpose: the preview promises the operator a number and the apply
 * has to produce that number. Two queries that agree today are two queries
 * that disagree the first time somebody edits one.
 *
 * It counts on the SIGNAL rather than on the state, because the state is
 * exactly what is wrong — twenty-nine of these parcels say "Wrong address"
 * today. See `returnSignalSql`.
 */
async function comingBackCounts(): Promise<{ counts: CountsRow; example: string | null }> {
  const rows = rowsOf<CountsRow>(await getDb().execute(raw`
    WITH signalled AS (
      SELECT s.id, s.shipping_code, s.state, s.return_code
        FROM shipments s
       WHERE s.dropped_at IS NULL
         AND (
           s.state IN ('returning', 'returned', 'refused')
           OR (
             -- Same guard as assignReturnCodes, for the same reason: a
             -- parcel Correos handed to the customer is not a return waiting
             -- to be found, and running the event check over every delivered
             -- parcel is twenty thousand index scans to learn nothing. A
             -- return that starts after a delivery moves the state first.
             s.state NOT IN ('delivered', 'collected')
             AND EXISTS (
               SELECT 1 FROM shipment_events e
                WHERE e.shipment_id = s.id
                  AND e.leg = 'outbound'
                  AND ${returnSignalSql()}
             )
           )
         )
    )
    SELECT count(*)::int AS coming_back,
           count(return_code)::int AS have_code,
           count(*) FILTER (WHERE state = 'bad_address')::int AS wrong_address,
           -- A code we cannot derive from: not 23 characters, or already a
           -- return. Spelled here rather than in TypeScript so the number the
           -- operator reads is the number the database has.
           count(*) FILTER (
             WHERE length(regexp_replace(upper(shipping_code), '[^A-Z0-9]', '', 'g')) <> 23
                OR upper(shipping_code) LIKE 'DX%'
           )::int AS cannot_derive
      FROM signalled
  `));

  const example = rowsOf<ExampleRow>(await getDb().execute(raw`
    SELECT s.shipping_code
      FROM shipments s
     WHERE s.dropped_at IS NULL
       AND length(regexp_replace(upper(s.shipping_code), '[^A-Z0-9]', '', 'g')) = 23
       AND upper(s.shipping_code) NOT LIKE 'DX%'
       AND (
         s.state IN ('returning', 'returned', 'refused')
         OR (
           s.state NOT IN ('delivered', 'collected')
           AND EXISTS (
             SELECT 1 FROM shipment_events e
              WHERE e.shipment_id = s.id
                AND e.leg = 'outbound'
                AND ${returnSignalSql()}
           )
         )
       )
     ORDER BY s.created_at DESC
     LIMIT 1
  `))[0]?.shipping_code ?? null;

  return {
    counts: rows[0] ?? { coming_back: 0, have_code: 0, wrong_address: 0, cannot_derive: 0 },
    example,
  };
}

const UNKNOWABLE = 'How many of these end up in Returned depends on what Correos says about'
  + ' each return code, which nothing here can know before asking. Press the button and the'
  + ' answer below will say exactly what they said — including, the first time, whether they'
  + ' answer a DX code at all.';

function summarise(counts: CountsRow, example: string | null): ReturnCatchUpPreview {
  const postcode = returnPostcode();
  const derivable = counts.coming_back - counts.cannot_derive;
  const derived = example ? returnCodeFor(example, postcode) : null;

  return {
    comingBack: counts.coming_back,
    haveCode: counts.have_code,
    // Only the ones with no code yet. A parcel Correos has already named its
    // return for is not re-derived — that is the whole point of storing where
    // a code came from.
    wouldDerive: Math.max(0, derivable - counts.have_code),
    cannotDerive: counts.cannot_derive,
    leavingWrongAddress: counts.wrong_address,
    wouldAsk: derivable,
    returnPostcode: postcode,
    example: example && derived ? [example, derived] : null,
    unknowable: UNKNOWABLE,
  };
}

/** Nothing is written. The numbers the button is about to act on. */
export async function previewReturnCatchUp(): Promise<ReturnCatchUpPreview> {
  const { counts, example } = await comingBackCounts();
  return summarise(counts, example);
}

/**
 * Do it.
 *
 * Four steps, in this order and for these reasons:
 *
 *   1. Re-map the events already stored. "Dirección incorrecta" in phase
 *      DEVOLUCION now reads as a return, so this is what moves the twenty-nine
 *      out of the Wrong-address worklist — and it has to happen first, because
 *      a parcel whose state is still `bad_address` would otherwise be asked
 *      about and then have the answer overwritten by its own old mapping.
 *   2. Derive the return codes.
 *   3. Ask Correos about every one of them, quietly: these returns happened
 *      over the last month, and sixty-nine arrivals announced today, each with
 *      a "put it back in stock" task for a box the warehouse shelved in
 *      October, would be noise that buries the real work.
 *   4. Say, once, what happened.
 */
export async function applyReturnCatchUp(): Promise<ReturnCatchUpResult> {
  const { counts, example } = await comingBackCounts();
  const preview = summarise(counts, example);

  const remap = await remapKnownEvents();
  const assigned = await assignReturnCodes(CATCH_UP_LIMIT);

  const probe = await pollReturnLegs(
    trackpub({
      batchMode: await getSetting('correosBatchMode'),
      batchSize: await getSetting('correosBatchSize'),
    }),
    { limit: CATCH_UP_LIMIT, quiet: true },
  );
  await setSetting('correosReturnLeg', probe);

  const returnedNow = rowsOf<{ n: number }>(await getDb().execute(raw`
    SELECT count(*)::int AS n FROM shipments WHERE state = 'returned'
  `))[0]?.n ?? 0;

  /*
   * The line says what happened, which is not always "found returns".
   *
   * Built from whichever half did something, the way the TikTok handover's is:
   * a second press that re-maps nothing and derives nothing but learns that
   * eighteen returns are still travelling must not write "0 returns found" as
   * the one permanent record of the run.
   */
  if (probe.arrived > 0) {
    await say(
      `Return catch-up — ${probe.arrived} ${probe.arrived === 1 ? 'parcel is' : 'parcels are'}`
      + ` back with us according to Correos, from ${probe.asked} return`
      + ` ${probe.asked === 1 ? 'code' : 'codes'} asked about`,
    );
  } else if (assigned.derived > 0) {
    await say(
      `Return catch-up — worked out the return code for ${assigned.derived}`
      + ` ${assigned.derived === 1 ? 'parcel' : 'parcels'};`
      + ' Correos has nothing to say about them yet',
    );
  } else if (probe.failed > 0) {
    await say(`Return catch-up — Correos refused every return code: ${probe.firstError}`);
  } else if (remap.moved > 0) {
    await say(
      `Return catch-up — ${remap.moved} ${remap.moved === 1 ? 'parcel' : 'parcels'}`
      + ' moved out of Wrong address: Correos had already started the return',
    );
  } else {
    await say('Return catch-up — nothing left to catch up on');
  }

  return {
    ...preview,
    derived: assigned.derived,
    remappedEvents: remap.events,
    remappedParcels: remap.parcels,
    probe,
    returnedNow,
  };
}
