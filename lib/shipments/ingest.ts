import { and, eq, or, sql as raw } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  escalationFires, eventReviewQueue, offices, orders, shipmentEvents, shipments,
} from '@/db/schema';
import { matchCorreosEvent, needsReview } from '@/lib/carriers/correos/state-map';
import type { EventLeg } from '@/lib/carriers/correos/return-code';
import type { ShipmentState } from '@/lib/state-machine/states';
import { RETURN_STATES, TERMINAL_STATES } from '@/lib/state-machine/states';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';
import { money } from '@/lib/escalation/decide';
import { fmt, shortDate } from '@/lib/time';
import { openTask, closeTasks } from '@/lib/escalation/tasks';
import { silence } from '@/lib/escalation/silence';
import { reproject } from './repo';

/**
 * One event in. Push and the reconcile sweep both come through here.
 *
 * Writing the same event twice is not an error and is not a special case — the
 * UNIQUE(shipment_id, event_code, occurred_at) constraint makes the second
 * write a no-op, and because nothing downstream runs when nothing was
 * inserted, a customer who already heard from us does not hear from us again.
 * That one index is what lets push and polling coexist at all.
 */

export interface IncomingEvent {
  shippingCode: string;
  eventCode: string;
  eventDesc: string;
  /**
   * Correos' coarse delivery phase, when they send one: "EN CAMINO" and so on.
   * Used only as the state mapper's last resort, and never stored as a column
   * of its own — it lives on the raw payload like everything else we do not
   * yet read.
   */
  phase?: string | null;
  /**
   * Correos' longer sibling of the description — `expandedText` in the
   * trackpub feed, `extendedText` on their public tracker.
   *
   * Read for exactly one thing: "Desestacionado" means a hold was lifted and
   * says nothing about which way the parcel then went, and only this text
   * ("Envío pendiente de devolución") settles it. See state-map.ts.
   */
  longText?: string | null;
  /**
   * Which journey this event belongs to. Absent means outbound, which is what
   * every event arriving on a parcel's own tracking code is.
   */
  leg?: EventLeg;
  occurredAt: Date;
  source: 'push' | 'poll' | 'system';
  officeCode?: string | null;
  officeName?: string | null;
  officeAddress?: string | null;
  rawPayload: unknown;
}

export interface IngestResult {
  status: 'inserted' | 'duplicate' | 'unknown_shipment';
  shipmentId?: string;
  mappedState?: ShipmentState | null;
  stateChanged?: boolean;
  /** Which journey the event turned out to belong to. */
  leg?: EventLeg;
}

export interface IngestOptions {
  /**
   * History, not news. Write the event and recompute the state, but fire none
   * of the side effects: no ticker line, no task, no alert.
   *
   * This exists for the thirty-day pull. A parcel whose whole life arrives in
   * one go would otherwise narrate every step of it — "nobody home, reminders
   * started", "now at the post office", "delivered, closed itself" — for
   * something that finished a fortnight ago. A thousand of those would bury a
   * whole day of real events in a ticker that holds twenty-four hours.
   *
   * The caller decides once, at the end, what the parcel needs NOW. See
   * `settleHistory`.
   */
  quiet?: boolean;
}

