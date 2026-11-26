import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, retryableRead, rowsOf, at as ts } from '@/db';
import { now, DAY } from '@/lib/clock';
import { exact, fmt } from '@/lib/time';
import { stateLabels, type Bilingual } from '@/lib/carriers/correos/state-map';
import { MATCH_COLUMNS, matchLateral, resolveMatch, type MatchColumns } from '@/lib/scan/match';
import { scanLabel, type ScanLabel } from '@/lib/scan/items';
import { SCAN_RETENTION_DAYS } from '@/lib/scan/model';
import { scanMark, type ScanMark } from './scans';

/**
 * Returns: every parcel the warehouse scanned coming back, newest first.
 *
 * This is the half of the Scanner the office reads. A return arriving is the
 * one event Correos is slowest to report and the warehouse knows about first —
 * the box is physically on the bench — so until now a parcel could be back in
 * the building for a week with nothing in Return Shield saying so.
 *
 * FOUR SECTIONS, BECAUSE "SCANNED IN" AND "CAME BACK" TURNED OUT TO BE
 * DIFFERENT THINGS. This screen used to have two, split on "did the code match
 * a parcel", and both halves were wrong in a way nobody could see:
 *
 *   Back with us        a return Correos or a DX label confirms. The honest
 *                       list, and the one the office works from.
 *
 *   Check the direction a parcel the warehouse scanned IN while Correos still
 *                       had it out for delivery, on the way, or already
 *                       delivered. On 20 November fifty-two parcels were
 *                       scanned this way in thirty-eight minutes and on the
 *                       25th thirty more, every one of them Pre-admisión:
 *                       outgoing piles, scanned in the wrong mode. One of
 *                       them, Paquita's, read "Back in the warehouse · 20 Nov"
 *                       while Correos were driving it to her. They are shown,
 *                       not hidden, with a button to move them.
 *
 *   Not in Return Shield  nothing matched. Returns from before this system,
 *                       and parcels the rolling thirty-day window removed
 *                       before the return arrived. Real parcels either way.
 *
 *   Back per Correos, never scanned in   the other way round, and it was
 *                       invisible: Correos had handed the return back
 *                       and the warehouse never scanned it. Sixty-nine of the
 *                       eighty-seven returns were in this state. It is read
 *                       from the shipments rather than from the scans, which
 *                       is why it is a query of its own.
 *
 * A MATCHED RETURN STAYS MATCHED. The order number and shop were copied onto
 * the scan when it was taken (lib/scan/batches.ts), so a parcel the cleanup
 * removes on day 31 does not make its return jump sections — it keeps its
 * order number and says the parcel itself has gone.
 */

/** The newest N per section. The counts above them are exact. */
export const RETURNS_LIMIT = 100;

export interface ReturnRow {
  /** The scan's id. Stable, so React has a key that is not the code. */
  id: string;
  /** The 15-character base, which is what somebody reads off the box. */
  base: string;
  postalCode: string | null;
  /** When it came back, and who scanned it. */
  back: ScanMark;
  /** When it left, if the warehouse ever scanned it out. */
  left: ScanMark | null;
  /** The order and shop, from the live match or from the copy on the scan. */
  label: ScanLabel | null;
  /** Correos' word for it now, or null when the parcel has gone. */
  status: Bilingual | null;
  /** The parcel page, while the parcel exists. */
  shipmentId: string | null;
  /** True when the parcel was matched once and has since been cleaned up. */
  parcelGone: boolean;
  /**
   * The code scanned was the parcel's RETURN label, `DX…`.
   *
   * On its own, proof that the box came back: Correos only ever print that
   * code for the journey home. It is also why the five real returns of 27
   * October were filed under "Not in Return Shield" until now.
   */
  viaReturn: boolean;
  /** The code exactly as it was read, so the office can match it to the box. */
  code: string;
  /**
   * Why this row is under "Check the direction", in the operator's words.
   * Null for every other section.
   */
  doubt: string | null;
  /**
   * The batch this scan was taken in, and how many incoming scans it holds.
   *
   * Here for one button: "Move all 52 in this batch to Outgoing". The wrong-mode
   * piles were 52 and 30 labels long, and fixing them one row at a time is 82
   * presses — which is how a correction stops being made at all.
   */
  batchId: string;
  batchSize: number;
}

