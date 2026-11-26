'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { catchUpReturns, previewReturns } from '@/app/actions/returns';
import type { ReturnCatchUpPreview, ReturnCatchUpResult } from '@/lib/shipments/return-catchup';
/*
 * `return-probe`, NOT `return-leg`, and this is a load-bearing import path.
 *
 * This file is `'use client'`, so every VALUE it imports is bundled for the
 * browser. `describeProbe` used to come from `lib/shipments/return-leg.ts`,
 * which imports the database pool — and through `lib/alerts` the mailer — so
 * webpack followed it and `next build` stopped with
 * `UnhandledSchemeError: Reading from "node:async_hooks"`. The typecheck
 * passed; only the build knew. `tests/client-bundle.test.ts` refuses it now.
 *
 * The type imports above are erased at compile time and reach no bundle.
 */
import { describeProbe } from '@/lib/shipments/return-probe';

/**
 * "Find the parcels that already came back."
 *
 * Two presses, on purpose, the same way the TikTok handover works: the first
 * writes nothing and says what the second one would do. This touches
 * eighty-seven parcels, and a one-press button that moved eighty-seven parcels
 * would be the only button on this screen that could not be examined first.
 *
 * What it is for: Return Shield watched the code on the label that went out,
 * and Correos send a parcel back under a code of their own. So the moment a
 * return started the parcel went quiet and stayed where its last event had
 * left it — "Coming back" for fifty-eight of them, "Wrong address" for
 * twenty-nine, and Returned for none, ever. This works out each return code,
 * asks Correos about it and files the answer as the journey home.
 */
export function ReturnCatchUp() {
  const [preview, setPreview] = useState<ReturnCatchUpPreview | null>(null);
  const [result, setResult] = useState<ReturnCatchUpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function check(): void {
    setError(null);
    setResult(null);
    start(async () => {
      const answer = await previewReturns();
      if (!answer.ok || !answer.preview) {
        setError(answer.error ?? 'Could not read the parcels that are coming back.');
        return;
      }
      setPreview(answer.preview);
    });
  }

  function apply(): void {
    setError(null);
    start(async () => {
      const answer = await catchUpReturns();
      if (!answer.ok || !answer.result) {
        setError(answer.error ?? 'The catch-up did not finish.');
        return;
      }
      setResult(answer.result);
      setPreview(answer.result);
      router.refresh();
    });
  }

  const nothingToDo = preview !== null && preview.comingBack === 0;

  return (
    <div className="border-b border-line px-[14px] py-[11px]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink">
          Parcels that came back before we were watching
        </span>

        <button
          type="button"
          onClick={check}
          disabled={pending}
          className="rounded border border-line px-[11px] py-[7px] text-[12px] font-semibold text-ink disabled:opacity-50"
        >
          {pending && !preview ? 'Looking…' : 'Check what would change'}
        </button>

        {preview && !nothingToDo && !result && (
          <button
            type="button"
            onClick={apply}
            disabled={pending}
            className="rounded border border-navy px-[11px] py-[7px] text-[12px] font-semibold text-navy disabled:opacity-50"
          >
            {pending ? 'Asking Correos…' : `Follow ${preview.wouldAsk} returns to the end`}
          </button>
        )}

        {result && <span className="text-[12px] font-semibold text-good">Done</span>}
      </div>

      {!preview && !result && (
        <p className="mt-[7px] max-w-[640px] text-[12px] leading-[1.55] text-muted">
          Correos send a returned parcel back under a second tracking code, and until now nothing
          here looked at it — so a parcel delivered back to the warehouse still reads whatever its
          last outgoing event said. This works out each return code, asks Correos about it, and
          files the answer. The first press writes nothing.
        </p>
      )}

      {preview && !result && (
        <ul className="mt-[7px] list-inside list-disc text-[12px] leading-[1.55] text-muted">
          <li>{`Parcels Correos says are coming back: ${preview.comingBack}`}</li>
          <li>{`Return codes already known: ${preview.haveCode}`}</li>
          <li>{`Return codes to work out: ${preview.wouldDerive} (returns postcode ${preview.returnPostcode})`}</li>
          {preview.cannotDerive > 0 && (
            <li>
              {`${preview.cannotDerive} whose own number is not a 23-character Correos code, so no `}
              return code can be worked out — left exactly as they are, nothing invented.
            </li>
          )}
          {preview.leavingWrongAddress > 0 && (
            <li>
              {`${preview.leavingWrongAddress} will leave the Wrong-address worklist: Correos sent `}
              &ldquo;Dirección incorrecta&rdquo; in their DEVOLUCION phase, which means the parcel
              was already on its way back, and the old reading took it for an address to fix.
            </li>
          )}
          {preview.example && (
            <li className="font-mono text-[11.5px]">
              {`e.g. ${preview.example[0]} comes back as ${preview.example[1]}`}
            </li>
          )}
          {/* The honest limit, stated before the button rather than after. */}
          <li>{preview.unknowable}</li>
          {nothingToDo && <li>Nothing to catch up on.</li>}
        </ul>
      )}

      {result && (
        <ul className="mt-[7px] list-inside list-disc text-[12px] leading-[1.55] text-muted">
          <li>{`Return codes worked out: ${result.derived}`}</li>
          <li>
            {`Events re-read with the new mapping: ${result.remappedEvents}`}
            {` across ${result.remappedParcels} ${result.remappedParcels === 1 ? 'parcel' : 'parcels'}`}
          </li>
          <li>{describeProbe(result.probe)}</li>
          <li>{`Parcels in Returned now: ${result.returnedNow}`}</li>
          {result.probe.failed > 0 && (
            <li className="text-crit">
              {`Correos refused ${result.probe.failed} of the return codes: ${result.probe.firstError}.`}
              {' Nothing was written for those, and they stay in Coming back.'}
            </li>
          )}
        </ul>
      )}

      {error && (
        <p className="mt-[7px] text-[12px] font-semibold text-crit" role="alert">{error}</p>
      )}
    </div>
  );
}
