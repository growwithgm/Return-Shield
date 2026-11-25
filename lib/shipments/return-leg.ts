import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import { now } from '@/lib/clock';
import {
  CODE_LENGTH, coreOf, hasValidCheckLetter, returnCodeFor, returnPostcode,
  type ReturnCodeSource,
} from '@/lib/carriers/correos/return-code';
import type { AssociatedShipments } from '@/lib/carriers/correos/normalise';
import type { LookupResult } from '@/lib/carriers/correos/trackpub';

/**
 * The return leg: finding the code a parcel comes back under, and keeping it.
 *
 * THIS IS THE GAP THE WHOLE FEATURE CLOSES. Correos do not add events to a
 * parcel's own tracking code when they send it back — they create a second
 * shipment with its own code, and the original goes quiet for ever. So the
 * system watched a code that would never move again, the 69 parcels already
 * back in the building still read "Coming back" or "Wrong address", and
 * nothing in the database had ever reached `returned`.
 *
 * Two ways to get the code, and they are kept apart on purpose:
 *
 *   `correos`  — they named it themselves, in `associatedShipments` on the
 *                lookup. The truth, and never recomputed.
 *   `derived`  — worked out from the original with the published check letter
 *                (lib/carriers/correos/return-code.ts), which reproduces all
 *                109 real codes the operator collected. This is what lets the
 *                catch-up fix 87 parcels that were sent before any of this
 *                existed, with no network call at all.
 *
 * A derived code is a very good guess and is still a guess: it depends on
 * `RETURN_POSTCODE` being the postcode Correos actually addresses returns to.
 * That is why the source is stored, why every screen that shows the code shows
 * where it came from, and why a `correos` code replaces a `derived` one the
 * moment Correos tell us.
 */

/* --------------------------------------------------------------- the signal */

/**
 * "This parcel is coming back", as a predicate on `shipment_events e`.
 *
 * It mirrors the return rules in lib/carriers/correos/state-map.ts, and that
 * duplication is deliberate rather than careless: the catch-up has to be able
 * to PREVIEW without writing anything, and the mapped states it would
 * otherwise read are only correct after `remapKnownEvents` has run and
 * rewritten them. A preview that first had to fix the data would not be a
 * preview. tests/return-leg.test.ts drives this and `matchCorreosEvent`
 * against the same cases so they cannot drift apart unnoticed.
 *
 * Three signals, matching the three in the mapper:
 *
 *   1. mapped_state — a code or wording we already understand said so.
 *   2. phase DEVOLUCION — Correos' own classification, whatever the wording.
 *   3. "Desestacionado" whose long text says a return is pending.
 *
 * `translate` rather than `unaccent`, which is an extension this database does
 * not have: Correos send both DEVOLUCION and DEVOLUCIÓN.
 */
export function returnSignalSql(): SQL {
  return raw`(
    e.mapped_state IN ('returning', 'refused')
    OR upper(translate(
         COALESCE(e.raw_payload->>'phaseDes', e.raw_payload->>'phase', ''),
         'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'
       )) = 'DEVOLUCION'
    OR (
      lower(translate(e.event_desc, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')) LIKE 'desestacionado%'
      AND lower(translate(
            COALESCE(e.raw_payload->>'expandedText', e.raw_payload->>'extendedText', ''),
            'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'
          )) LIKE '%pendiente de devolucion%'
    )
  )`;
}

/**
 * The states that mean a parcel is coming back or already has, for the places
 * that ask about a parcel rather than about an event.
 *
 * `bad_address` is NOT here, and that is the fix. Twenty-nine parcels sat in
 * it because "Dirección incorrecta" in phase DEVOLUCION was read as a wrong
 * address; the mapper now reads the phase first, so after one sweep those
 * parcels are `returning` and the ones still in `bad_address` are the real
 * thing — `H01R421V`, phase EN ENTREGA, parcel held at an office waiting on
 * us. Giving one of those a return code would say it is coming back when it is
 * waiting for an address.
 */