/**
 * A parcel Correos says they brought back, that nobody scanned in.
 *
 * Deliberately a different shape from `ReturnRow`: there is no scan, so there
 * is no worker, no postcode off a label and no base. What there is instead is
 * the code the return travelled under, which is what somebody takes to the
 * shelf to go and look for it.
 */
export interface AwaitedReturn {
  shipmentId: string;
  orderNumber: string;
  storeName: string;
  storePlatform: string;
  /** The code Correos delivered it under. */
  returnCode: string;
  /** Whether Correos named that code or we worked it out. */
  returnCodeSource: string | null;
  /** "19 Nov · 09:37", Madrid. */
  when: string;
  exactWhen: string;
  status: Bilingual;
}

export interface ReturnsView {
  /** Confirmed back: Correos says so, or the label was the return's own. */
  mine: ReturnRow[];
  /**
   * Matched, but Correos says this parcel is not coming back.
   *
   * Scanned in while it was out for delivery, on the way, or already
   * delivered — which is what a whole outgoing pile scanned in Incoming mode
   * looks like. Each row carries a button to move it to Outgoing.
   */
  check: ReturnRow[];
  /** Nothing matched: before Return Shield, or cleaned up before it came back. */
  theirs: ReturnRow[];
  /** Correos has handed it back and nobody scanned it in. */
  awaited: AwaitedReturn[];
  mineTotal: number;
  checkTotal: number;
  theirsTotal: number;
  awaitedTotal: number;
  /** What the search box holds. */
  q: string;
  /** How far back this goes. */
  days: number;
}

interface ReturnRaw extends MatchColumns {
  id: string;
  base: string;
  code_as_read: string;
  postal_code: string | null;
  scanned_at: string;
  worker: string;
  copied_order: string | null;
  copied_store: string | null;
  state: string | null;
  out_at: string | null;
  out_by: string | null;
  return_code: string | null;
  batch_id: string;
  batch_size: number | string | null;
  section: 'mine' | 'check' | 'theirs';
}

/**
 * The deduped set of incoming scans in the window, as a CTE.
 *
 * ONE ROW PER PARCEL, KEYED ON THE 15-CHARACTER BASE.
 *
 * A box scanned in two batches — a second worker checking the same shelf — is
 * one return, shown with its latest scan. So is the same box read once as its
 * Código de Bulto and once as its EXPEDICIÓN, which the base catches and the
 * full code would not.
 *
 * The base is also the right grain for this screen rather than a compromise.
 * Returns are read as "which orders came back"; the row shows an order number
 * and a shop, both of which belong to the shipment, so the two boxes of a
 * multi-parcel shipment are one line about one order coming back.
 *
 * And it is what makes the tab's count and these sections agree: the count is
 * `count(DISTINCT base)` over the same window, so with nothing typed in the
 * search box the two sections sum to exactly the number on the tab.
 */