export async function ingestEvent(
  ev: IncomingEvent,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  /*
   * TWO CODES CAN NAME ONE PARCEL. The one on the label that went out, and the
   * one Correos invented to bring it back — see
   * lib/carriers/correos/return-code.ts. Until this lookup knew about the
   * second, every event on a return answered `unknown_shipment` and was
   * dropped on the floor, which is why no parcel in this database had ever
   * reached `returned`.
   *
   * The outbound code wins when both somehow match, so the ordering is
   * explicit rather than left to the planner: `shipping_code` is unique and
   * `return_code` is not, and a parcel must never be decided by which row
   * Postgres happened to reach first.
   */
  const [ship] = await getDb().select({
    id: shipments.id,
    state: shipments.state,
    shippingCode: shipments.shippingCode,
  })
    .from(shipments)
    .where(or(
      eq(shipments.shippingCode, ev.shippingCode),
      eq(shipments.returnCode, ev.shippingCode),
    ))
    .orderBy(raw`(${shipments.shippingCode} = ${ev.shippingCode}) DESC`)
    .limit(1);

  if (!ship) {
    // A tracking code we have never seen. Correos pushes for everything the
    // account ships, including parcels created outside this system, so this is
    // routine — log it and move on rather than treating it as a failure.
    return { status: 'unknown_shipment' };
  }

  /*
   * Which journey this event describes.
   *
   * Taken from WHICH code matched rather than from the event, because the
   * event does not know: Correos describe the return leg in exactly the words
   * they use for the outbound one. An explicit `ev.leg` wins, which is how the
   * catch-up replays a return it fetched itself.
   */
  const leg: EventLeg = ev.leg
    ?? (ship.shippingCode === ev.shippingCode ? 'outbound' : 'return');

  // Three signals, in order of how much they are worth: the event code, the
  // Spanish wording, then the coarse phase. A match that only the phase found
  // still goes to the review queue — it is enough to move the parcel along and
  // not enough to claim we recognise the event, and collecting the codes we do
  // not have is the entire job of that queue.
  const match = matchCorreosEvent(ev.eventCode, ev.eventDesc, ev.phase, ev.longText);
  const mapped = match?.state ?? null;
  // One rule for "should a human look at this", shared with `unmappedIn`, so
  // the queue and the normaliser cannot disagree about which events are new.
  if (needsReview(ev.eventCode, ev.eventDesc, ev.phase, ev.longText)) await queueForReview(ev);

  if (ev.officeCode) await upsertOffice(ev);

  const inserted = await getDb().insert(shipmentEvents).values({
    shipmentId: ship.id,
    rawPayload: ev.rawPayload as object,
    eventCode: ev.eventCode,
    eventDesc: ev.eventDesc,
    occurredAt: ev.occurredAt,
    receivedAt: now(),
    source: ev.source,
    mappedState: mapped,
    officeCode: ev.officeCode ?? null,
    officeName: ev.officeName ?? null,
    leg,
  }).onConflictDoNothing({
    target: [shipmentEvents.shipmentId, shipmentEvents.eventCode, shipmentEvents.occurredAt],
  }).returning({ id: shipmentEvents.id });

  if (!inserted.length) {
    return { status: 'duplicate', shipmentId: ship.id, mappedState: mapped };
  }

  const before = ship.state as ShipmentState;
  const after = (await reproject(ship.id)).state;

  if (after !== before && !opts.quiet) await onStateEntered(ship.id, before, after);

  return {
    status: 'inserted',
    shipmentId: ship.id,
    mappedState: mapped,
    stateChanged: after !== before,
    leg,
  };
}

/**
 * Decide, once, what a parcel whose history just arrived needs today.
 *
 * Call this after replaying a parcel's events with `{ quiet: true }`.
 *
 * Two rules, and they are the whole point of the function:
 *
 * A parcel that was already finished before the pull gets NOTHING. No ticker
 * line, no task, no return alert. It was delivered a fortnight ago; saying so
 * now would be news about nothing, and a "put it back in stock" task for a
 * parcel that came back last month is a task nobody can do.
 *
 * A parcel that still needs a person gets exactly what a new event of that
 * state would give it today — the task and the one line — and then every
 * message rung whose due time is in the past is marked fired. Otherwise the
 * first tick would send a customer the four reminders they should have had
 * last week, all at once, about a parcel they may already have collected.
 * The final warning stays armed, because that one is still ahead of them.
 */
export async function settleHistory(shipmentId: string): Promise<'finished' | 'needs_person' | 'quiet'> {
  const [ship] = await getDb().select({ state: shipments.state, dropped: shipments.droppedAt })
    .from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
  if (!ship) return 'quiet';

  const state = ship.state as ShipmentState;

  if (TERMINAL_STATES.has(state) || ship.dropped !== null) {
    // Silenced completely: nothing is owed on a parcel that is already over.
    await silence(shipmentId, { keepFinal: false });
    return 'finished';
  }

  const needsPerson = state === 'failed' || state === 'bad_address'
    || state === 'at_office' || state === 'refused' || state === 'returning';

  if (needsPerson) {
    await onStateEntered(shipmentId, 'created', state);
    // After, not before: `onStateEntered` arms the ladder for this state, and
    // this is what drops the rungs that were due while we were not looking.
    await silence(shipmentId, { keepFinal: true });
    return 'needs_person';
  }

  // Moving normally. Nothing is owed and nothing needs silencing — the ladder
  // only has rungs once something has gone wrong.
  return 'quiet';
}

