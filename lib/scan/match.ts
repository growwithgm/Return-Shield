import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { CODE_BASE_LENGTH, type CorreosCode } from './codes';
import type { ScanDirection } from './model';

/**
 * Which parcel a scanned code is.
 *
 * MATCHED WHEN READ, NOT WHEN SCANNED. A scan holds a code, not a shipment id,
 * and this is run every time somebody asks. That is the point: a TikTok or
 * Amazon parcel is usually scanned out days before its file is uploaded, and a
 * scan that had frozen "no such parcel" at scan time would still say so after
 * the upload brought the parcel in — the operator would be told a parcel never
 * left the warehouse when it left on Tuesday.
 *
 * THE LINK IS THE FIRST FIFTEEN CHARACTERS. They are the one part the Código de
 * Bulto and the EXPEDICIÓN share, and `shipments.shipping_code` holds whichever
 * of the two its source happened to give us — Shopify's fulfilment carries the
 * expedición, a marketplace file sometimes carries the bulto. See
 * lib/scan/codes.ts.
 *
 * ONE RULE, THREE CALLERS. The resolution below is written once as SQL and
 * once as the handful of lines that read its answer, and the scan API, the
 * phone's batch list and the Returns tab all go through both. Three copies of
 * "what does this code match" is three answers to it.
 *
 * AND THEN THERE IS THE OTHER LABEL. A returned parcel arrives wearing a code
 * Correos invented for the journey back, and that code is NOT the one on the
 * shipment:
 *
 *   PKA6TP9800129340147006H   the label that went out
 *   DXA6TP9800129340128012S   the label it came back on
 *
 * The fifteen characters this file was built on are prefix + core, so those
 * two bases are `PKA6TP980012934` and `DXA6TP980012934` — equal from the third
 * character and different in the first two. Every `DX` label the warehouse
 * scanned therefore matched nothing and was filed under "Not in Return
 * Shield", which is where the five real returns of 27 October are sitting. The
 * part the two legs share is characters 3 onwards, and that is what the
 * `legCore` rules below add. See lib/carriers/correos/return-code.ts.
 */

export interface ScanMatch {
  shipmentId: string;
  orderNumber: string;
  storeName: string;
  storePlatform: string;
  /**
   * What Correos last said about this parcel.
   *
   * The Scanner is deliberately starved of data — no customer name, no phone,
   * no address, no value ever reaches it — and this is not that. It is the one
   * fact the warehouse needs to be told it may be scanning a pile the wrong
   * way round: a parcel Correos has out for delivery cannot be on our shelf.
   */
  state: string;
  /**
   * This code is the parcel's RETURN label, not the one it went out on.
   *
   * Which is also the strongest thing the warehouse can know about direction:
   * a `DX` label in their hands is a parcel that came back. The phone and the
   * Returns tab both say so, and neither decides a shipment's state on it —
   * that comes from Correos, through the return leg's own events.
   */
  viaReturn: boolean;
}

export interface MatchAnswer {
  /** The one parcel this code is, or null when there is no single answer. */
  match: ScanMatch | null;
  /**
   * How many parcels share this code's base.
   *
   * Two or more with nothing matching exactly is a multi-parcel shipment: the
   * worker scanned the EXPEDICIÓN, which names the shipment rather than one of
   * its boxes. The phone says "2 parcels with this number" instead of picking
   * one, because picking one is how a parcel gets marked as having left the
   * warehouse while it is still on a shelf.
   */
  sharing: number;
}

/**
 * `left(shipping_code, 15)`, written from the constant so this and
 * lib/scan/codes.ts cannot drift.
 *
 * Literal SQL rather than a bound parameter on purpose: the functional index
 * `shipments_code_base_idx` is on the expression with a constant 15, and
 * Postgres will not match it against `left(shipping_code, $1)`.
 */
function baseExpr(alias: string): SQL {
  return raw.raw(`left(${alias}.shipping_code, ${CODE_BASE_LENGTH})`);
}

/**
 * The part of a code that survives a change of leg: everything after the
 * two-character prefix.
 *
 * Two widths, because the two printed numbers carry different amounts of it:
 *
 *   a 23-character Código de Bulto  →  characters 3-17, 15 of them, and they
 *                                      include the parcel number, so this
 *                                      names ONE box
 *   a 15- or 16-character EXPEDICIÓN → characters 3-15, 13 of them: the core
 *                                      alone, which names the shipment
 *
 * The expedición's sixteenth character is its own check letter, computed some
 * other way than the bulto's (`PKA6TP980012934` works out to `T` and the real
 * expedición is `PKA6TP980012934D`), so it must be cut off rather than
 * compared — a core of 14 characters would match nothing at all.
 *
 * Both expressions have constant arguments so `shipments_core_idx` and
 * `shipments_core13_idx` can serve them; see db/migrations/0008_return_leg.sql.
 */