export const RETURN_SIGNAL_STATES = ['returning', 'returned', 'refused'] as const;

/* -------------------------------------------------------------- storing one */

export type StoreOutcome =
  /** Written. */
  | 'stored'
  /** Already had it, or had a better one. Nothing changed. */
  | 'kept'
  /** Not a code this parcel could come back under. Nothing changed. */
  | 'rejected';

export interface StoreReturnCode {
  shipmentId: string;
  /** The parcel's own code, to check the candidate against. */
  shippingCode: string;
  candidate: string;
  source: ReturnCodeSource;
}

/**
 * Is `candidate` a plausible return code for `original`?
 *
 * Three things, all of them cheap and all of them things a wrong code fails:
 * the right length, a check letter that matches its own body, and the same
 * shipment core. The core is what makes this more than a format check — a
 * perfectly well-formed code for somebody else's parcel passes the first two.
 *
 * NOT checked: the prefix. Every return we have seen is `DX`, and that is in
 * `returnCodeFor` because we have to pick one to derive; refusing anything
 * else here would throw away a code Correos themselves named, which is the one
 * source more trustworthy than our own arithmetic.
 */
export function plausibleReturnCode(original: string, candidate: string): boolean {
  const clean = candidate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== CODE_LENGTH) return false;
  if (!hasValidCheckLetter(clean)) return false;
  if (clean === original.toUpperCase().replace(/[^A-Z0-9]/g, '')) return false;
  return coreOf(clean) === coreOf(original);
}

/**
 * Write a return code onto a parcel, if it is better than what is there.
 *
 * The precedence is the whole of the logic: `correos` beats `derived`, and
 * nothing beats `correos`. A warehouse move changes `RETURN_POSTCODE` and so
 * changes what we would derive — and must not rewrite a code Correos confirmed
 * for a parcel that is already travelling under it.
 */
export async function storeReturnCode(spec: StoreReturnCode): Promise<StoreOutcome> {
  if (!plausibleReturnCode(spec.shippingCode, spec.candidate)) return 'rejected';

  const code = spec.candidate.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const rows = await getDb().execute(raw`
    UPDATE shipments
       SET return_code = ${code},
           return_code_source = ${spec.source}
     WHERE id = ${spec.shipmentId}
       AND (
         return_code IS NULL
         -- Correos' own answer replaces our arithmetic. Our arithmetic never
         -- replaces theirs, and neither replaces an identical code — so a
         -- second run writes nothing and reports 'kept'.
         OR (${spec.source} = 'correos' AND return_code_source IS DISTINCT FROM 'correos')
         OR (return_code IS DISTINCT FROM ${code} AND return_code_source IS NOT DISTINCT FROM ${spec.source})
       )
    RETURNING id
  `);

  return rowsOf<{ id: string }>(rows).length ? 'stored' : 'kept';
}

/**
 * Record the codes Correos themselves named, from a lookup response.
 *
 * Called with whatever `normalisePayload` found under any key whose name says
 * "associated" — see `associatedCodesOf`. Matched back to parcels by their own
 * shipping code, so an association on a code we do not track is ignored
 * rather than guessed at.
 */
export async function noteAssociatedCodes(
  associated: readonly AssociatedShipments[],
): Promise<number> {
  let stored = 0;

  for (const entry of associated) {
    if (!entry.associated.length) continue;

    const [ship] = rowsOf<{ id: string; shipping_code: string }>(await getDb().execute(raw`
      SELECT id, shipping_code FROM shipments WHERE shipping_code = ${entry.code} LIMIT 1
    `));
    if (!ship) continue;

    for (const candidate of entry.associated) {
      const outcome = await storeReturnCode({
        shipmentId: ship.id,
        shippingCode: ship.shipping_code,
        candidate,
        source: 'correos',
      });
      if (outcome === 'stored') stored += 1;
    }
  }

  return stored;
}

/* -------------------------------------------------------- filling in the rest */

