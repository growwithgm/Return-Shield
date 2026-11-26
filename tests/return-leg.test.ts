import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipmentEvents, shipments } from '@/db/schema';
import { project, returnLegMeans, type ProjectableEvent } from '@/lib/state-machine/project';
import { SHIPMENT_STATES } from '@/lib/state-machine/states';
import {
  STATE_LABEL, eventStateLabel, returnLegStateLabel,
} from '@/lib/carriers/correos/state-map';
import { nextAction, type DecidableShipment } from '@/lib/escalation/decide';
import { ingestEvent } from '@/lib/shipments/ingest';
import {
  assignReturnCodes, noteAssociatedCodes, plausibleReturnCode, pollReturnLegs,
  returnLegQueue, storeReturnCode, describeProbe,
} from '@/lib/shipments/return-leg';
import { applyReturnCatchUp, previewReturnCatchUp } from '@/lib/shipments/return-catchup';
import { normalisePayload } from '@/lib/carriers/correos/normalise';
import { TestClock, resetClock } from '@/lib/clock';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';
import { RETURN_LEG_RESPONSE, RETURN_STARTED_RESPONSE } from './helpers/correos';

/**
 * The journey home.
 *
 * Correos do not add events to a parcel's own tracking code when they send it
 * back — they create a second shipment with a code of its own, and the
 * original goes quiet the moment the return starts. Return Shield watched only
 * the original, so a parcel delivered back to the warehouse on 19 November
 * still read "Wrong address · 18 Nov" a week later, eighty-seven parcels were
 * stuck in "Coming back" and "Wrong address", and NOTHING in the database had
 * ever reached `returned`.
 *
 * Everything here is about that second code: finding it, following it, and
 * being careful about what its events are allowed to say.
 */

const ORIGINAL = 'PKA6TP9800129340147006H';
const RETURN = 'DXA6TP9800129340128012S';

let clock: InstanceType<typeof TestClock>;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-11-25T10:00:00+01:00');
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

/* ------------------------------------------------ what the screens say about it */