const CORE_FROM = 3;
const CORE_WIDE = 15;
const CORE_NARROW = 13;

/** `substr(<alias>.shipping_code, 3, 15)` — the wide core, parcel number and all. */
function coreExpr(alias: string, width: number): SQL {
  return raw.raw(`substr(${alias}.shipping_code, ${CORE_FROM}, ${width})`);
}

/** The same, read off a scan's own code — which may be either width. */
function scanCoreExpr(scan: string, width: number): SQL {
  return raw.raw(`substr(${scan}.code_as_read, ${CORE_FROM}, ${width})`);
}

/**
 * Does this code name a parcel of its own, whichever leg it was printed for?
 *
 * Four ways, and the order they are written in is the order they are worth:
 *
 *   1. the return code, exactly — the parcel Correos said comes back as this
 *   2. the fifteen-character base — the original rule, unchanged
 *   3. the wide core, for a 23-character label: one box, either leg
 *   4. the narrow core, for an EXPEDICIÓN: the shipment, either leg
 *
 * Three and four are mutually exclusive by the length of the scanned code, so
 * a bulto never matches on the narrow core and cannot pick up the other boxes
 * of its shipment.
 */
function namesAParcel(scan: string): SQL {
  const sc = raw.identifier(scan);
  const wide = raw.raw(`length(${scan}.code_as_read) = 23`);
  return raw`(
    s.return_code = ${sc}.code_as_read
    OR ${baseExpr('s')} = ${sc}.base
    OR (${wide} AND ${coreExpr('s', CORE_WIDE)} = ${scanCoreExpr(scan, CORE_WIDE)})
    OR (NOT ${wide} AND ${coreExpr('s', CORE_NARROW)} = ${scanCoreExpr(scan, CORE_NARROW)})
  )`;
}

/** The same predicate for the counting lateral, which aliases the table `s2`. */
function namesAParcel2(scan: string): SQL {
  const sc = raw.identifier(scan);
  const wide = raw.raw(`length(${scan}.code_as_read) = 23`);
  return raw`(
    s2.return_code = ${sc}.code_as_read
    OR ${baseExpr('s2')} = ${sc}.base
    OR (${wide} AND ${coreExpr('s2', CORE_WIDE)} = ${scanCoreExpr(scan, CORE_WIDE)})
    OR (NOT ${wide} AND ${coreExpr('s2', CORE_NARROW)} = ${scanCoreExpr(scan, CORE_NARROW)})
  )`;
}

/**
 * The resolution, as two LATERAL joins against anything that has a
 * `code_as_read` and a `base`.
 *
 * `m` is the parcel this code names — the exact code first, so a worker who
 * read the Código de Bulto gets the box they are holding rather than the oldest
 * row of the shipment. `n` is how many parcels share the base, which is what
 * tells a single parcel apart from a multi-parcel shipment.
 *
 * Both are index lookups on `shipments_code_base_idx`, so a batch of three
 * hundred scans costs six hundred lookups rather than six hundred table scans.
 */
export function matchLateral(scan: string): SQL {
  const sc = raw.identifier(scan);
  return raw`
    LEFT JOIN LATERAL (
      SELECT s.id AS shipment_id, o.order_number, st.name AS store_name, st.platform, s.state,
             /*
              * Exact means "this code names this box and no other", and the
              * return code does that every bit as precisely as the outbound
              * one - it carries the same parcel number. Leaving it out would
              * make a DX label ambiguous on every multi-parcel shipment, and
              * the phone would say "2 parcels with this number" while the
              * worker holds the box it names.
              *
              * (No backticks in here: this is a SQL comment inside a
              * JavaScript template literal, and a backtick ends the literal.)
              */
             COALESCE(s.shipping_code = ${sc}.code_as_read
               OR s.return_code = ${sc}.code_as_read, false) AS exact,
             -- Matched through the journey back rather than the journey out.
             -- The screens say so; nothing decides state on it.
             (${baseExpr('s')} <> ${sc}.base) AS via_return
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        JOIN stores st ON st.id = o.store_id
       WHERE ${namesAParcel(scan)}
       ORDER BY (s.shipping_code = ${sc}.code_as_read) DESC,
                COALESCE(s.return_code = ${sc}.code_as_read, false) DESC,
                s.created_at ASC
       LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS sharing
        FROM shipments s2
       WHERE ${namesAParcel2(scan)}
    ) n ON true
  `;
}

/** What a row selected through `matchLateral` looks like. */
export interface MatchColumns {
  shipment_id: string | null;
  order_number: string | null;
  store_name: string | null;
  platform: string | null;
  state: string | null;
  exact: boolean | null;
  via_return: boolean | null;
  sharing: number | string | null;
}

/** The columns `matchLateral` provides, for a SELECT list. */
export const MATCH_COLUMNS: SQL = raw`
  m.shipment_id, m.order_number, m.store_name, m.platform, m.state,
  m.exact, m.via_return, n.sharing
`;

