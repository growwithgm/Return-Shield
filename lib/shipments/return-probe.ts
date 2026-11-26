/**
 * What a run of return-leg lookups learnt, and the one sentence that says it.
 *
 * A MODULE OF ITS OWN, WITH NO IMPORTS, AND THAT IS THE WHOLE POINT. These
 * three live apart from the rest of the return-leg machinery because a CLIENT
 * component has to read them: the Settings catch-up card shows the answer after
 * it presses the button, and a client component cannot reach the database.
 *
 * It is not a style preference. `components/ReturnCatchUp.tsx` is
 * `'use client'`, and one value import of `describeProbe` from
 * `lib/shipments/return-leg.ts` was enough to pull the database pool — and
 * through `lib/alerts` the mailer — into the browser bundle. `next build`
 * stopped with:
 *
 *   UnhandledSchemeError: Reading from "node:async_hooks" is not handled by
 *   plugins (Unhandled scheme).
 *   Import trace: ./db/index.ts -> ./lib/shipments/return-leg.ts
 *                 -> ./components/ReturnCatchUp.tsx
 *
 * and the same for `node:child_process` and `node:crypto`. The typecheck
 * passed; only the build knew. `tests/client-bundle.test.ts` is what now
 * refuses the import in the first place, so this file staying import-free is
 * not merely tidy — it is what that test is protecting.
 *
 * `lib/shipments/return-leg.ts` re-exports all three, so nothing that was
 * importing them from there had to change.
 */

/**
 * What one run of return-leg lookups learnt — including, and especially,
 * whether Correos will answer about a `DX` code at all.
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