/**
 * Correos said something we have no mapping for. Keep it, count it, show it to
 * a human — and change nothing. An unknown code must never stop the parcels we
 * do understand from being chased.
 */
async function queueForReview(ev: IncomingEvent): Promise<void> {
  await getDb().insert(eventReviewQueue).values({
    eventCode: ev.eventCode,
    eventDesc: ev.eventDesc,
    samplePayload: ev.rawPayload as object,
    firstSeenAt: now(),
    lastSeenAt: now(),
  }).onConflictDoUpdate({
    target: [eventReviewQueue.eventCode, eventReviewQueue.eventDesc],
    set: { timesSeen: raw`${eventReviewQueue.timesSeen} + 1`, lastSeenAt: now() },
  });
}

async function upsertOffice(ev: IncomingEvent): Promise<void> {
  // An event often carries only the office code. Falling back to the code as
  // the name is fine for an office we have never seen, but it must never
  // overwrite a real name we already have — a customer sent to "OF-MAD-12"
  // instead of "Oficina Madrid Sucursal 12" cannot find the building.
  await getDb().insert(offices).values({
    correosCode: ev.officeCode!,
    name: ev.officeName ?? ev.officeCode!,
    address: ev.officeAddress ?? '',
    updatedAt: now(),
  }).onConflictDoUpdate({
    target: offices.correosCode,
    set: {
      name: ev.officeName
        ? raw`COALESCE(NULLIF(EXCLUDED.name, ''), ${offices.name})`
        : raw`${offices.name}`,
      address: ev.officeAddress
        ? raw`COALESCE(NULLIF(EXCLUDED.address, ''), ${offices.address})`
        : raw`${offices.address}`,
      updatedAt: now(),
    },
  });
}

/* -------------------------------------------------------------------------- */

/**
 * What entering a state means. This is the part of the engine that reacts to
 * Correos rather than to the clock.
 */