describe('reading a return leg in English', () => {
  /*
   * NOTHING HAD EVER REACHED `returned`, so none of these texts had ever been
   * seen by anybody. The catch-up puts about sixty-nine parcels on Today at
   * once, which is when every one of them gets read for the first time.
   */
  it('reads the return leg as the journey home, not as the customer\u2019s', () => {
    // The three the operator found, and what they used to read.
    expect(eventStateLabel('created', 'return')).toBe('Return accepted by Correos');
    expect(eventStateLabel('created', 'outbound'))
      .toBe('Pre-admission (label made, not handed to Correos)');

    expect(eventStateLabel('out_for_delivery', 'return')).toBe('On its way back to us');
    expect(eventStateLabel('out_for_delivery', 'outbound')).toBe('Out for delivery');

    expect(eventStateLabel('delivered', 'return')).toBe('Back with us');
    expect(eventStateLabel('delivered', 'outbound')).toBe('Delivered');
  });

  it('has a word for every state a return leg can carry, not only the happy ones', () => {
    /*
     * The mapper reads a code, a wording and a phase and never reads a leg, so
     * a return shipment produces every event an outbound one can — with US as
     * the addressee. These four are rare and all real.
     */
    expect(eventStateLabel('failed', 'return'))
      .toBe('Correos could not deliver the return to us');
    expect(eventStateLabel('at_office', 'return')).toBe('Waiting for us at a post office');
    // `H01R421V` on the return leg is Correos saying the address they are
    // returning it TO is wrong — ours, the one RETURN_POSTCODE put in the code.
    expect(eventStateLabel('bad_address', 'return')).toBe('Correos says our returns address is wrong');
    // "On our side", not "at our door": the wordings behind `refused` name the
    // addressee, which on this leg is us, and no place at all — and this same
    // leg leaves parcels at counters.
    expect(eventStateLabel('refused', 'return')).toBe('Return refused on our side');
    expect(eventStateLabel('refused', 'return')).not.toMatch(/door|office|counter/);

    // And every state says something different about the way back. The table
    // being total is what lets `eventStateLabel` refuse to guess, below.
    for (const state of SHIPMENT_STATES) {
      const back = eventStateLabel(state, 'return');
      expect(back, state).toBeTruthy();
      expect(back, state).not.toBe(eventStateLabel(state, 'outbound'));
    }
  });

  it('shows a bare state name rather than the outbound word it has no label for', () => {
    /*
     * The fall-through this deliberately does NOT have. A return-leg state
     * the table has no sentence for reads as the raw name — ugly, obvious,
     * and somebody fixes it. Falling back to `STATE_LABEL` would put "Out for
     * delivery" on a van at our own door again, silently, on the day somebody
     * adds a state and forgets a line.
     */
    expect(eventStateLabel('something_new', 'return')).toBe('something_new');
    expect(eventStateLabel('something_new', 'outbound')).toBe('something_new');
  });

  it('says nothing about an event it has no mapping for', () => {
    // The caller keeps its own "not seen before" wording rather than being
    // handed a guess.
    expect(eventStateLabel(null, 'return')).toBeNull();
    expect(eventStateLabel(null, 'outbound')).toBeNull();
    // And an absent leg reads as the outbound one, which is what every event
    // written before the return leg existed is.
    expect(eventStateLabel('delivered')).toBe('Delivered');
  });

  it('reads a DX code typed into the Settings test as the parcel will read', () => {
    // "Reads as: Delivered" was true of nothing anybody wanted to know: the
    // box is on our own shelf.
    expect(returnLegStateLabel('returned')).toBe('Back with us (Returned)');
    expect(returnLegStateLabel('returning')).toBe('Still on its way back to us (Coming back)');
    // The parcel's own word in brackets, because that is what every other
    // screen calls it and nobody should have to guess they are the same thing.
    expect(returnLegStateLabel('returned')).toContain(STATE_LABEL.returned);
  });

  it('agrees with the projection about what one return event means', () => {
    /*
     * The Settings test and the state a parcel actually ends up in must not
     * drift, so both read `returnLegMeans`. `collected` counts as back with
     * us: on this leg the somebody who took it is us.
     */
    expect(returnLegMeans('delivered')).toBe('returned');
    expect(returnLegMeans('collected')).toBe('returned');
    for (const state of ['created', 'accepted', 'in_transit', 'out_for_delivery', 'failed', 'at_office'] as const) {
      expect(returnLegMeans(state), state).toBe('returning');
    }
    expect(returnLegMeans(null)).toBe('returning');
  });
});