export interface AssignOutcome {
  /** Parcels with a return signal and no code yet. */
  examined: number;
  /** Codes written by deriving them from the original. */
  derived: number;
  /**
   * Parcels whose code could not be worked out: a shipping code that is not a
   * 23-character Correos code, or that is already a return code. Not a
   * failure — a parcel imported with an order reference instead of a tracking
   * code has nothing to derive from, and saying so is better than inventing.
   */
  impossible: number;
}

interface NeedsRow {
  id: string;
  shipping_code: string;
}

/**
 * Give every parcel that is coming back a return code, deriving the ones
 * Correos has not named.
 *
 * Runs on the signal rather than on the state, so it fires the moment the
 * first DEVOLUCION event lands — before the sweep's re-projection has moved
 * the parcel — and so it works on the backlog whatever state the old mapping
 * left those parcels in.
 */
export async function assignReturnCodes(limit = 500): Promise<AssignOutcome> {
  const out: AssignOutcome = { examined: 0, derived: 0, impossible: 0 };
  const postcode = returnPostcode();

  /*
   * THE STATE FIRST, THE EVENTS ONLY WHERE THE STATE COULD BE WRONG.
   *
   * The event check is what rescues the parcels whose state the old mapping
   * got wrong — the twenty-nine in "Wrong address" — so it cannot be dropped.
   * But run unguarded it is an EXISTS per shipment with no return code, which
   * on this database is almost all of them: twenty thousand index scans every
   * hour to find nothing.
   *
   * `delivered` and `collected` are excluded from it because a parcel Correos
   * handed to the customer is not one of those cases. If a return starts after
   * a delivery, Correos send an event, the projection moves the parcel to
   * `returning` (TERMINAL may go to a return state — see transitions.ts), and
   * the first branch picks it up. So the EXISTS only ever runs over the live
   * set, which is hundreds rather than tens of thousands.
   */
  const rows = rowsOf<NeedsRow>(await getDb().execute(raw`
    SELECT s.id, s.shipping_code
      FROM shipments s
     WHERE s.return_code IS NULL
       AND s.dropped_at IS NULL
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
     ORDER BY s.created_at ASC
     LIMIT ${limit}
  `));

  out.examined = rows.length;

  for (const row of rows) {
    const candidate = returnCodeFor(row.shipping_code, postcode);
    if (!candidate) { out.impossible += 1; continue; }

    const outcome = await storeReturnCode({
      shipmentId: row.id,
      shippingCode: row.shipping_code,
      candidate,
      source: 'derived',
    });
    if (outcome === 'stored') out.derived += 1;
    else out.impossible += 1;
  }

  return out;
}

/* ------------------------------------------------------------ asking Correos */

export interface ReturnLegRow {
  id: string;
  shippingCode: string;
  returnCode: string;
  source: ReturnCodeSource | null;
}

/**
 * How long a return leg is worth asking about after the parcel last moved.
 *
 * A bound rather than a preference. Without one, a parcel given a derived code
 * for a return that never happened — `refused`, say, where the customer
 * changed their mind and collected it after all — would be asked about forty
 * times an hour for the rest of the database's life. Sixty days is well past
 * Correos' own thirty-day history window, so a leg that has said nothing by
 * then is a leg that never will.
 */
const GIVE_UP_AFTER_DAYS = 60;

/**
 * The return legs worth asking Correos about.
 *
 * A parcel whose return has already been delivered is finished — asking again
 * would learn nothing and cost a request. A parcel with no return code has
 * nothing to ask about. Everything else is a parcel somewhere between our door
 * and theirs, and those are the ones the operator is waiting on.
 *
 * Ordered by `return_checked_at`, NOT by `last_reconciled_at`. That column is
 * what the due rule reads (lib/recheck.ts), and stamping it here would make a
 * parcel look freshly checked and defer its own outbound check by up to twelve
 * hours — on a parcel in `bad_address`, which is on the three-hourly list
 * because somebody is waiting on it.
 */