async function onStateEntered(shipmentId: string, from: ShipmentState, to: ShipmentState): Promise<void> {
  const detail = await getDb().select({
    customerName: orders.customerName,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    orderNumber: orders.orderNumber,
    postalCode: orders.postalCode,
    city: orders.city,
    orderId: orders.id,
    officeName: offices.name,
    deadline: shipments.officeDeadline,
    // For the one line that says a parcel is physically back: which code
    // brought it and when Correos handed it over.
    returnCode: shipments.returnCode,
    returnedAt: shipments.returnedAt,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  const d = detail[0];
  if (!d) return;

  const name = d.customerName;
  const office = d.officeName ?? 'the post office';

  // Any update from Correos answers the "we have heard nothing" question.
  await closeTasks(shipmentId, ['chase_carrier']);
  await getDb().delete(escalationFires).where(and(
    eq(escalationFires.shipmentId, shipmentId),
    eq(escalationFires.rungId, 'stale'),
  ));

  switch (to) {
    case 'failed': {
      // A fresh failure restarts the ladder: the four rungs below hang off
      // this failure, not the one a week ago.
      await getDb().delete(escalationFires).where(eq(escalationFires.shipmentId, shipmentId));
      await getDb().update(shipments)
        .set({ mutedUntil: null, snoozeReason: null, reacted: false, escalationStage: 'failed' })
        .where(eq(shipments.id, shipmentId));
      await say(`${name} — nobody home, reminders started`, shipmentId);
      break;
    }

    case 'at_office': {
      await getDb().update(shipments).set({ escalationStage: 'at_office' }).where(eq(shipments.id, shipmentId));
      const when = d.deadline ? `, last day ${shortDate(d.deadline)}` : '';
      await say(`${name} — now at ${office}${when}`, shipmentId);
      break;
    }

    case 'delivered': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId);
      await getDb().update(shipments).set({ mutedUntil: null, snoozeReason: null, escalationStage: null })
        .where(eq(shipments.id, shipmentId));
      await say(`${name} — delivered, closed itself`, shipmentId);
      break;
    }

    case 'collected': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId);
      await getDb().update(shipments).set({ mutedUntil: null, snoozeReason: null, escalationStage: null })
        .where(eq(shipments.id, shipmentId));
      await say(`${name} — picked it up, ${money(d.valueCents)} saved, closed itself`, shipmentId);
      break;
    }

    case 'bad_address': {
      await silence(shipmentId, { keepFinal: false });
      await openTask({
        shipmentId, type: 'address_fix', reason: 'carrier_says_wrong_address',
        label: 'Wrong address — fix it with Correos',
      });
      await say(`${name} — Correos says the address is wrong, on your list`, shipmentId);
      break;
    }

    case 'refused': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId, ['call', 'contact']);
      await markRepeatRisk(d.orderId);
      await openTask({
        shipmentId, type: 'receive_return', reason: 'refused', label: 'Put back in stock',
      });
      await say(`${name} — doesn't want it, ${money(d.valueCents)} lost, waiting to go back in stock`, shipmentId);
      break;
    }

    case 'returning': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId, ['call', 'contact']);
      await markRepeatRisk(d.orderId);
      await openTask({
        shipmentId, type: 'receive_return', reason: 'returning', label: 'Put back in stock',
      });
      const pay = d.paymentMethod === 'cod' ? 'Cash on delivery' : 'Prepaid';
      await say(
        `Coming back to us — ${d.orderNumber} · ${name} · ${money(d.valueCents)} · ${pay} · ${whyBack(from, office)}`,
        shipmentId,
      );
      break;
    }

    /*
     * IT IS BACK. The state nothing in this database had ever reached.
     *
     * Deliberately NOT the same branch as `returning`. The old shared branch
     * said "Coming back to us … time ran out at the post office" for both,
     * which on arrival is two lies in one line: it is not coming back, it is
     * here, and for the twenty-nine parcels whose return started with a wrong
     * address nothing ever ran out anywhere.
     *
     * The task stays. It is the warehouse's "put it back in stock", not a
     * customer message or a ladder rung — those the return leg must never
     * fire, and `silence` here is what makes sure of it. A parcel that jumps
     * straight from `bad_address` to `returned` (which the catch-up will do,
     * and which happens whenever we never saw the return start) would
     * otherwise land on the shelf with nothing in the system asking anybody
     * to deal with it.
     */
    case 'returned': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId, ['call', 'contact']);
      await markRepeatRisk(d.orderId);
      await openTask({
        shipmentId, type: 'receive_return', reason: 'returned', label: 'Put back in stock',
      });
      await say(backWithUsLine(d.orderNumber, d.returnCode, d.returnedAt), shipmentId);
      break;
    }

    case 'accepted': {
      // Before anything has gone wrong: is this a postcode that fails far more
      // than average? Preventing one failed delivery beats rescuing three.
      if (await isWatchedArea(d.postalCode)) {
        await openTask({
          shipmentId, type: 'insight', reason: 'area_fails_often',
          label: 'This area fails often — worth confirming the address now',
        });
        const town = (d.city ?? '').split(',')[0];
        await say(
          `${name} — ${town} fails far more than average, worth confirming the address before it goes out`,
          shipmentId,
        );
      }
      break;
    }

    default:
      break;
  }

  if (RETURN_STATES.has(to) && !RETURN_STATES.has(from)) {
    // `to`, not an assumption. A parcel can land straight in `returned` —
    // from `bad_address`, which is not a return state — and telling somebody
    // it "is on its way back" about a parcel already on the shelf is the same
    // class of mistake this whole change exists to fix.
    await notifyReturnStarted(shipmentId, to);
  }
}

/**
 * Why a parcel is coming back, in the words that are actually true of it.
 *
 * The previous version of this line said "time ran out at the post office"
 * whatever had happened, which was wrong for every return that started with a
 * refusal or a bad address — twenty-nine of the eighty-seven on the operator's
 * screen. Where the state it came from does not say, this says nothing rather
 * than guessing: `returning` can be reached from an event that only tells us
 * Correos have started a return, and not why.
 */