describe('the reason line on Today', () => {
  /** A parcel on the restock pile, with nothing else to say about it. */
  function back(over: Partial<DecidableShipment>): DecidableShipment {
    return {
      id: 'x',
      state: 'returned',
      officeArrivedAt: null,
      officeName: null,
      returnedAt: null,
      town: '',
      customerName: 'Cristina Martínez',
      valueCents: 3990,
      paymentMethod: 'cod',
      dropped: false,
      restocked: false,
      redirectPending: false,
      mutedUntil: null,
      openTasks: [],
      lastContactOutcome: null,
      ...over,
    };
  }

  it('says the day a returned parcel landed', () => {
    const why = nextAction(back({ returnedAt: new Date('2026-11-19T09:37:00Z') }))?.why;
    expect(why).toBe('Correos handed it back on 19 Nov');
  });

  it('does not say a van brought it, for a parcel fetched from a counter', () => {
    /*
     * `returnedAt` is stamped by either handover event — `delivered`, a van at
     * our door, and `collected`, "Entregado en oficina", which is somebody
     * from here walking to a counter to get it. The row does not carry which,
     * and the timeline for the second one reads "Back with us (collected at a
     * Correos counter)". So the reason line must not pick one.
     */
    expect(returnLegMeans('delivered')).toBe('returned');
    expect(returnLegMeans('collected')).toBe('returned');
    const why = nextAction(back({ returnedAt: new Date('2026-11-19T09:37:00Z') }))?.why ?? '';
    expect(why).not.toMatch(/delivered|to our door|van/i);
    expect(why).toContain('19 Nov');
  });

  it('says only that it is here when no date was recorded', () => {
    // A `returned` row with no `returnedAt` is one somebody corrected by hand:
    // `reproject` writes the state and the date in one statement. No invented
    // date — see DECISIONS.md and tests/no-invented-date.test.ts.
    expect(nextAction(back({}))?.why).toBe('It is back with us');
  });

  it("keeps \"Customer didn't want it\" for the one state it is true of", () => {
    // It used to be the line on EVERY returned parcel, and most of the
    // eighty-seven came back on a wrong address or an expired window.
    expect(nextAction(back({ state: 'refused' }))?.why).toBe("Customer didn't want it");
    expect(nextAction(back({ state: 'returned' }))?.why).not.toContain('want it');
    expect(nextAction(back({ state: 'returning' }))?.why).not.toContain('want it');
  });

  it('names the office only when Correos named one', () => {
    expect(nextAction(back({ state: 'returning', officeName: 'Oficina Madrid Sucursal 12' }))?.why)
      .toBe('Correos is sending it back from Oficina Madrid Sucursal 12');
    // The line this replaced fell back to "the post office", which for every
    // return that started with a wrong address named an office the parcel had
    // never been to.
    expect(nextAction(back({ state: 'returning' }))?.why).toBe('Correos is sending it back');
  });

  it('never claims to know WHY a return started, because the row cannot', () => {
    /*
     * The projection overwrites `state` and `state_since` the moment a parcel
     * moves, so a `returned` parcel no longer remembers it was `bad_address`
     * or `at_office`, and the sentence Correos sent lives on `shipment_events`
     * which `nextAction` never sees. A wrong address and an expired collection
     * window are the same thing from here, and the text must not pick one.
     */
    const whys = (['returning', 'returned'] as const).map((state) =>
      nextAction(back({ state, officeArrivedAt: new Date('2026-11-01T00:00:00Z') }))?.why ?? '');

    for (const why of whys) {
      expect(why.toLowerCase()).not.toContain('address');
      expect(why.toLowerCase()).not.toContain('collect');
      expect(why.toLowerCase()).not.toContain('time ran out');
      expect(why.toLowerCase()).not.toContain('refus');
    }
  });
});

/* -------------------------------------------------------- the return leg's events */

function ev(
  code: string,
  mapped: ProjectableEvent['mappedState'],
  at: string,
  leg: 'outbound' | 'return' = 'outbound',
): ProjectableEvent {
  return { eventCode: code, eventDesc: code, occurredAt: new Date(at), mappedState: mapped, leg };
}

