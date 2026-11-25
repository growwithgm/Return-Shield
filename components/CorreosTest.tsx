'use client';

import { useState, useTransition } from 'react';
import { testCorreosConnection, resetCorreosBatchMode, type CorreosTestResult } from '@/app/actions/correos';
import { Chip } from './ui';

/**
 * Three steps, in order, so a wrong value is attributable to the step it broke:
 * can we get a token, does a real lookup work, and which code does this parcel
 * come back under. Without this the only way to find out is to wait up to three
 * hours for a sweep and read a job_runs row.
 *
 * STEP 3 IS THE NEW ONE, and it is the step that answers the question this
 * screen could not. A parcel delivered back to the warehouse on 19 November
 * still read "Wrong address, 18 November" here, because the journey home
 * happens under a second tracking code and nothing in the system had ever
 * looked at it. Step 3 names that code and says where it came from; putting it
 * in the box above then lists its own events, which is how the operator can
 * check both against Correos' tracker in two presses.
 *
 * The token itself is never shown. Not a prefix, not a length.
 */
export function CorreosTest({ batchMode }: { batchMode: 'unknown' | 'comma' | 'single' }) {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<CorreosTestResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="border-b border-line px-[14px] py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-muted">
            A tracking code to look up (optional)
          </span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="PQ7842931055ES or DX…"
            className="w-[200px] rounded border border-line bg-surface2 px-[9px] py-[7px] font-mono text-[12.5px] text-ink"
          />
        </label>

        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => { setResult(await testCorreosConnection(code)); })}
          className="rounded bg-navy px-[13px] py-[9px] text-[12.5px] font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Testing…' : 'Test Correos connection'}
        </button>

        {batchMode === 'single' && (
          <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => {
              await resetCorreosBatchMode();
              setResult(null);
            })}
            className="rounded border border-line bg-surface px-[13px] py-[9px] text-[12px] font-semibold text-ink disabled:opacity-60"
          >
            Try batches again
          </button>
        )}
      </div>

      {!result && (
        <p className="mt-2 max-w-[640px] text-[12px] leading-[1.5] text-muted">
          Checks three things in order: that the CorreosID credentials can get a token, that
          the gateway credentials can look a parcel up, and which code the parcel comes back
          under if it is returned. Leave the code blank to test only the token. A{' '}
          <span className="font-mono">DX…</span> return code works in the box too — that is how
          to see a parcel&rsquo;s journey back to us. The token is never shown.
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-2">
          <Step
            n={1}
            label="Token"
            ok={result.token.ok}
            warn={result.token.manual}
            message={result.token.message}
          />

          {result.lookup && (
            <Step
              n={2}
              label={`Lookup ${result.lookup.code}`}
              ok={result.lookup.ok}
              message={[
                result.lookup.state ? `Reads as: ${result.lookup.state}.` : null,
                result.lookup.message,
                result.lookup.latestEvent,
                result.lookup.status ? `Correos returned ${result.lookup.status}.` : null,
              ].filter(Boolean).join(' ')}
            />
          )}

          {/*
            * Every event, not just the newest. The point of this list is a
            * return leg: eight rows ending in "Entregado" is the proof that a
            * parcel is physically back, and one summary line cannot show it.
            */}
          {result.lookup?.timeline && result.lookup.timeline.length > 0 && (
            <ol className="ml-[52px] flex max-w-[620px] flex-col gap-[3px]">
              {result.lookup.timeline.map((e, i) => (
                <li key={`${e.code}-${e.when}-${i}`} className="flex flex-wrap items-baseline gap-2">
                  <span className="w-[150px] shrink-0 font-mono text-[11.5px] text-muted">{e.when}</span>
                  <span className="text-[12px] text-ink">{e.desc}</span>
                  <span className="font-mono text-[11px] text-muted">{e.code}</span>
                  {e.phase && <span className="text-[11px] text-muted">· {e.phase}</span>}
                  <span className={`text-[11.5px] ${e.state ? 'text-muted' : 'text-crit'}`}>
                    {e.state ?? 'no mapping'}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {result.returnLeg && (
            <Step
              n={3}
              label={result.returnLeg.isReturn ? 'This is a return code' : 'Comes back as'}
              ok={result.returnLeg.code !== null}
              // A derived code is a very good guess and still a guess, and the
              // screen says so rather than presenting arithmetic as a fact.
              warn={result.returnLeg.source === 'derived'}
              message={[
                result.returnLeg.code && !result.returnLeg.isReturn
                  ? `${result.returnLeg.code}.`
                  : null,
                result.returnLeg.message,
              ].filter(Boolean).join(' ')}
            />
          )}

          <div className="text-[12px] text-muted">
            Multi-parcel format:{' '}
            {result.batchMode === 'comma'
              ? 'comma-separated works, so the sweep asks about a hundred at a time.'
              : result.batchMode === 'single'
                ? 'not accepted, so the sweep asks one parcel per request.'
                : 'not tested yet.'}
            {result.batchNote && <> {result.batchNote}.</>}
          </div>
        </div>
      )}
    </div>
  );
}

function Step({
  n, label, ok, warn, message,
}: { n: number; label: string; ok: boolean; warn?: boolean; message: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-[11px] font-semibold text-muted">Step {n}</span>
      <span className="text-[12.5px] font-semibold text-ink">{label}</span>
      {ok
        ? warn
          ? <Chip colour="var(--warn)" background="var(--warnsoft)">works, but</Chip>
          : <Chip colour="var(--good)" background="var(--goodsoft)">OK</Chip>
        : <Chip colour="var(--crit)" background="var(--critsoft)">failed</Chip>}
      <span className="max-w-[620px] text-[12.5px] leading-[1.5] text-muted">{message}</span>
    </div>
  );
}
