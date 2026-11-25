import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { now, HOUR } from '@/lib/clock';
import { parseCorreosCode } from './codes';
import { doubtFromParcel, type DirectionVerdict } from './direction';
import {
  MATCH_COLUMNS, matchForCode, matchLateral, resolveMatch, type MatchColumns,
} from './match';
import {
  scanLabel, summarise, type Batch, type BatchSummary, type ScanItem,
} from './items';
import type { ScanDirection, ScanSource } from './model';

/**
 * A batch: one pile of parcels, worked through by one person in one direction.
 *
 * THE PHONE OWNS NOTHING IMPORTANT. Every scan is written to IndexedDB and then
 * sent here, and this is the list the worker sees when the app is opened again —
 * so a phone that runs out of battery mid-pile loses a screen, not a pile. The
 * resume is a plain read of the open batch.
 *
 * AND A RETRY IS FREE. Each read carries an id the phone made, and `read_ids`
 * records which of them have been counted, so sending the same read twice
 * changes nothing. Without that, the retry a weak warehouse signal forces would
 * turn an ordinary scan into "scanned twice" and the counts the operator reads
 * would be wrong. See db/schema.ts.
 */

interface ScanRow extends MatchColumns {
  id: string;
  code_as_read: string;
  base: string;
  parcel_no: string | null;
  postal_code: string | null;
  source: ScanSource;
  scanned_at: string;
  times_read: number | string;
}

interface BatchRow {
  id: string;
  direction: ScanDirection;
  started_at: string;
  finished_at: string | null;
}

function toItem(r: ScanRow): ScanItem {
  const answer = resolveMatch(r);
  return {
    id: r.id,
    codeAsRead: r.code_as_read,
    base: r.base,
    parcelNo: r.parcel_no,
    postalCode: r.postal_code,
    source: r.source,
    scannedAt: new Date(r.scanned_at).toISOString(),
    timesRead: Number(r.times_read),
    label: answer.match ? scanLabel(answer.match) : null,
    sharing: answer.sharing,
    shipmentId: answer.match?.shipmentId ?? null,
  };
}

/** Newest first, which is the order the phone draws them in. */
async function itemsOf(batchId: string): Promise<ScanItem[]> {
  const result = await getDb().execute(raw`
    SELECT sc.id, sc.code_as_read, sc.base, sc.parcel_no, sc.postal_code,
           sc.source, sc.scanned_at, sc.times_read,
           ${MATCH_COLUMNS}
      FROM scans sc
      ${matchLateral('sc')}
     WHERE sc.batch_id = ${batchId}
     ORDER BY sc.scanned_at DESC, sc.id DESC
  `);
  return rowsOf<ScanRow>(result).map(toItem);
}

/**
 * The open batch for this worker and direction, opened if there is not one.
 *
 * `ON CONFLICT` against the partial unique index rather than "select, then
 * insert if nothing": two phones, or one phone retrying, would otherwise both
 * see nothing and both insert, and the pile would be split across two batches
 * whose counts each look wrong.
 */