describe('what the return leg is allowed to say', () => {
  /*
   * THE RULE, AND IT IS A SHORT ONE. Correos describe a van bringing a parcel
   * BACK TO US in exactly the words they use for a van taking one to a
   * customer. So the return leg may say two things and nothing else: the
   * parcel is coming back, or it is back.
   */
  it('says "coming back" while the return is still travelling', () => {
    const p = project([
      ev('A090000V', 'created', '2026-11-10T08:00:00Z'),
      ev('A010000V', 'accepted', '2026-11-11T08:00:00Z'),
      ev('G01L010V', 'out_for_delivery', '2026-11-12T08:00:00Z'),
      // The return leg: admitted, classified, out for delivery — to OUR door.
      ev('A090000V', 'created', '2026-11-18T11:44:00Z', 'return'),
      ev('P040000V', 'in_transit', '2026-11-18T19:02:00Z', 'return'),
      ev('G01L010V', 'out_for_delivery', '2026-11-19T08:11:00Z', 'return'),
    ]);

    expect(p.state).toBe('returning');
    expect(p.returnedAt).toBeNull();
    // Dated from the FIRST event of the leg: when Correos created the return.
    expect(p.stateSince?.toISOString()).toBe('2026-11-18T11:44:00.000Z');
  });

  it('says "returned" at the exact moment Correos handed it back', () => {
    const p = project([
      ev('G01L010V', 'out_for_delivery', '2026-11-12T08:00:00Z'),
      ev('A090000V', 'created', '2026-11-18T11:44:00Z', 'return'),
      ev('I01E010V', 'delivered', '2026-11-19T09:37:00Z', 'return'),
    ]);

    expect(p.state).toBe('returned');
    expect(p.returnedAt?.toISOString()).toBe('2026-11-19T09:37:00.000Z');
    expect(p.stateSince?.toISOString()).toBe('2026-11-19T09:37:00.000Z');
  });

  it('never lets the return leg say anything about the customer', () => {
    /*
     * The failure this prevents: "En reparto" on the return leg is a van
     * driving the parcel to our warehouse. Applied as an ordinary event it
     * would read as out for delivery to the customer, put the parcel back on a
     * worklist and start messaging somebody about a parcel they refused.
     * "Entregado" would say the customer has it.
     */
    const p = project([
      ev('H01R420V', 'failed', '2026-11-12T08:00:00Z'),
      ev('G01L010V', 'out_for_delivery', '2026-11-19T08:11:00Z', 'return'),
      ev('H01I350V', 'at_office', '2026-11-19T08:30:00Z', 'return'),
    ]);

    expect(p.state).toBe('returning');
    // Not out_for_delivery, not at_office, and no office recorded from the leg.
    expect(p.officeArrivedAt).toBeNull();
  });

  it('counts a handover at a counter as back with us, not as a customer pickup', () => {
    // `collected` on the return leg is somebody taking the parcel, and on this
    // leg that somebody is us. Reading only `delivered` would leave a parcel
    // handed over at a counter in "Coming back" for ever.
    const p = project([
      ev('G01L010V', 'out_for_delivery', '2026-11-12T08:00:00Z'),
      ev('I01E020V', 'collected', '2026-11-19T09:37:00Z', 'return'),
    ]);

    expect(p.state).toBe('returned');
    expect(p.returnedAt?.toISOString()).toBe('2026-11-19T09:37:00.000Z');
  });

  it('does not let the return leg move the ship date', () => {
    /*
     * The return leg opens with its own Prerregistrado. Counted as the
     * parcel's pre-admission it would drag the ship date six days forward and
     * move the parcel's place in the retention window — so a return would
     * quietly keep a finished order alive, or hide one.
     */
    const p = project([
      ev('A090000V', 'created', '2026-11-10T08:00:00Z'),
      ev('A090000V', 'created', '2026-11-18T11:44:00Z', 'return'),
    ]);

    expect(p.preAdmittedAt?.toISOString()).toBe('2026-11-10T08:00:00.000Z');
    // The leg still counts as news, because silence is measured from any event.
    expect(p.lastEventAt?.toISOString()).toBe('2026-11-18T11:44:00.000Z');
  });
});

/* ------------------------------------------------------------- storing the code */

