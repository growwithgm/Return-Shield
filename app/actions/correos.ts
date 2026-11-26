'use server';

import { requireUser } from '@/lib/auth/guard';
import { correosToken } from '@/lib/carriers/correos/token';
import { TrackpubClient } from '@/lib/carriers/correos/trackpub';
import { getSetting, setSetting } from '@/lib/settings';
import {
  STATE_LABEL, eventStateLabel, matchCorreosEvent, returnLegStateLabel,
} from '@/lib/carriers/correos/state-map';
import { returnLegReads } from '@/lib/state-machine/project';
import { associatedCodesOf } from '@/lib/carriers/correos/normalise';
import {
  RETURN_PREFIX, hasValidCheckLetter, isReturnCode, returnCodeFor, returnPostcode,
  type EventLeg,
} from '@/lib/carriers/correos/return-code';
import { exact } from '@/lib/time';
import { getDb, rowsOf } from '@/db';
import { sql as raw } from 'drizzle-orm';

/**
 * "Test Correos connection."
 *
 * Four variables from two different places have to be right before a single
 * parcel gets tracked, and the only other way to find out is to wait up to
 * three hours for a sweep and then read a job_runs row. This answers it in two
 * seconds, in two steps, so a wrong value is attributable to the step it broke.
 *
 * It never returns the token. Not the first characters, not the length — a
 * thirty-minute bearer token for a live carrier account has no business in a
 * browser, a server log or a screenshot.
 */

export interface TokenCheck {
  ok: boolean;
  /** "token OK, expires in 28 minutes" — or what went wrong. */
  message: string;
  expiresInMinutes?: number;
  /** Set when a hand-pasted CORREOS_JWT was used instead of the OAuth pair. */
  manual?: boolean;
}

export interface LookupCheck {
  ok: boolean;
  code: string;
  message: string;
  /** What we made of it, when it worked. */
  state?: string;
  events?: number;
  latestEvent?: string;
  /**
   * Every event, newest first, in Correos' own words.
   *
   * The test used to show one. That was enough while the only question was
   * "does the connection work", and it is not enough for a return code: the
   * whole point of putting `DXA6TP9800129340128012S` into this box is to see
   * the eight events that end with "Entregado" on 19 November, and to see them
   * against the dates the operator read off Correos' own tracker.
   */
  timeline?: EventLine[];
  /** Correos' own status, when it did not. */
  status?: number | null;
}

export interface EventLine {
  /** "Mon 19 Nov 2026, 09:37" in Madrid. */
  when: string;
  /** Correos' sentence, verbatim. Evidence, never rewritten. */
  desc: string;
  code: string;
  phase: string | null;
  /** Our English for it, or null when we have no mapping. */
  state: string | null;
}

/**
 * The second code: the one the parcel comes back under.
 *
 * This is the step the screen did not have, and the reason the operator had to
 * go to Correos' tracker to find out that a parcel delivered back on 19
 * November still read "Wrong address, 18 November" here. See
 * lib/carriers/correos/return-code.ts.
 */
export interface ReturnCodeCheck {
  /** The code tested is itself a return code. */
  isReturn: boolean;
  /** The return code, however we came by it. */
  code: string | null;
  /**
   * Where it came from, in the words the screen shows:
   *
   *   'correos'  — they named it in this very response, under
   *                `associatedShipments`. The truth.
   *   'stored'   — it is already on the parcel in our database.
   *   'derived'  — worked out here from the original with the published check
   *                letter. A very good guess, and still a guess.
   *   'original' — the code tested IS a return, and this is the parcel it
   *                belongs to.
   */
  source: 'correos' | 'stored' | 'derived' | 'original' | null;
  /** What the parcel row says, when we have the parcel at all. */
  stored: string | null;
  storedSource: string | null;
  /** The postcode a derived code carries. `RETURN_POSTCODE`. */
  postcode: string;
  message: string;
}

export interface CorreosTestResult {
  token: TokenCheck;
  lookup?: LookupCheck;
  returnLeg?: ReturnCodeCheck;
  /** What the client knows about the undocumented multi-parcel format. */
  batchMode: 'unknown' | 'comma' | 'single';
  batchNote: string | null;
}

/** How many events the test lists. Enough for a whole return leg twice over. */
const TIMELINE_LIMIT = 20;