/**
 * The decision, in the one place it is made.
 *
 * Nothing matched → nothing. Exactly one parcel, or an exact hit among several
 * → that parcel. Several, with only the base to go on → no parcel and the
 * count, which is what the phone turns into "2 parcels with this number".
 */
export function resolveMatch(row: MatchColumns): MatchAnswer {
  const sharing = Number(row.sharing ?? 0);
  if (!row.shipment_id || sharing === 0) return { match: null, sharing: 0 };
  if (sharing > 1 && !row.exact) return { match: null, sharing };

  return {
    match: {
      shipmentId: row.shipment_id,
      orderNumber: row.order_number ?? '',
      storeName: row.store_name ?? '',
      storePlatform: row.platform ?? '',
      state: row.state ?? '',
      viaReturn: row.via_return === true,
    },
    sharing,
  };
}

/**
 * One code, resolved. Used when a scan is stored, to copy the order number and
 * shop onto it.
 *
 * It runs the SAME SQL as the batch list, over a one-row VALUES, rather than a
 * near-identical query of its own.
 */
export async function matchForCode(code: CorreosCode): Promise<MatchAnswer> {
  const result = await getDb().execute(raw`
    SELECT ${MATCH_COLUMNS}
      FROM (VALUES (${code.raw}::text, ${code.base}::text)) AS sc(code_as_read, base)
      ${matchLateral('sc')}
  `);

  const row = rowsOf<MatchColumns>(result)[0];
  return row ? resolveMatch(row) : { match: null, sharing: 0 };
}

/**
 * The latest scan of one shipment in one direction, as a LATERAL join.
 *
 * Shared by the Parcels list, the parcel page and the pre-admission filter,
 * because three copies of this predicate is three answers to "has it left the
 * warehouse".
 *
 * The NOT EXISTS is the multi-parcel rule from the other side. A scan whose
 * exact code IS some other parcel's `shipping_code` has already named its box,
 * so it must not badge this one as well — without it, scanning parcel 01 of a
 * two-parcel shipment would mark parcel 02 as having left the warehouse too.
 */
export function latestScanLateral(
  direction: ScanDirection,
  as: string,
  shipments = 's',
): SQL {
  const code = raw.raw(`${shipments}.shipping_code`);
  const back = raw.raw(`${shipments}.return_code`);
  return raw`
    LEFT JOIN LATERAL (
      SELECT sc.scanned_at, u.name AS worker
        FROM scans sc
        JOIN users u ON u.id = sc.user_id
       WHERE sc.direction = ${direction}
         /*
          * EITHER LABEL. A parcel scanned back in wearing its return code is a
          * parcel that came back, and until this clause the "Back in the
          * warehouse" badge could never light for one: the base of a DX code
          * differs from its parcel's in exactly the first two characters.
          *
          * THIS OR IS WHAT scans_code_idx AND scans_core_idx ARE FOR. The
          * first predicate used to be a bare equality on the leading column of
          * scans_base_idx, so Postgres walked straight to the newest matching
          * scan; an OR of three predicates throws that away unless each of
          * them has an index of its own, and neither code_as_read nor the core
          * had one (scans_batch_code_idx is on (batch_id, code_as_read) and
          * cannot serve code_as_read alone). This lateral runs twice per row
          * on a screen that pages at a hundred, so without those two indexes
          * it is two hundred scans of a growing table per page load.
          *
          * Measured against 20,000 parcels and 20,000 incoming scans: with the
          * indexes Postgres serves the whole OR as a BitmapOr across all three
          * and the hundred rows cost 6.5 ms. Rewriting it as two unioned
          * equalities — the other way to keep it indexed — came out at 10.3 ms,
          * because the union pays for a merge append and a second join, so the
          * simpler form is also the faster one.
          *
          * The core comparison is the 23-character one only. An EXPEDICIÓN
          * names the shipment rather than the box, and a badge is a statement
          * about one parcel.
          */
         AND (
           sc.base = ${baseExpr(shipments)}
           OR sc.code_as_read = ${back}
           OR (length(sc.code_as_read) = 23
               AND substr(sc.code_as_read, 3, 15) = ${coreExpr(shipments, CORE_WIDE)})
         )
         /*
          * The multi-parcel rule from the other side: a scan whose exact code
          * IS some other parcel's own label has already named its box, so it
          * must not badge this one as well. Either of OUR two codes satisfies
          * it directly, and the return code is there because a DX scan names
          * this parcel just as precisely as its outbound label does.
          */
         AND (
           sc.code_as_read = ${code}
           OR sc.code_as_read = ${back}
           OR NOT EXISTS (
             SELECT 1 FROM shipments other
              WHERE other.shipping_code = sc.code_as_read
                 OR other.return_code = sc.code_as_read
           )
         )
       ORDER BY sc.scanned_at DESC
       LIMIT 1
    ) ${raw.identifier(as)} ON true
  `;
}