describe('the counts the return leg must not touch', () => {
  /*
   * "Correos tried twice" is said down a phone to a customer, and a delivered
   * return leg carries an `out_for_delivery` and often a `failed` of its own —
   * Correos describe the journey back in exactly the words they use for the
   * journey out, because to them it IS one, with us as the addressee. So an
   * attempt count that does not name a leg counts the van that came to OUR
   * door as a visit to the customer's.
   *
   * Read out of the SQL rather than driven through the database, and that is
   * the stronger test of the two here: one inserted return event proves one
   * subquery, while this holds every subquery in the file, including the next
   * one somebody adds. The two that count attempts are inside a raw template
   * literal, where nothing else can check them.
   */
  const SQL = readFileSync('lib/views/parcels.ts', 'utf8')
    // SQL comments inside the template literal talk about `leg` at length.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');

  /** Each `FROM shipment_events` subquery, up to the end of its lateral. */
  function subqueries(): string[] {
    const out: string[] = [];
    const starts = /FROM shipment_events/g;
    for (let m = starts.exec(SQL); m; m = starts.exec(SQL)) {
      const rest = SQL.slice(m.index);
      const end = rest.indexOf('ON true');
      out.push(rest.slice(0, end === -1 ? 500 : end));
    }
    return out;
  }

  it('is actually reading the SQL — an empty sweep would pass by accident', () => {
    expect(subqueries().length).toBeGreaterThanOrEqual(4);
  });

  it('names a leg in every count that turns on what an event means', () => {
    /*
     * The narrow claim, because the broad one is false and worth saying why:
     * the pre-admission lateral takes `min(occurred_at)` of one event code
     * over both legs and does not need a leg, and `lib/shipments/remap.ts`
     * re-maps stored events by their wording, which is leg-independent on
     * purpose. What may never be leg-blind is a subquery that decides
     * something FROM `mapped_state`.
     */
    const blind = subqueries()
      .filter((q) => q.includes('mapped_state'))
      .filter((q) => !/\bleg\s*=\s*'/.test(q));

    expect(blind).toEqual([]);
  });

  it('counts attempts and tries on the outbound leg by name', () => {
    const counting = subqueries().filter((q) => /mapped_state\s*=\s*'(failed|out_for_delivery)'/.test(q));
    expect(counting).toHaveLength(2);
    for (const q of counting) expect(q).toMatch(/\bleg\s*=\s*'outbound'/);
  });
});

describe('which return code a parcel gets', () => {
  it('refuses a code that is not this parcel coming back', () => {
    expect(plausibleReturnCode(ORIGINAL, RETURN)).toBe(true);
    // Right shape, right check letter, wrong parcel.
    expect(plausibleReturnCode(ORIGINAL, 'DXA6TP9800108200128012F')).toBe(false);
    // The parcel's own code is not its return.
    expect(plausibleReturnCode(ORIGINAL, ORIGINAL)).toBe(false);
    // A bad check letter is a misread, and a misread code is nobody's parcel.
    expect(plausibleReturnCode(ORIGINAL, 'DXA6TP9800129340128013S')).toBe(false);
    expect(plausibleReturnCode(ORIGINAL, 'nonsense')).toBe(false);
  });

  it("never overwrites Correos' own answer with our arithmetic", async () => {
    const parcel = await makeShipment({ shippingCode: ORIGINAL, state: 'returning' });

    expect(await storeReturnCode({
      shipmentId: parcel.shipmentId, shippingCode: ORIGINAL, candidate: RETURN, source: 'derived',
    })).toBe('stored');

    // The same code again writes nothing: safe to run the catch-up twice.
    expect(await storeReturnCode({
      shipmentId: parcel.shipmentId, shippingCode: ORIGINAL, candidate: RETURN, source: 'derived',
    })).toBe('kept');

    // Correos name it: the source is upgraded.
    expect(await storeReturnCode({
      shipmentId: parcel.shipmentId, shippingCode: ORIGINAL, candidate: RETURN, source: 'correos',
    })).toBe('stored');

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.id, parcel.shipmentId));
    expect(row.returnCode).toBe(RETURN);
    expect(row.returnCodeSource).toBe('correos');

    // And now our arithmetic cannot touch it, whatever RETURN_POSTCODE says.
    expect(await storeReturnCode({
      shipmentId: parcel.shipmentId,
      shippingCode: ORIGINAL,
      candidate: 'DXA6TP9800129340108320D',
      source: 'derived',
    })).toBe('rejected');
  });

  it('takes the code out of the lookup Correos already answers with', async () => {
    const parcel = await makeShipment({ shippingCode: ORIGINAL, state: 'bad_address' });
    const out = normalisePayload(RETURN_STARTED_RESPONSE, 'poll');

    expect(await noteAssociatedCodes(out.associated)).toBe(1);

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.id, parcel.shipmentId));
    expect(row.returnCode).toBe(RETURN);
    expect(row.returnCodeSource).toBe('correos');
  });

  it('works the code out for a parcel Correos has not named one for', async () => {
    const parcel = await makeShipment({ shippingCode: ORIGINAL, state: 'returning' });

    const outcome = await assignReturnCodes();
    expect(outcome.examined).toBe(1);
    expect(outcome.derived).toBe(1);

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.id, parcel.shipmentId));
    expect(row.returnCode).toBe(RETURN);
    expect(row.returnCodeSource).toBe('derived');

    // Idempotent: nothing left to do.
    expect((await assignReturnCodes()).examined).toBe(0);
  });

  it('fires on the DEVOLUCION event, before the state has caught up', async () => {
    /*
     * This is what rescues the twenty-nine parcels sitting in "Wrong address":
     * their state is wrong, so the signal has to be the event rather than the
     * state. Correos sent "Dirección incorrecta" in phase DEVOLUCION — the
     * address was wrong AND the parcel was already on its way back.
     */
    await makeShipment({ shippingCode: ORIGINAL, state: 'bad_address' });
    for (const event of normalisePayload(RETURN_STARTED_RESPONSE, 'poll').events) {
      await ingestEvent(event, { quiet: true });
    }

    const outcome = await assignReturnCodes();
    expect(outcome.examined).toBe(1);

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.shippingCode, ORIGINAL));
    expect(row.returnCode).toBe(RETURN);
    // And the parcel itself has left Wrong address: phase beats the wording.
    expect(row.state).toBe('returning');
  });

  it('invents nothing for a code it cannot work one out from', async () => {
    await makeShipment({ shippingCode: 'ORDER-12345', state: 'returning' });

    const outcome = await assignReturnCodes();
    expect(outcome.examined).toBe(1);
    expect(outcome.derived).toBe(0);
    expect(outcome.impossible).toBe(1);

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.shippingCode, 'ORDER-12345'));
    expect(row.returnCode).toBeNull();
  });
});

