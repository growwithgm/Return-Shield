'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { moveBatchOut, moveScansOut } from '@/app/actions/returns';

/**
 * "This went out — it did not come in."
 *
 * The office's correction for a parcel the warehouse scanned the wrong way
 * round. Two buttons, because the mistake comes in two sizes: one parcel, and
 * a whole pile. The wrong-mode batches were fifty-two and thirty labels long,
 * so the second button is not a convenience — eighty-two presses is a
 * correction that never gets made.
 *
 * NO CONFIRMATION DIALOG, in keeping with the × on a scan row: the action is
 * reversible by scanning the parcel again in the right mode, and it is stamped
 * (`direction_changed_at`) so it can be explained afterwards. What it is NOT
 * is silent — the button says how many rows it is about to move.
 */
export function MoveToOutgoing({
  scanId,
  batchId,
  batchSize,
}: {
  scanId: string;
  batchId: string;
  /** Incoming scans in this batch, so the second button can name the number. */
  batchSize: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function run(action: () => Promise<{ ok: boolean; error?: string }>): void {
    setError(null);
    start(async () => {
      const answer = await action();
      if (!answer.ok) {
        setError(answer.error ?? 'That could not be moved.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => moveScansOut([scanId]))}
        className="whitespace-nowrap rounded border border-line bg-surface px-[9px] py-[5px] text-[11.5px] font-semibold text-navy disabled:opacity-50"
      >
        {pending ? 'Moving…' : 'Move to Outgoing'}
      </button>

      {batchSize > 1 && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => moveBatchOut(batchId))}
          className="whitespace-nowrap rounded px-[9px] py-[3px] text-[11px] font-semibold text-muted underline-offset-2 hover:underline disabled:opacity-50"
        >
          {`Move all ${batchSize} in this batch`}
        </button>
      )}

      {error && <span className="text-[11px] font-semibold text-crit" role="alert">{error}</span>}
    </div>
  );
}
