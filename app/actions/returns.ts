'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/guard';
import {
  applyReturnCatchUp, previewReturnCatchUp,
  type ReturnCatchUpPreview, type ReturnCatchUpResult,
} from '@/lib/shipments/return-catchup';
import { moveBatchDirection, moveScanDirection } from '@/lib/scan/batches';

/**
 * The return catch-up, as two presses.
 *
 * Eighty-seven parcels came back before the system could see it happen: the
 * journey home travels under a second tracking code, nothing here had ever
 * looked at one, so fifty-eight still read "Coming back", twenty-nine read
 * "Wrong address", and the Returned tab has never had a parcel in it. This
 * works out each return code, asks Correos about it, and files the answer.
 *
 * Shaped exactly like the TikTok handover (app/actions/shopify.ts): a preview
 * that writes nothing, then an apply that re-runs the same read rather than
 * trusting the numbers the operator has been looking at. See the note there
 * about why the payload types are not re-exported from a `'use server'` file.
 */

export interface ReturnCatchUpPreviewResult {
  ok: boolean;
  error?: string;
  preview?: ReturnCatchUpPreview;
}

export interface ReturnCatchUpApplyResult {
  ok: boolean;
  error?: string;
  result?: ReturnCatchUpResult;
}

/** "What would this do?" Nothing is written. */
export async function previewReturns(): Promise<ReturnCatchUpPreviewResult> {
  await requireUser();
  try {
    return { ok: true, preview: await previewReturnCatchUp() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not read the parcels that are coming back.',
    };
  }
}

/**
 * Do it.
 *
 * Safe to press twice: a code already stored is not rewritten, a mapping
 * already right is not changed, and the lookup queue excludes every return
 * Correos has already delivered — so a second press asks only about the ones
 * still travelling.
 */
export async function catchUpReturns(): Promise<ReturnCatchUpApplyResult> {
  await requireUser();
  try {
    const result = await applyReturnCatchUp();
    revalidatePath('/', 'layout');
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'The catch-up did not finish.',
    };
  }
}

export interface MoveScansResult {
  ok: boolean;
  error?: string;
  /** How many scans actually changed direction. 0 on a second press. */
  moved?: number;
}

/**
 * "This went out — it did not come in."
 *
 * The office's correction for a parcel the warehouse scanned the wrong way
 * round. On 20 November fifty-two outgoing parcels went into an Incoming batch
 * and on the 25th thirty more; one of them, Paquita's, read "Back in the
 * warehouse · 20 Nov · 13:16" while Correos were still driving it to her.
 *
 * It moves the DIRECTION, not the scan — see `moveScanDirection` for why — and
 * stamps when it was done, so a parcel that was in the warehouse on the 20th
 * and is not any more can be explained afterwards.
 *
 * Safe to press twice: the second press finds nothing left to move.
 */
export async function moveScansOut(ids: string[]): Promise<MoveScansResult> {
  await requireUser();
  if (!ids.length) return { ok: true, moved: 0 };
  try {
    const moved = await moveScanDirection(ids, 'outgoing');
    revalidatePath('/', 'layout');
    return { ok: true, moved };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'That scan could not be moved.',
    };
  }
}

/**
 * The same, for every incoming scan of one batch.
 *
 * Because the wrong-mode piles are fifty-two and thirty labels long, and
 * eighty-two presses is a correction that does not get made.
 */
export async function moveBatchOut(batchId: string): Promise<MoveScansResult> {
  await requireUser();
  if (!batchId) return { ok: false, error: 'Which batch?' };
  try {
    const moved = await moveBatchDirection(batchId, 'outgoing');
    revalidatePath('/', 'layout');
    return { ok: true, moved };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'That batch could not be moved.',
    };
  }
}