/* -------------------------------------------------------------- following it */

/** Correos, stubbed. One canned answer per code. */
function stubCorreos(answers: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      async lookup(code: string) {
        asked.push(code);
        const body = answers[code];
        if (body === undefined) {
          return {
            ok: false as const,
            status: 404,
            error: 'Correos has never heard of this code',
            retryable: false,
            definitive: true,
          };
        }
        return { ok: true as const, outcome: normalisePayload(body, 'poll'), raw: body };
      },
    },
  };
}

describe('following the return to the end', () => {
  it('asks about the return code and files its events as the journey home', async () => {
    const parcel = await makeShipment({
      shippingCode: ORIGINAL, state: 'returning',
      returnCode: RETURN, returnCodeSource: 'correos',
    });

    const correos = stubCorreos({ [RETURN]: RETURN_LEG_RESPONSE });
    const probe = await pollReturnLegs(correos.client, { quiet: true });

    expect(correos.asked).toEqual([RETURN]);
    expect(probe.answered).toBe(1);
    expect(probe.failed).toBe(0);
    expect(probe.arrived).toBe(1);

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.id, parcel.shipmentId));
    expect(row.state).toBe('returned');
    expect(row.returnedAt?.toISOString()).toBe('2026-11-19T08:37:00.000Z');

    // Every one of those events is on the parcel's own timeline, marked.
    const events = await getDb().select().from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, parcel.shipmentId));
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.leg === 'return')).toBe(true);
  });

  it('does not defer the parcel\u2019s own check by stamping the wrong column', async () => {
    /*
     * `last_reconciled_at` is what the due rule reads (lib/recheck.ts).
     * Stamping it from a return-leg lookup would make the parcel look freshly
     * checked and defer its OUTBOUND check by up to twelve hours — and a
     * parcel in `bad_address` is on the three-hourly list precisely because
     * somebody is waiting on it. The return leg has a column of its own.
     */
    const parcel = await makeShipment({
      shippingCode: ORIGINAL, state: 'bad_address',
      returnCode: RETURN, returnCodeSource: 'derived',
    });
    const long_ago = new Date('2026-11-01T00:00:00Z');
    await getDb().update(shipments).set({ lastReconciledAt: long_ago })
      .where(eq(shipments.id, parcel.shipmentId));

    await pollReturnLegs(stubCorreos({}).client, { quiet: true });

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.id, parcel.shipmentId));
    expect(row.lastReconciledAt?.toISOString()).toBe(long_ago.toISOString());
    expect(row.returnCheckedAt).not.toBeNull();
  });

  it('gives up on a leg that has said nothing for two months', async () => {
    // Without a bound, a derived code for a return that never happened would
    // be asked about forty times an hour for ever. Sixty days is well past
    // Correos' own thirty-day history window.
    const parcel = await makeShipment({
      shippingCode: ORIGINAL, state: 'refused',
      returnCode: RETURN, returnCodeSource: 'derived',
    });
    await getDb().update(shipments)
      .set({ lastEventAt: new Date('2026-09-01T00:00:00Z') })
      .where(eq(shipments.id, parcel.shipmentId));

    expect(await returnLegQueue(50)).toEqual([]);
  });

  it('stops asking once the return has been delivered', async () => {
    await makeShipment({
      shippingCode: ORIGINAL, state: 'returned',
      returnCode: RETURN, returnCodeSource: 'correos', returnedAt: clock.now(),
    });

    expect(await returnLegQueue(50)).toEqual([]);
  });

  it('treats a code Correos has never heard of as normal, not as a failure', async () => {
    /*
     * A derived code for a return Correos has not created yet does not exist
     * on their side. Counting that as an error would paint the Settings screen
     * red for the ordinary case, and counting it as unreached would make the
     * sweep believe it had run out of time and stop.
     */
    await makeShipment({
      shippingCode: ORIGINAL, state: 'returning',
      returnCode: RETURN, returnCodeSource: 'derived',
    });

    const probe = await pollReturnLegs(stubCorreos({}).client, { quiet: true });

    expect(probe.asked).toBe(1);
    expect(probe.unknown).toBe(1);
    expect(probe.failed).toBe(0);
    expect(probe.firstError).toBe('');
    expect(describeProbe(probe)).toContain('never heard of');
  });

  it('says plainly when Correos refuses a DX code outright', async () => {
    /*
     * NOBODY KNOWS WHETHER TRACKPUB SERVES A `DX` CODE. The codes were read off
     * Correos' public tracker, which is a different service, and no DX code
     * has been put to `/search` with these credentials. So a refusal has to be
     * reportable rather than silent — this is the sentence the Settings screen
     * shows.
     */
    await makeShipment({
      shippingCode: ORIGINAL, state: 'returning',
      returnCode: RETURN, returnCodeSource: 'derived',
    });

    const probe = await pollReturnLegs({
      async lookup() {
        return {
          ok: false as const,
          status: 403,
          error: 'Correos refused the request (403)',
          retryable: false,
        };
      },
    }, { quiet: true });

    expect(probe.failed).toBe(1);
    expect(probe.answered).toBe(0);
    expect(describeProbe(probe)).toBe('Correos refused all 1: Correos refused the request (403)');
  });

  it('has nothing to say before anything has been tried', () => {
    expect(describeProbe(null)).toContain('Not tried yet');
  });
});