export async function returnLegQueue(limit: number): Promise<ReturnLegRow[]> {
  if (limit <= 0) return [];

  return rowsOf<{
    id: string; shipping_code: string; return_code: string; return_code_source: string | null;
  }>(await getDb().execute(raw`
    SELECT s.id, s.shipping_code, s.return_code, s.return_code_source
      FROM shipments s
     WHERE s.return_code IS NOT NULL
       AND s.returned_at IS NULL
       AND s.dropped_at IS NULL
       AND COALESCE(s.last_event_at, s.created_at)
             > now() - interval '${raw.raw(String(GIVE_UP_AFTER_DAYS))} days'
     ORDER BY s.return_checked_at ASC NULLS FIRST, s.created_at ASC
     LIMIT ${limit}
  `)).map((r) => ({
    id: r.id,
    shippingCode: r.shipping_code,
    returnCode: r.return_code,
    source: (r.return_code_source as ReturnCodeSource | null),
  }));
}

/**
 * What a run of return-leg lookups learnt — including, and especially, whether
 * Correos will answer about a `DX` code at all.
 *
 * NOBODY KNOWS THAT YET. The codes were read off Correos' public tracker,
 * which is a different service from the trackpub `/search` endpoint this system
 * uses, and no DX code has ever been put to trackpub with these credentials.
 * It may answer, it may 404 every one of them, or it may refuse the format. So
 * this is recorded on every run and shown in Settings in those words, rather
 * than being assumed either way. See `app/(panel)/settings`.
 */
export interface ReturnLegProbe {
  /** ISO. */
  at: string;
  /** Return codes we put to Correos. */
  asked: number;
  /** How many came back with events. */
  answered: number;
  /** How many Correos gave a final "never heard of it" for. */
  unknown: number;
  /** How many failed some other way — auth, format, outage. */
  failed: number;
  /** The first such failure, verbatim. Empty when there were none. */
  firstError: string;
  /** Events stored off the return legs. */
  newEvents: number;
  /** Parcels that are back with us, of the ones this run asked about. */
  arrived: number;
}

export const NO_PROBE_YET: ReturnLegProbe = {
  at: '', asked: 0, answered: 0, unknown: 0, failed: 0, firstError: '', newEvents: 0, arrived: 0,
};

/**
 * Plain English for the Settings screen. The point is that "Correos answered
 * none of them" and "we have not tried" must never read the same.
 */
export function describeProbe(p: ReturnLegProbe | null): string {
  if (!p || !p.at) return 'Not tried yet — no return code has been put to Correos.';
  if (p.asked === 0) return 'Nothing to ask about: no parcel is waiting on a return leg.';
  if (p.failed > 0 && p.answered === 0) {
    return `Correos refused all ${p.asked}: ${p.firstError}`;
  }
  if (p.answered === 0) {
    return `Correos has never heard of any of the ${p.asked} return codes we asked about.`
      + ' Either they do not serve return codes on this endpoint, or the codes are wrong.';
  }
  return `Correos answered ${p.answered} of ${p.asked} return codes`
    + `${p.unknown ? `, had never heard of ${p.unknown}` : ''}`
    + `${p.failed ? `, refused ${p.failed} (${p.firstError})` : ''}.`;
}

/**
 * Stamp a return leg as asked-about, so the queue's ordering stays fair.
 *
 * `return_checked_at` and nothing else. `last_reconciled_at` belongs to the
 * parcel's own check and must not be touched from here — see `returnLegQueue`.
 */
export async function markReturnLegAsked(ids: readonly string[], at: Date = now()): Promise<void> {
  if (!ids.length) return;
  await getDb().execute(raw`
    UPDATE shipments
       SET return_checked_at = ${ts(at)}
     WHERE id IN (${raw.join(ids.map((id) => raw`${id}`), raw`, `)})
  `);
}

/* ------------------------------------------------------- the lookup itself */