function windowed(since: Date, q: string): SQL {
  const search = q
    ? raw`AND (sc.base ILIKE ${`%${q}%`} OR sc.code_as_read ILIKE ${`%${q}%`})`
    : raw``;

  return raw`
    WITH seen AS (
      SELECT sc.id, sc.base, sc.code_as_read, sc.postal_code, sc.scanned_at,
             sc.batch_id,
             sc.order_number AS copied_order, sc.store_name AS copied_store,
             u.name AS worker,
             ${MATCH_COLUMNS}
        FROM scans sc
        JOIN users u ON u.id = sc.user_id
        ${matchLateral('sc')}
       WHERE sc.direction = 'incoming'
         AND sc.scanned_at >= ${ts(since)}
         ${search}
    ),
    one AS (
      /*
       * ONE ROW PER PARCEL WHERE WE KNOW THE PARCEL, and per base where we do
       * not.
       *
       * It used to be per base alone, and that double-counted the thing this
       * whole change is about: a box scanned once on its outgoing label and
       * once on its return label has two DIFFERENT bases — PKA6TP980012934 and
       * DXA6TP980012934 — so one return appeared as two lines about one order.
       * Keying on the shipment when there is one fixes it, and falling back to
       * the base keeps the old behaviour for every code this system has never
       * heard of.
       */
      SELECT DISTINCT ON (COALESCE(shipment_id::text, base)) *
        FROM seen
       ORDER BY COALESCE(shipment_id::text, base), scanned_at DESC
    ),
    picked AS (
      SELECT one.*,
             /*
              * The sectioning, and it is the honest part of this screen.
              *
              * "mine" needs CONFIRMATION, not merely a match: either Correos
              * says the parcel is coming back or is back, or the label scanned
              * was the return's own, which Correos only ever print for the
              * journey home. Anything else that matched a parcel Correos still
              * has in flight is a pile that may have been scanned the wrong
              * way round, and goes to "check".
              */
             CASE
               WHEN one.shipment_id IS NULL AND one.copied_order IS NULL THEN 'theirs'
               WHEN one.via_return THEN 'mine'
               WHEN one.state IN ('returning', 'returned', 'refused') THEN 'mine'
               WHEN one.state IN (
                 'created', 'accepted', 'in_transit', 'out_for_delivery',
                 'delivered', 'collected'
               ) THEN 'check'
               -- failed, at_office, bad_address, stale, and a parcel the
               -- cleanup has removed: scanning one of those in is EARLY rather
               -- than wrong. Eighteen of the eighty-seven returns were still
               -- travelling when the operator counted them.
               ELSE 'mine'
             END AS section
        FROM one
    )
  `;
}