/* ------------------------------------------------------------------ catch-up */

/**
 * One of the twenty-nine, AS THE OLD CODE LEFT IT.
 *
 * The catch-up exists for rows the OLD mapper wrote, and ingesting the same
 * payload through the NEW one does not produce them — the new mapper reads
 * phase DEVOLUCION first, so "Dirección incorrecta" maps to `returning` and
 * the parcel leaves `bad_address` at ingest. A test that set up its fixture
 * that way would be testing the catch-up against a database that does not
 * need catching up, and would pass whatever the catch-up did.
 *
 * So the rows are put back the way production holds them today:
 *
 *   "Dirección incorrecta"  mapped_state = 'bad_address'   (the wording won)
 *   "Desestacionado"        mapped_state = null            (nothing matched)
 *   the parcel              state        = 'bad_address'
 *
 * The raw payloads are untouched, which is the whole reason a replay is
 * possible at all: every byte Correos ever sent is still there, so the fix is
 * "re-read it", not "go and ask again".
 */
async function asTheOldMapperLeftIt(shipmentId: string): Promise<void> {
  await getDb().update(shipmentEvents)
    .set({ mappedState: 'bad_address' })
    .where(and(
      eq(shipmentEvents.shipmentId, shipmentId),
      eq(shipmentEvents.eventDesc, 'Dirección incorrecta'),
    ));
  await getDb().update(shipmentEvents)
    .set({ mappedState: null })
    .where(and(
      eq(shipmentEvents.shipmentId, shipmentId),
      eq(shipmentEvents.eventDesc, 'Desestacionado'),
    ));
  await getDb().update(shipments)
    .set({ state: 'bad_address' })
    .where(eq(shipments.id, shipmentId));
}