/**
 * Just enough of `TrackpubClient` to ask about one code.
 *
 * Narrowed to one method so a test can stand in for Correos without a token,
 * a base URL or a fetch, and so this module does not depend on the batching
 * machinery it deliberately does not use (see `pollReturnLegs`).
 */
export interface ReturnLegClient {
  lookup(code: string): Promise<LookupResult>;
}

export interface PollOptions {
  /** How many return codes to put to Correos at most. */
  limit?: number;
  /** `Date.now()` past which to stop, so a cron cannot overrun its budget. */
  deadline?: number;
  /**
   * Write the events and recompute the states, and narrate nothing.
   *
   * The catch-up passes this. Sixty-nine parcels that came back over the last
   * month would otherwise each announce their arrival today, and each open a
   * "put it back in stock" task for a box the warehouse shelved in October.
   */
  quiet?: boolean;
}

/**
 * Ask Correos about the return legs that are still travelling, one code at a
 * time, and write what they say.
 *
 * ONE CODE PER REQUEST, DELIBERATELY, and not through `lookupMany`.
 *
 * The batching client learns the gateway's limits as it goes: a chunk that
 * comes back without most of the codes it asked about is read as the format
 * being refused, and it halves the batch size and writes the smaller number
 * into settings for every future run. That is exactly right for parcel codes
 * and exactly wrong for these: nobody knows yet whether trackpub serves a `DX`
 * code at all. If it does not, a batch half full of them looks identical to
 * the gateway narrowing its limit, and one sweep would permanently drop the
 * whole system to one request per parcel — 201 requests an hour to learn
 * nothing. The single path cannot do that: it touches neither the batch mode
 * nor the remembered size.
 *
 * It costs one request per travelling return leg, which today is eighteen.
 */
export async function pollReturnLegs(
  client: ReturnLegClient,
  opts: PollOptions = {},
): Promise<ReturnLegProbe> {
  const at = now();
  const out: ReturnLegProbe = { ...NO_PROBE_YET, at: at.toISOString() };

  const queue = await returnLegQueue(opts.limit ?? 50);
  if (!queue.length) return out;

  const { ingestEvent } = await import('./ingest');
  const asked: string[] = [];

  for (const row of queue) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) break;

    out.asked += 1;
    const res = await client.lookup(row.returnCode);

    if (!res.ok) {
      if (res.definitive) {
        // Correos' final answer about this code is "never heard of it". For a
        // return leg that is NORMAL and not a failure: a derived code for a
        // return Correos has not created yet does not exist on their side.
        // Counting it as an error would paint the Settings screen red for the
        // ordinary case, and counting it as unreached would make the sweep
        // believe it had run out of time.
        out.unknown += 1;
      } else {
        out.failed += 1;
        if (!out.firstError) out.firstError = res.error;
      }
      asked.push(row.id);
      continue;
    }

    // A return leg can name its own associated shipments — on the DX code that
    // is the original going the other way. Free to record, and it upgrades a
    // derived code to one Correos confirmed.
    await noteAssociatedCodes(res.outcome.associated);

    let wrote = 0;
    for (const event of res.outcome.events) {
      const ingested = await ingestEvent(event, { quiet: opts.quiet === true });
      if (ingested.status === 'inserted') wrote += 1;
    }

    if (res.outcome.events.length) out.answered += 1;
    if (wrote) out.newEvents += wrote;
    asked.push(row.id);
  }

  await markReturnLegAsked(asked, at);

  // Which of them are actually back now. Read from the database rather than
  // counted in the loop, because `returned_at` is written by the projection
  // and the projection is the only thing entitled to decide it.
  if (asked.length) {
    const rows = rowsOf<{ n: number }>(await getDb().execute(raw`
      SELECT count(*)::int AS n
        FROM shipments
       WHERE returned_at IS NOT NULL
         AND id IN (${raw.join(asked.map((id) => raw`${id}`), raw`, `)})
    `));
    out.arrived = rows[0]?.n ?? 0;
  }

  return out;
}