export async function openBatch(userId: string, direction: ScanDirection): Promise<Batch> {
  /*
   * Bounded rather than recursive. The conflict firing means a batch existed,
   * and it can only have gone if it was finished between the two statements —
   * once, in practice, never twice. A `while (true)` here would be one bad
   * predicate away from a request that never answers.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await getDb().execute(raw`
      INSERT INTO scan_batches (direction, user_id, started_at)
      VALUES (${direction}, ${userId}, ${now().toISOString()}::timestamptz)
      ON CONFLICT (user_id, direction) WHERE finished_at IS NULL DO NOTHING
      RETURNING id, direction, started_at, finished_at
    `);

    const fresh = rowsOf<BatchRow>(inserted)[0];
    if (fresh) {
      return {
        id: fresh.id,
        direction: fresh.direction,
        startedAt: new Date(fresh.started_at).toISOString(),
        finishedAt: null,
        items: [],
      };
    }

    const existing = await currentBatch(userId, direction);
    if (existing) return existing;
  }

  throw new Error('Could not open a batch: one kept being finished underneath it.');
}

/** The open batch and everything in it, or null when there is none. */
export async function currentBatch(
  userId: string,
  direction: ScanDirection,
): Promise<Batch | null> {
  const result = await getDb().execute(raw`
    SELECT id, direction, started_at, finished_at
      FROM scan_batches
     WHERE user_id = ${userId} AND direction = ${direction} AND finished_at IS NULL
     LIMIT 1
  `);

  const row = rowsOf<BatchRow>(result)[0];
  if (!row) return null;

  return {
    id: row.id,
    direction: row.direction,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: null,
    items: await itemsOf(row.id),
  };
}

/** Every open batch this worker has, so switching direction can warn. */
export interface OpenBatchLine {
  id: string;
  direction: ScanDirection;
  startedAt: string;
  scans: number;
}

export async function openBatches(userId: string): Promise<OpenBatchLine[]> {
  const result = await getDb().execute(raw`
    SELECT b.id, b.direction, b.started_at,
           (SELECT count(*)::int FROM scans s WHERE s.batch_id = b.id) AS scans
      FROM scan_batches b
     WHERE b.user_id = ${userId} AND b.finished_at IS NULL
     ORDER BY b.started_at
  `);

  type Row = { id: string; direction: ScanDirection; started_at: string; scans: number | string };
  return rowsOf<Row>(result).map((r) => ({
    id: r.id,
    direction: r.direction,
    startedAt: new Date(r.started_at).toISOString(),
    scans: Number(r.scans),
  }));
}

/**
 * When a scan happened, according to the phone, within reason.
 *
 * The phone's own time is used because it is what the worker saw and because
 * it keeps a pile in the order it was worked: a batch that sat in IndexedDB
 * waiting for a signal and then flushed all at once would otherwise arrive with
 * every scan stamped the same second, and "newest first" would mean nothing.
 *
 * Twelve hours of slack either way, and anything outside that is the server's
 * clock. A phone is wrong by seconds or by years — a factory-reset handset says
 * 1970 — and a scan stamped 1970 would be deleted by the ninety-day cleanup
 * before the worker put the parcel down.
 */
export const CLOCK_SLACK_MS = 12 * HOUR;

export function stampFor(sent: string | undefined, at: Date = now()): Date {
  if (!sent) return at;
  const when = new Date(sent);
  if (Number.isNaN(when.getTime())) return at;
  if (Math.abs(when.getTime() - at.getTime()) > CLOCK_SLACK_MS) return at;
  return when;
}

export interface AddScanInput {
  batchId: string;
  /** The id the phone gave this read. The same one on every retry. */
  readId: string;
  /** Whatever came off the camera or the keyboard. */
  code: string;
  source: ScanSource;
  /** The phone's clock, ISO. Clamped by `stampFor`. */
  at?: string;
}

export type AddScanResult =
  | {
    ok: true;
    item: ScanItem;
    /** True when this code was already in the batch. */
    duplicate: boolean;
    /** False when this exact read had already been counted — a retry. */
    counted: boolean;
    /**
     * The pile may be going the other way. ADVISORY, and the scan is stored.
     *
     * Never a reason to answer `ok: false`: the route maps that to a 422, and
     * the phone drops the read and tells the worker to write the number down
     * — losing a parcel to avoid a wrong label on a screen. "Beep means it is
     * saved" has to stay true. See lib/scan/direction.ts.
     */
    doubt?: DirectionVerdict;
  }
  | { ok: false; error: string };

/**
 * Store one read.
 *
 * ONE STATEMENT DOES THE WHOLE THING, including the duplicate and the retry.
 * The unique index on (batch_id, code_as_read) is what makes the same code
 * twice one row; `read_ids` is what makes the same READ twice no change at all.
 * Doing it in two statements — look, then write — would let two reads of the
 * same parcel from a phone with a stuttering connection both decide they were
 * the first.
 *
 * THE DUPLICATE RULE IS THE CODE EXACTLY AS READ. Not the 15-character base:
 * a multi-parcel shipment prints one EXPEDICIÓN and a Código de Bulto per box,
 * so two boxes of one shipment share a base and are two parcels. Treating them
 * as one would lose a parcel that really did leave the warehouse, which is
 * worse than the opposite mistake — scanning a label and then typing the other
 * number off the same label gives two rows, both visible in the list, either
 * removable with the ×.
 */
export async function addScan(
  userId: string,
  input: AddScanInput,
): Promise<AddScanResult> {
  const code = parseCorreosCode(input.code);
  if (!code) return { ok: false, error: 'That is not a Correos number.' };
  if (!input.readId) return { ok: false, error: 'This read has no id.' };

  const batch = await batchFor(userId, input.batchId);
  if (!batch) return { ok: false, error: 'No such batch.' };

  // At scan time, so the order number and shop are COPIED onto the scan and a
  // matched return stays "From Return Shield" after the thirty-day cleanup has
  // removed the parcel. The live match is worked out again on every read.
  const copy = await matchForCode(code);
  const stamp = stampFor(input.at);

  /*
   * Is this pile going the way the phone thinks it is?
   *
   * Worked out here because it needs the parcel's state, which the phone does
   * not have and must not be given a lookup for. The phone has already decided
   * the one case the code alone settles — a DX label in an Outgoing batch —
   * and this returns the same verdict for it, so the two can never disagree.
   */
  const doubt = doubtFromParcel(code, batch.direction, copy.match);

  const result = await getDb().execute(raw`
    INSERT INTO scans (
      batch_id, direction, user_id, scanned_at,
      code_as_read, base, parcel_no, postal_code, source,
      read_ids, times_read, order_number, store_name
    )
    VALUES (
      ${batch.id}, ${batch.direction}, ${userId}, ${stamp.toISOString()}::timestamptz,
      ${code.raw}, ${code.base}, ${code.parcelNo}, ${code.postalCode}, ${input.source},
      ARRAY[${input.readId}]::text[], 1,
      ${copy.match?.orderNumber ?? null}, ${copy.match?.storeName ?? null}
    )
    ON CONFLICT (batch_id, code_as_read) DO UPDATE
       SET read_ids = scans.read_ids || ${input.readId}::text,
           times_read = cardinality(scans.read_ids) + 1
     WHERE NOT (${input.readId}::text = ANY (scans.read_ids))
    RETURNING id, (xmax = 0) AS inserted
  `);

  const written = rowsOf<{ id: string; inserted: boolean }>(result)[0];

  /*
   * No row came back, so the WHERE on the DO UPDATE refused it: this exact read
   * has already been counted. A retry, and the honest answer is the row as it
   * already stands.
   */
  if (!written) {
    const item = await itemByCode(batch.id, code.raw);
    if (!item) return { ok: false, error: 'That scan could not be read back.' };
    return {
      ok: true, item, duplicate: item.timesRead > 1, counted: false,
      ...(doubt ? { doubt } : {}),
    };
  }

  const item = await itemById(written.id);
  if (!item) return { ok: false, error: 'That scan could not be read back.' };
  return {
    ok: true, item, duplicate: !written.inserted, counted: true,
    ...(doubt ? { doubt } : {}),
  };
}

async function batchFor(userId: string, batchId: string): Promise<BatchRow | null> {
  /*
   * A FINISHED BATCH STILL ACCEPTS A SCAN, and that is deliberate.
   *
   * "Finish batch" waits until the queue is empty, so this should not happen —
   * but if the app was killed with a read still unsent and the batch was
   * finished from somewhere else, the read is a parcel that really was scanned.
   * It belongs in the batch it was taken in. A rejection here would be the one
   * way a scan gets lost, and "beep means it is saved" has to stay true.
   */
  const result = await getDb().execute(raw`
    SELECT id, direction, started_at, finished_at
      FROM scan_batches
     WHERE id = ${batchId} AND user_id = ${userId}
     LIMIT 1
  `);
  return rowsOf<BatchRow>(result)[0] ?? null;
}

async function itemById(id: string): Promise<ScanItem | null> {
  const result = await getDb().execute(raw`
    SELECT sc.id, sc.code_as_read, sc.base, sc.parcel_no, sc.postal_code,
           sc.source, sc.scanned_at, sc.times_read,
           ${MATCH_COLUMNS}
      FROM scans sc
      ${matchLateral('sc')}
     WHERE sc.id = ${id}
     LIMIT 1
  `);
  const row = rowsOf<ScanRow>(result)[0];
  return row ? toItem(row) : null;
}

async function itemByCode(batchId: string, code: string): Promise<ScanItem | null> {
  const result = await getDb().execute(raw`
    SELECT sc.id, sc.code_as_read, sc.base, sc.parcel_no, sc.postal_code,
           sc.source, sc.scanned_at, sc.times_read,
           ${MATCH_COLUMNS}
      FROM scans sc
      ${matchLateral('sc')}
     WHERE sc.batch_id = ${batchId} AND sc.code_as_read = ${code}
     LIMIT 1
  `);
  const row = rowsOf<ScanRow>(result)[0];
  return row ? toItem(row) : null;
}

/**
 * The × on a row. No dialog, by the operator's own instruction, so it has to be
 * cheap to undo — which it is: scan the parcel again.
 *
 * Fenced to the worker's own batches. Anyone who can reach this endpoint can
 * send any id, and without the fence one phone could empty another's pile.
 */
export async function removeScan(userId: string, scanId: string): Promise<boolean> {
  const result = await getDb().execute(raw`
    DELETE FROM scans
     WHERE id = ${scanId}
       AND batch_id IN (SELECT id FROM scan_batches WHERE user_id = ${userId})
    RETURNING id
  `);
  return rowsOf<{ id: string }>(result).length > 0;
}

export interface FinishedBatch {
  batch: Batch;
  summary: BatchSummary;
}

/**
 * Close the pile and give back the numbers.
 *
 * Idempotent: a batch already finished keeps the time it was finished and
 * answers with the same summary, because the button is on a phone and a phone
 * double-taps.
 */
export async function finishBatch(
  userId: string,
  batchId: string,
): Promise<FinishedBatch | null> {
  const result = await getDb().execute(raw`
    UPDATE scan_batches
       SET finished_at = ${now().toISOString()}::timestamptz
     WHERE id = ${batchId} AND user_id = ${userId} AND finished_at IS NULL
    RETURNING id, direction, started_at, finished_at
  `);

  const closed = rowsOf<BatchRow>(result)[0] ?? await batchFor(userId, batchId);
  if (!closed) return null;

  const items = await itemsOf(closed.id);
  return {
    batch: {
      id: closed.id,
      direction: closed.direction,
      startedAt: new Date(closed.started_at).toISOString(),
      finishedAt: closed.finished_at ? new Date(closed.finished_at).toISOString() : null,
      items,
    },
    summary: summarise(items),
  };
}

/** For image 8: the counts, without closing anything. */
export async function previewBatch(
  userId: string,
  batchId: string,
): Promise<FinishedBatch | null> {
  const batch = await batchFor(userId, batchId);
  if (!batch) return null;

  const items = await itemsOf(batch.id);
  return {
    batch: {
      id: batch.id,
      direction: batch.direction,
      startedAt: new Date(batch.started_at).toISOString(),
      finishedAt: batch.finished_at ? new Date(batch.finished_at).toISOString() : null,
      items,
    },
    summary: summarise(items),
  };
}

/* ------------------------------------------------------- the wrong way round */

/**
 * Move scans from one direction to the other.
 *
 * TWO PILES NEED THIS. On 20 November fifty-two parcels were scanned in
 * Incoming mode while Correos still had them out for delivery, and on 25
 * November thirty more, every one of them Pre-admisión. One of them, Paquita's,
 * read "Back in the warehouse · 20 Nov · 13:16" while Correos were driving it
 * to her — and the whole Returns tab is built on those rows.
 *
 * IT MOVES THE DIRECTION, NOT THE SCAN, and that is deliberate rather than
 * lazy:
 *
 *   `scans_batch_code_idx` is UNIQUE on (batch_id, code_as_read), so a scan
 *   moved into another batch that already has the code would be refused — and
 *   `read_ids` and `times_read` are per-batch facts ("scanned twice") that
 *   would have to be merged rather than carried. All of that to express "this
 *   pile went out, it did not come in", which is exactly what the direction
 *   column says.
 *
 *   The scan also belongs, historically, to the batch it was taken in: Naeem
 *   worked that pile at 12:40 on the 20th, and that is true whichever way the
 *   parcels were going.
 *
 * `direction_changed_at` is stamped, so nobody has to wonder later why a
 * parcel that was in the warehouse on the 20th is not any more.
 *
 * Returns how many rows actually moved — which is 0 on a second press,
 * because of the `direction <>` guard, and that makes this safe to press twice.
 */
export async function moveScanDirection(
  ids: readonly string[],
  to: ScanDirection,
): Promise<number> {
  if (!ids.length) return 0;

  const result = await getDb().execute(raw`
    UPDATE scans
       SET direction = ${to},
           direction_changed_at = ${now().toISOString()}::timestamptz
     WHERE id IN (${raw.join(ids.map((id) => raw`${id}`), raw`, `)})
       AND direction <> ${to}
    RETURNING id
  `);

  return rowsOf<{ id: string }>(result).length;
}

/** Every scan of one batch, moved. The "Move the whole batch" button. */
export async function moveBatchDirection(
  batchId: string,
  to: ScanDirection,
): Promise<number> {
  const result = await getDb().execute(raw`
    UPDATE scans
       SET direction = ${to},
           direction_changed_at = ${now().toISOString()}::timestamptz
     WHERE batch_id = ${batchId}
       AND direction <> ${to}
    RETURNING id
  `);

  return rowsOf<{ id: string }>(result).length;
}

/**
 * "Switch this batch to Outgoing", from the phone, mid-pile.
 *
 * The batch's own direction moves as well as its scans', because the worker is
 * still scanning into it and the next parcel has to land the right way round.
 *
 * ONE OPEN BATCH PER WORKER PER DIRECTION is enforced by
 * `scan_batches_open_idx`, so there is a case to handle rather than ignore: a
 * worker who already has an open Outgoing batch cannot simply have this one
 * relabelled. Then the scans move into that batch's direction and THIS batch is
 * finished where it stands — the pile is correctly filed either way, and the
 * phone opens a fresh batch on its next read. Nothing is deleted and no scan
 * changes batch, for the reasons in `moveScanDirection`.
 */
export async function switchBatchDirection(
  userId: string,
  batchId: string,
  to: ScanDirection,
): Promise<{ moved: number; batchFinished: boolean } | null> {
  const batch = await batchFor(userId, batchId);
  if (!batch) return null;
  if (batch.direction === to) return { moved: 0, batchFinished: false };

  // Everything on one connection: DB_POOL_MAX is 1 on Vercel, and a getDb()
  // inside a transaction waits for the connection the transaction is holding.
  return getDb().transaction(async (tx) => {
    const moved = rowsOf<{ id: string }>(await tx.execute(raw`
      UPDATE scans
         SET direction = ${to},
             direction_changed_at = ${now().toISOString()}::timestamptz
       WHERE batch_id = ${batchId}
         AND direction <> ${to}
      RETURNING id
    `)).length;

    const clash = rowsOf<{ id: string }>(await tx.execute(raw`
      SELECT id FROM scan_batches
       WHERE user_id = ${userId} AND direction = ${to} AND finished_at IS NULL
         AND id <> ${batchId}
       LIMIT 1
    `)).length > 0;

    if (clash) {
      await tx.execute(raw`
        UPDATE scan_batches SET finished_at = ${now().toISOString()}::timestamptz
         WHERE id = ${batchId} AND finished_at IS NULL
      `);
      return { moved, batchFinished: true };
    }

    await tx.execute(raw`
      UPDATE scan_batches SET direction = ${to} WHERE id = ${batchId}
    `);
    return { moved, batchFinished: false };
  });
}