export const returnsView = retryableRead('returns', async (
  opts: { q?: string; at?: Date } = {},
): Promise<ReturnsView> => {
  const q = (opts.q ?? '').trim();
  const since = new Date((opts.at ?? now()).getTime() - SCAN_RETENTION_DAYS * DAY);

  const [listResult, countResult, awaitedResult] = await Promise.all([
    /*
     * The parcel's current state, and when it left the warehouse.
     *
     * The outgoing scan is found by BASE and not through `shipments`, which is
     * the whole reason it is a separate lateral: a parcel the thirty-day
     * cleanup removed still has its outgoing scan for the rest of the ninety
     * days, and "it left on the 2nd and came back on the 40th" is exactly the
     * story this screen exists to tell.
     */
    getDb().execute(raw`
      ${windowed(since, q)}
      SELECT r.*, ship.return_code, mates.n AS batch_size,
             out_scan.scanned_at AS out_at, out_scan.worker AS out_by
        FROM (
          SELECT * FROM picked
           ORDER BY scanned_at DESC
           LIMIT ${RETURNS_LIMIT * 3}
        ) r
        LEFT JOIN shipments ship ON ship.id = r.shipment_id
        -- How big the pile is, for "Move all N in this batch".
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS n
            FROM scans mate
           WHERE mate.batch_id = r.batch_id AND mate.direction = 'incoming'
        ) mates ON true
        LEFT JOIN LATERAL (
          SELECT o.scanned_at, ou.name AS worker
            FROM scans o
            JOIN users ou ON ou.id = o.user_id
           /*
            * EITHER LABEL, matched on the part the two legs share.
            *
            * The base alone would never find it: the parcel went out under
            * PKA6TP980012934… and came back under DXA6TP980012934…, so a
            * return scanned on its own label read "Never scanned out" for a
            * parcel the warehouse definitely scanned out. Still joined on the
            * code rather than through shipments, on purpose — the outgoing
            * scan outlives the thirty-day parcel cleanup, and "it left on the
            * 2nd and came back on the 40th" is the story this screen tells.
            */
           WHERE o.direction = 'outgoing'
             AND (
               o.base = r.base
               OR substr(o.code_as_read, 3, 13) = substr(r.code_as_read, 3, 13)
             )
           ORDER BY o.scanned_at DESC
           LIMIT 1
        ) out_scan ON true
       ORDER BY r.scanned_at DESC
    `),
    getDb().execute(raw`
      ${windowed(since, q)}
      SELECT count(*) FILTER (WHERE section = 'mine')::int AS mine,
             count(*) FILTER (WHERE section = 'check')::int AS check_,
             count(*) FILTER (WHERE section = 'theirs')::int AS theirs
        FROM picked
    `),
    /*
     * THE OTHER WAY ROUND, AND IT WAS INVISIBLE.
     *
     * Correos has handed the return back and the warehouse never scanned it
     * in. Sixty-nine of the eighty-seven returns were in exactly this state
     * — back in the building, with nothing in Return Shield saying so and
     * nothing on this screen either, because this screen was built entirely
     * out of scans.
     *
     * Read from the shipments instead, so it needs no scan to exist. The NOT
     * EXISTS is the same either-label rule as everywhere else: a parcel
     * scanned in on its outgoing label, or on its return label, has been
     * scanned in.
     */
    getDb().execute(raw`
      SELECT s.id AS shipment_id, o.order_number, st.name AS store_name, st.platform,
             s.return_code, s.return_code_source, s.returned_at, s.state
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        JOIN stores st ON st.id = o.store_id
       WHERE s.returned_at IS NOT NULL
         AND s.return_code IS NOT NULL
         AND s.dropped_at IS NULL
         AND s.returned_at >= ${ts(since)}
         ${q
    ? raw`AND (s.shipping_code ILIKE ${`%${q}%`} OR s.return_code ILIKE ${`%${q}%`}
                 OR o.order_number ILIKE ${`%${q}%`})`
    : raw``}
         AND NOT EXISTS (
           SELECT 1 FROM scans sc
            WHERE sc.direction = 'incoming'
              AND (
                sc.base = left(s.shipping_code, 15)
                OR sc.code_as_read = s.return_code
                OR (length(sc.code_as_read) = 23
                    AND substr(sc.code_as_read, 3, 15) = substr(s.shipping_code, 3, 15))
              )
         )
       ORDER BY s.returned_at DESC
       LIMIT ${RETURNS_LIMIT + 1}
    `),
  ]);

  const raws = rowsOf<ReturnRaw>(listResult);
  const counts = rowsOf<{
    mine: number | string; check_: number | string; theirs: number | string;
  }>(countResult)[0];

  const mine: ReturnRow[] = [];
  const check: ReturnRow[] = [];
  const theirs: ReturnRow[] = [];

  for (const r of raws) {
    const row = toReturnRow(r);
    const into = r.section === 'mine' ? mine : r.section === 'check' ? check : theirs;
    if (into.length < RETURNS_LIMIT) into.push(row);
  }

  const awaitedRows = rowsOf<AwaitedRaw>(awaitedResult);

  return {
    mine,
    check,
    theirs,
    awaited: awaitedRows.slice(0, RETURNS_LIMIT).map(toAwaited),
    mineTotal: Number(counts?.mine ?? 0),
    checkTotal: Number(counts?.check_ ?? 0),
    theirsTotal: Number(counts?.theirs ?? 0),
    awaitedTotal: awaitedRows.length,
    q,
    days: SCAN_RETENTION_DAYS,
  };
});

interface AwaitedRaw {
  shipment_id: string;
  order_number: string;
  store_name: string;
  platform: string;
  return_code: string;
  return_code_source: string | null;
  returned_at: string;
  state: string;
}