function whyBack(from: ShipmentState, office: string): string {
  switch (from) {
    case 'at_office': return `time ran out at ${office}`;
    case 'bad_address': return 'the address was wrong';
    case 'refused': return 'the customer refused it';
    case 'failed': return 'nobody was home';
    default: return 'Correos have started a return';
  }
}

/**
 * The line that says a parcel is physically back with us.
 *
 * It names the return code on purpose. That code is the whole discovery behind
 * this feature — the operator could not find it anywhere in the system and had
 * to read it off Correos' own tracker — and it is what they type into Mi
 * Oficina or search for in the warehouse pile.
 */
function backWithUsLine(
  orderNumber: string,
  returnCode: string | null,
  returnedAt: Date | null,
): string {
  // Both of these are written by the same projection that produced the state,
  // so in practice they are always here. The fallbacks are for a `returned`
  // reached some other way — a hand correction, an older row — where saying
  // less is better than printing "null" at the operator.
  if (!returnCode || !returnedAt) return `${orderNumber} returned — it is back with us`;
  const f = fmt(returnedAt);
  return `${orderNumber} returned — Correos delivered ${returnCode} back to us on ${f.date} at ${f.time}`;
}

async function markRepeatRisk(orderId: string): Promise<void> {
  await getDb().update(orders).set({ repeatRisk: true }).where(eq(orders.id, orderId));
}

async function isWatchedArea(postalCode: string | null): Promise<boolean> {
  if (!postalCode) return false;
  const { postcodeStats } = await import('@/db/schema');
  const [row] = await getDb().select({ watch: postcodeStats.watch }).from(postcodeStats)
    .where(eq(postcodeStats.postalCode, postalCode)).limit(1);
  return row?.watch ?? false;
}

/**
 * A return has started. Somebody internal needs to know now, with everything
 * they would otherwise have to go and look up.
 */
async function notifyReturnStarted(shipmentId: string, to: ShipmentState): Promise<void> {
  const { raiseAlert } = await import('@/lib/alerts');
  const row = await getDb().select({
    orderNumber: orders.orderNumber,
    customerName: orders.customerName,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    shippingCode: shipments.shippingCode,
    returnCode: shipments.returnCode,
    returnedAt: shipments.returnedAt,
    state: shipments.state,
    officeName: offices.name,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  const d = row[0];
  if (!d) return;

  const why = d.state === 'refused'
    ? 'the customer refused it at the door'
    : `nobody collected it from ${d.officeName ?? 'the post office'} in time`;

  // Already here, or still travelling. The difference matters to whoever opens
  // this: one is a parcel to find on a shelf, the other is one to expect.
  const arrived = to === 'returned';
  const tracking = d.returnCode
    ? [`Out:       ${d.shippingCode}`, `Back:      ${d.returnCode}`]
    : [`Tracking:  ${d.shippingCode}`];

  await raiseAlert({
    // One alert per parcel per return. A parcel only comes back once; if it
    // somehow re-enters `returning` after being received, that is the same
    // event being re-reported rather than a second return.
    dedupeKey: `return-started:${shipmentId}`,
    shipmentId,
    subject: arrived
      ? `Back with us: ${d.orderNumber} · ${d.customerName} · ${money(d.valueCents)}`
      : `Coming back: ${d.orderNumber} · ${d.customerName} · ${money(d.valueCents)}`,
    lines: [
      arrived
        ? `Order ${d.orderNumber} came back to us${d.returnedAt ? ` on ${shortDate(d.returnedAt)}` : ''} because ${why}.`
        : `Order ${d.orderNumber} is on its way back to us because ${why}.`,
      '',
      `Customer:  ${d.customerName}`,
      `Value:     ${money(d.valueCents)} (${d.paymentMethod === 'cod' ? 'cash on delivery — we earn nothing if it comes back' : 'prepaid — a refund is coming'})`,
      ...tracking,
      '',
      arrived
        ? 'It is on the list to put back in stock.'
        : 'It is on the list to put back in stock when it lands.',
    ],
  });
}