describe('the catch-up', () => {
  it('previews without writing anything, and the apply does what it promised', async () => {
    const parcel = await makeShipment({ shippingCode: ORIGINAL, state: 'bad_address' });
    for (const event of normalisePayload(RETURN_STARTED_RESPONSE, 'poll').events) {
      await ingestEvent(event, { quiet: true });
    }
    await asTheOldMapperLeftIt(parcel.shipmentId);

    const preview = await previewReturnCatchUp();
    expect(preview.comingBack).toBe(1);
    expect(preview.haveCode).toBe(0);
    expect(preview.wouldDerive).toBe(1);
    expect(preview.leavingWrongAddress).toBe(1);
    expect(preview.returnPostcode).toBe('28012');
    expect(preview.example).toEqual([ORIGINAL, RETURN]);

    // NOTHING was written: the second preview says exactly the same thing.
    const again = await previewReturnCatchUp();
    expect(again).toEqual(preview);
    const [before] = await getDb().select().from(shipments)
      .where(eq(shipments.id, parcel.shipmentId));
    expect(before.returnCode).toBeNull();
    expect(before.state).toBe('bad_address');

    /*
     * And now the half the test's own name promised and did not do: the apply
     * has to produce the numbers the preview put on the button. A preview that
     * promises one thing and an apply that does another is the one failure
     * this two-press shape exists to prevent.
     */
    const result = await applyReturnCatchUp();

    expect(result.comingBack).toBe(preview.comingBack);
    expect(result.leavingWrongAddress).toBe(preview.leavingWrongAddress);
    expect(result.wouldDerive).toBe(preview.wouldDerive);
    expect(result.derived).toBe(preview.wouldDerive);
    // Two events re-read, on the one parcel: the wording and the long text.
    expect(result.remappedEvents).toBe(2);
    expect(result.remappedParcels).toBe(1);

    const [after] = await getDb().select().from(shipments)
      .where(eq(shipments.id, parcel.shipmentId));
    expect(after.returnCode).toBe(RETURN);
    expect(after.returnCodeSource).toBe('derived');
    // Out of the Wrong-address worklist, which is where it should never have
    // been: Correos had already started the return on 18 November.
    expect(after.state).toBe('returning');
  });

  it('is safe to press twice', async () => {
    await makeShipment({ shippingCode: ORIGINAL, state: 'returning' });

    const first = await applyReturnCatchUp();
    expect(first.derived).toBe(1);

    const second = await applyReturnCatchUp();
    // Nothing left to derive, and nothing broken by asking again.
    expect(second.derived).toBe(0);

    const [row] = await getDb().select().from(shipments)
      .where(eq(shipments.shippingCode, ORIGINAL));
    expect(row.returnCode).toBe(RETURN);
    expect(row.returnCodeSource).toBe('derived');
  });
});