export async function testCorreosConnection(shippingCode: string): Promise<CorreosTestResult> {
  await requireUser();

  const storedMode = await getSetting('correosBatchMode');

  /* --- Part 1: can we get a token at all? ------------------------------- */

  const tokens = correosToken();
  if (!tokens.configured) {
    return {
      token: {
        ok: false,
        message: 'No credentials. Set CORREOS_OAUTH_CLIENT_ID and CORREOS_OAUTH_CLIENT_SECRET '
          + '(the CorreosID system-user application, not the developer-portal app).',
      },
      batchMode: storedMode,
      batchNote: null,
    };
  }

  // Always mint a fresh one: a cached token proves only that it worked earlier.
  tokens.invalidate();
  const token = await tokens.get(Date.now());

  if (!token.ok) {
    return {
      token: { ok: false, message: token.error },
      batchMode: storedMode,
      batchNote: null,
    };
  }

  const minutes = Math.max(0, Math.round((token.expiresAt.getTime() - Date.now()) / 60_000));
  const tokenCheck: TokenCheck = {
    ok: true,
    expiresInMinutes: minutes,
    manual: token.source === 'override',
    message: token.source === 'override'
      ? `Using the token pasted into CORREOS_JWT. It expires in ${minutes} minutes and `
        + 'cannot be renewed — set the OAuth pair before relying on this.'
      : `Token OK, expires in ${minutes} minutes.`,
  };

  const code = shippingCode.trim().toUpperCase();
  if (!code) {
    return { token: tokenCheck, batchMode: storedMode, batchNote: null };
  }

  /* --- Part 2: does a real lookup work? --------------------------------- */

  // A client of its own, so a test cannot change what the sweep believes about
  // the batch format — and so the test is not answered from a warm instance's
  // state.
  const client = new TrackpubClient({ batchMode: storedMode });
  const result = await client.lookup(code);

  if (!result.ok) {
    return {
      token: tokenCheck,
      // Shown on a failure too, and that is the point of it: a `DX` code that
      // Correos refuses is the single most useful thing this screen can tell
      // us, because nobody yet knows whether trackpub serves one at all.
      returnLeg: await returnCodeCheck(code, null),
      lookup: { ok: false, code, message: result.error, status: result.status },
      batchMode: client.mode,
      batchNote: client.diagnosis,
    };
  }

  const events = result.outcome.events;
  // Newest first, the way the parcel page shows them.
  const ordered = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  /*
   * Mapped once. Three readings come out of this list — the "Reads as" line,
   * every row of the timeline, and what the leg says as a whole — and they
   * have to be the same reading. The newest event was being mapped twice over,
   * here and again inside the timeline, which is one place too many for them
   * to agree.
   */
  const matched = ordered.map((e) => matchCorreosEvent(e.eventCode, e.eventDesc, e.phase, e.longText));
  const newest = ordered[0];
  const match = matched[0] ?? null;
  const mapped = match?.state ?? null;

  /*
   * WHICH LEG THE CODE TYPED INTO THE BOX IS.
   *
   * Every event of a `DX` code is a return-leg event, and the mapper does not
   * know that — it reads a sentence, not a leg. So "Entregado" on a return
   * mapped to `delivered` and the screen said "Reads as: Delivered" about a
   * parcel sitting on our own shelf: true of nothing anybody wanted to know,
   * and the same wrong reading the timeline had.
   *
   * `returnLegReads` is the projection's own rule, imported rather than
   * repeated, so this screen and the state a parcel actually ends up in cannot
   * drift apart.
   */
  const leg: EventLeg = isReturnCode(code) ? 'return' : 'outbound';

  /*
   * ON THE WAY BACK, THE WHOLE LEG ANSWERS — NOT ITS NEWEST EVENT.
   *
   * `returnLegReads` is the projection's own rule over the whole list, and
   * reading one event instead would disagree with the parcel in both the ways
   * it can: a handover followed by a later scan (the leg finished; the newest
   * event does not say so), and a newest event nobody has mapped (the leg has
   * started; the newest event says nothing at all, so the line would simply
   * vanish). The return leg's own wordings are the unmapped ones, so the
   * second case is the common one.
   */
  const readsAsState = leg === 'return'
    ? returnLegReads(matched.map((m) => m?.state ?? null))
    : mapped;

  return {
    token: tokenCheck,
    returnLeg: await returnCodeCheck(code, result.raw),
    lookup: {
      ok: true,
      code,
      events: events.length,
      timeline: ordered.slice(0, TIMELINE_LIMIT).map((e, i) => ({
        when: exact(e.occurredAt),
        desc: e.eventDesc,
        code: e.eventCode,
        phase: e.phase ?? null,
        // Per event, on the same leg, from the same mapping as the line above
        // — the operator noticed the summary, and every row had it too.
        state: eventStateLabel(matched[i]?.state, leg),
      })),
      state: readsAsState
        ? (leg === 'return' ? returnLegStateLabel(readsAsState) : (STATE_LABEL[readsAsState] ?? readsAsState))
        : undefined,
      // The newest event in Correos' own words, with its date and time, so the
      // operator can check it against what Mi Oficina shows them.
      latestEvent: newest
        ? `"${newest.eventDesc}" at ${exact(newest.occurredAt)}`
          + `${newest.phase ? ` · ${newest.phase}` : ''}`
        : undefined,
      message: events.length === 0
        ? 'Correos knows the code but has no events for it yet.'
        : mapped === null
          ? `${events.length} events. The newest one is wording we have no mapping for — it is `
            + 'kept, shown on the parcel, and listed below for review.'
          : match?.via === 'phase'
            ? `${events.length} events. The newest one we only recognise from its phase `
              + `(${newest?.phase}), so it is listed below for review as well.`
            : `${events.length} events.`,
    },
    batchMode: client.mode,
    batchNote: client.diagnosis,
  };
}