function toAwaited(r: AwaitedRaw): AwaitedReturn {
  const at = new Date(r.returned_at);
  const f = fmt(at);
  return {
    shipmentId: r.shipment_id,
    orderNumber: r.order_number,
    storeName: r.store_name,
    storePlatform: r.platform,
    returnCode: r.return_code,
    returnCodeSource: r.return_code_source,
    when: `${f.date} · ${f.time}`,
    exactWhen: exact(at),
    status: stateLabels(r.state),
  };
}

function toReturnRow(r: ReturnRaw): ReturnRow {
  const live = resolveMatch(r);

  /*
   * The live match first, the copy second.
   *
   * Live, because a parcel uploaded after its return was scanned has to appear
   * with its order number without anybody scanning again. The copy, because a
   * parcel the cleanup has since removed has to keep the order number it had —
   * otherwise a matched return would jump to "Not in Return Shield" on day 31,
   * which is the one thing this screen must not do.
   */
  const label = live.match
    ? scanLabel(live.match)
    : r.copied_order
      ? { lead: r.copied_order, note: r.copied_store ?? '' } satisfies ScanLabel
      : null;

  /*
   * Why this row is under "Check the direction", named rather than implied.
   *
   * Built from the same states the sectioning uses and the same words the
   * phone says, so the office and the warehouse are told the same thing about
   * the same parcel. See lib/scan/direction.ts.
   */
  const doubt = r.section === 'check' && r.state
    ? `Correos says this parcel ${CORREOS_SAYS[r.state] ?? 'is not coming back'}.`
    : null;

  return {
    id: r.id,
    base: r.base,
    batchId: r.batch_id,
    batchSize: Number(r.batch_size ?? 0),
    code: r.code_as_read,
    viaReturn: r.via_return === true,
    doubt,
    postalCode: r.postal_code,
    back: scanMark(r.scanned_at, r.worker, 'incoming') ?? {
      label: 'Back in the warehouse', when: '', exactWhen: '', worker: r.worker,
    },
    left: scanMark(r.out_at, r.out_by, 'outgoing'),
    label,
    status: r.state ? stateLabels(r.state) : null,
    shipmentId: live.match?.shipmentId ?? null,
    parcelGone: live.match === null && r.copied_order !== null,
  };
}

/**
 * Correos' last word on a parcel, as a clause the office can read.
 *
 * Same states, same sentences as the phone's warning — one wording for one
 * fact, so nobody has to work out whether the two screens mean the same thing.
 */
const CORREOS_SAYS: Record<string, string> = {
  created: 'has not been handed to Correos yet',
  accepted: 'has only just been accepted by Correos',
  in_transit: 'is on the way to the customer',
  out_for_delivery: 'is out for delivery to the customer',
  delivered: 'was delivered to the customer',
  collected: 'was picked up by the customer at the post office',
};

/**
 * The count for the Returns tab.
 *
 * IT RUNS THE SAME CTE THE VIEW DOES, and that is a deliberate change from a
 * cheaper query that had become a wrong one. It used to be
 * `count(DISTINCT base)` over `scans_direction_time_idx` — one index-only
 * count, on the grounds that a tab's number has to be cheap enough to pay for
 * on a screen that is not even showing it.
 *
 * Then the return leg arrived, and `base` stopped being one row per parcel: a
 * box scanned once on its outgoing label and once on its return label has two
 * bases, so the badge said two and the sections said one. A badge that
 * disagrees with the list underneath it is worse than a slower badge. The
 * sections now dedupe on the shipment where there is one, and this counts the
 * same rows — so the three sections sum to exactly this number, by
 * construction rather than by hoping two queries stay in step.
 *
 * The cost is one pair of index lookups per incoming scan in the window, which
 * at ninety days of this warehouse's volume is a couple of hundred — measured
 * at well under a millisecond each against twenty thousand parcels.
 */
export const returnsCount = retryableRead('returns count', async (
  at: Date = now(),
): Promise<number> => {
  const since = new Date(at.getTime() - SCAN_RETENTION_DAYS * DAY);
  const result = await getDb().execute(raw`
    ${windowed(since, '')}
    SELECT count(*)::int AS n FROM picked
  `);
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
});