/**
 * Which code this parcel comes back under, and how sure we are of it.
 *
 * Not exported: a `'use server'` file may export only async functions, and
 * tests/use-server-exports.test.ts reads the file text to make sure of it.
 *
 * `raw` is the whole lookup response, so the one source better than our own
 * arithmetic can be read straight out of it: `associatedShipments` is Correos
 * naming the return themselves. Null when the lookup failed, which is a case
 * worth answering all the same — a refused `DX` code is the most informative
 * thing this screen can report.
 */
async function returnCodeCheck(code: string, raw_: unknown): Promise<ReturnCodeCheck> {
  const postcode = returnPostcode();

  /* --- The code tested is itself a return. ------------------------------ */

  if (isReturnCode(code)) {
    const [owner] = rowsOf<{ shipping_code: string; return_code_source: string | null }>(
      await getDb().execute(raw`
        SELECT shipping_code, return_code_source FROM shipments
         WHERE return_code = ${code} LIMIT 1
      `),
    );

    return {
      isReturn: true,
      code,
      source: 'original',
      stored: owner?.shipping_code ?? null,
      storedSource: owner?.return_code_source ?? null,
      postcode,
      message: owner
        ? `This is the return leg of ${owner.shipping_code}.`
          + ` The events above are that parcel coming back to us.`
        : `This is a return code (${RETURN_PREFIX}…), and no parcel here is expecting it.`
          + ' Either it belongs to a parcel we do not track, or the catch-up has not run yet.'
          + (hasValidCheckLetter(code) ? '' : ' Its check letter does not match, so it may be mistyped.'),
    };
  }

  /* --- An ordinary parcel code: what does it come back under? ---------- */

  const named = raw_ ? namedReturn(raw_, code) : null;

  const [ship] = rowsOf<{ return_code: string | null; return_code_source: string | null }>(
    await getDb().execute(raw`
      SELECT return_code, return_code_source FROM shipments
       WHERE shipping_code = ${code} LIMIT 1
    `),
  );

  const derived = returnCodeFor(code, postcode);

  if (named) {
    return {
      isReturn: false,
      code: named,
      source: 'correos',
      stored: ship?.return_code ?? null,
      storedSource: ship?.return_code_source ?? null,
      postcode,
      message: `Correos named the return themselves: ${named}.`
        + (derived && derived !== named
          ? ` We would have worked out ${derived} — theirs wins, and the difference is`
            + ` worth looking at: RETURN_POSTCODE is ${postcode}.`
          : ' Our own arithmetic agrees with it.'),
    };
  }

  if (ship?.return_code) {
    return {
      isReturn: false,
      code: ship.return_code,
      source: ship.return_code_source === 'correos' ? 'stored' : 'derived',
      stored: ship.return_code,
      storedSource: ship.return_code_source,
      postcode,
      message: ship.return_code_source === 'correos'
        ? `On the parcel already: ${ship.return_code}, named by Correos.`
        : `On the parcel already: ${ship.return_code}, worked out from this code`
          + ` (RETURN_POSTCODE ${postcode}). Correos have not named one yet.`,
    };
  }

  if (!derived) {
    return {
      isReturn: false,
      code: null,
      source: null,
      stored: null,
      storedSource: null,
      postcode,
      message: 'No return code can be worked out from this: it is not a 23-character'
        + ' Correos number, so it carries no parcel number to put in one.',
    };
  }

  return {
    isReturn: false,
    code: derived,
    source: 'derived',
    stored: null,
    storedSource: null,
    postcode,
    message: `If this comes back it will travel as ${derived}, worked out from this code`
      + ` with RETURN_POSTCODE ${postcode}. Put that in the box above to see the return leg.`
      + ' Correos have not named one, which for a parcel that is not coming back is normal.',
  };
}

/**
 * The return code Correos named in this response, if they named one.
 *
 * Reads the shipment object out of the raw body by hand rather than through the
 * normaliser, because the normaliser's job is events and this is a
 * shipment-level field. `associatedCodesOf` is shared with it, so both read
 * every key whose NAME says "associated" rather than one spelling.
 */
function namedReturn(body: unknown, code: string): string | null {
  const shipments_ = shipmentsIn(body);
  for (const s of shipments_) {
    const own = typeof (s as { shipmentCode?: unknown }).shipmentCode === 'string'
      ? ((s as { shipmentCode: string }).shipmentCode).toUpperCase().replace(/[^A-Z0-9]/g, '')
      : null;
    if (own && own !== code) continue;
    const found = associatedCodesOf(s).find((c) => isReturnCode(c) && hasValidCheckLetter(c));
    if (found) return found;
  }
  return null;
}

function shipmentsIn(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const shipment = (body as { shipment?: unknown }).shipment;
  if (Array.isArray(shipment)) return shipment;
  if (shipment) return [shipment];
  return Array.isArray(body) ? body : [body];
}

/**
 * Forget what we learnt about the batch format, so the next sweep probes again.
 *
 * Needed because the verdict is sticky by design: one bad answer pins the sweep
 * to one request per parcel, which at five thousand live parcels is the
 * difference between fifty requests and five thousand.
 */
export async function resetCorreosBatchMode(): Promise<void> {
  await requireUser();
  await setSetting('correosBatchMode', 'unknown');
}
