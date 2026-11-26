import type { ShipmentState } from './states';
import { applyEvent } from './transitions';
import { HOUR } from '@/lib/clock';
import type { EventLeg } from '@/lib/carriers/correos/return-code';

/**
 * The projection. Given every event a shipment has ever had, work out where it
 * is now. Pure: no clock, no database, no surprises — which is what makes it
 * safe to replay the whole table after fixing a normaliser bug.
 */

/**
 * "Prerregistrado" — the label exists in Correos' systems and the parcel is
 * still with us. Named here because three places key off it: the ship-date
 * fallback, the pre-admission flag, and the state map.
 */
export const PRE_ADMISSION_CODE = 'A090000V';

/**
 * What one event on the RETURN LEG means for the parcel.
 *
 * The whole of it: somebody took the box, or they did not yet. Exported
 * because the Settings Correos test has to answer the same question about a
 * `DX` code typed into its box, and two answers to "what does this event mean
 * on the way back" is one too many — the screen would say "Delivered" about a
 * parcel that is on our own shelf, which is the exact mistake this feature
 * exists to end.
 *
 * `collected` as well as `delivered`. Both mean somebody took it, and on this
 * leg that somebody is us. Reading only `delivered` would leave a parcel
 * handed over at a counter in "Coming back" for ever.
 *
 * Anything else — in transit, out for delivery, a failed attempt at OUR door,
 * sitting at an office waiting for us — is the parcel still on its way back,
 * and that is all a single event is allowed to say. The leg's own `returnedAt`
 * is decided across all of its events, below, not from any one of them.
 */
export function returnLegMeans(
  mappedState: ShipmentState | null,
): 'returned' | 'returning' {
  return mappedState === 'delivered' || mappedState === 'collected' ? 'returned' : 'returning';
}

/**
 * What a WHOLE return leg says, which is not what its newest event says.
 *
 * Two ways those differ, and the catch-up will produce both:
 *
 *   A HANDOVER THAT IS NOT THE NEWEST EVENT. Correos go on scanning after they
 *   have delivered something — `canTransition` exists because they do — so a
 *   leg can read "Clasificado" after "Entregado". The loop below keeps
 *   `returnedAt` from ANY handover and lets it beat `returnStartedAt`
 *   unconditionally, because a leg that has both is a leg that finished. A
 *   reader that looked only at the newest event would say "still on its way
 *   back" about a parcel on our own shelf.
 *
 *   A NEWEST EVENT WITH NO MAPPING. The leg counts as started from any event,
 *   mapped or not — see `returnStartedAt` below, set before the mapping is
 *   even looked at — because a code Correos answered about at all is a return
 *   that exists. The return leg's own wordings are the ones nobody has mapped
 *   yet ("Devolución admitida"), so this is the common case, not the odd one.
 *
 * Exported for the Settings Correos test, which has to answer the same
 * question about a `DX` code typed into its box and must not answer it
 * differently from the parcel. Null for no events at all: Correos know the
 * code and have said nothing about it, and that is not a reading.
 */
export function returnLegReads(
  mappedStates: readonly (ShipmentState | null)[],
): 'returned' | 'returning' | null {
  if (!mappedStates.length) return null;
  return mappedStates.some((m) => returnLegMeans(m) === 'returned') ? 'returned' : 'returning';
}

export interface ProjectableEvent {
  eventCode: string;
  eventDesc: string;
  occurredAt: Date;
  mappedState: ShipmentState | null;
  officeCode?: string | null;
  officeName?: string | null;
  /**
   * Which journey this event belongs to. Absent means outbound, which is what
   * every event written before the return leg existed is.
   */
  leg?: EventLeg;
}

export interface Projection {
  state: ShipmentState;
  stateSince: Date | null;
  /** When it arrived at the post office the countdown is running against. */
  officeArrivedAt: Date | null;
  officeCode: string | null;
  officeName: string | null;
  /** The most recent failed delivery. The first four rungs hang off this. */
  failedAt: Date | null;
  /** Newest event of any kind, mapped or not. Silence is measured from here. */
  lastEventAt: Date | null;
  /**
   * The first Prerregistrado event (`A090000V`): Correos' own first sighting
   * of the label. Used as the ship date when no source gave us a real one.
   *
   * The FIRST, not the newest. A label re-registered after a problem would
   * otherwise move the parcel's ship date forward and reset its place in the
   * retention window.
   */
  preAdmittedAt: Date | null;
  /**
   * When Correos delivered the return back to US, from the return leg's own
   * delivery event. Null until then, and null for the great majority of
   * parcels, which never come back.
   */
  returnedAt: Date | null;
  eventCount: number;
  /** Events Correos sent that we have no mapping for. */
  unmappedCount: number;
}

/**
 * Sorting is by `occurredAt`, with the event code as a tiebreak so two events
 * stamped the same second always land in the same order — otherwise replaying
 * the same table twice could produce two different answers.
 */
function byOccurrence(a: ProjectableEvent, b: ProjectableEvent): number {
  const d = a.occurredAt.getTime() - b.occurredAt.getTime();
  return d !== 0 ? d : a.eventCode.localeCompare(b.eventCode);
}

export function project(events: readonly ProjectableEvent[]): Projection {
  const ordered = [...events].sort(byOccurrence);

  let state: ShipmentState = 'created';
  let stateSince: Date | null = null;
  let officeArrivedAt: Date | null = null;
  let officeCode: string | null = null;
  let officeName: string | null = null;
  let failedAt: Date | null = null;
  let lastEventAt: Date | null = null;
  let preAdmittedAt: Date | null = null;
  let unmappedCount = 0;
  let returnStartedAt: Date | null = null;
  let returnedAt: Date | null = null;

  for (const ev of ordered) {
    if (!lastEventAt || ev.occurredAt > lastEventAt) lastEventAt = ev.occurredAt;

    /*
     * THE RETURN LEG NEVER DRIVES THE STATE MACHINE.
     *
     * Its events belong to a different tracking code — the parcel's journey
     * back to us — and every one of them describes that journey in exactly the
     * words Correos uses for a journey to a customer. "En reparto" on the
     * return leg is a van bringing the parcel to OUR door; applied the ordinary
     * way it would read as out for delivery, put the parcel back on a worklist,
     * and start messaging a customer about a parcel they refused a week ago.
     * "Entregado" would say the customer has it.
     *
     * So the whole leg is taken out of the loop and allowed to say two things
     * and nothing else, below: the parcel is coming back, or it is back.
     */
    if (ev.leg === 'return') {
      if (ev.mappedState === null) unmappedCount += 1;
      // The return has at least started. The earliest event on the leg is when
      // Correos created it, which is the honest "coming back since".
      if (!returnStartedAt || ev.occurredAt < returnStartedAt) returnStartedAt = ev.occurredAt;
      // `returnLegMeans` above, so the Settings test and this cannot drift.
      if (returnLegMeans(ev.mappedState) === 'returned') {
        if (!returnedAt || ev.occurredAt > returnedAt) returnedAt = ev.occurredAt;
      }
      continue;
    }

    if (ev.eventCode === PRE_ADMISSION_CODE
      && (!preAdmittedAt || ev.occurredAt < preAdmittedAt)) {
      preAdmittedAt = ev.occurredAt;
    }
    if (ev.mappedState === null) { unmappedCount += 1; continue; }

    const next = applyEvent(state, ev.mappedState);
    if (next !== state) {
      state = next;
      stateSince = ev.occurredAt;
    }

    // These two are remembered even when the state has moved on since, because
    // the countdown and the post-failure ladder are both anchored to them.
    if (ev.mappedState === 'at_office') {
      officeArrivedAt = ev.occurredAt;
      officeCode = ev.officeCode ?? officeCode;
      officeName = ev.officeName ?? officeName;
    }
    if (ev.mappedState === 'failed') failedAt = ev.occurredAt;
  }

  /*
   * There is deliberately no deadline here any more.
   *
   * This used to compute one: `deadlineFrom(officeArrivedAt, depositDays)`,
   * where `depositDays` came from a per-service number an operator typed into
   * Settings — 15, flagged "still a guess", and never confirmed with anybody.
   * Every countdown, last day and "goes back on" date in the system hung off
   * it, which meant every one of them was an invention presented as a fact,
   * including to customers.
   *
   * Correos does not say when a parcel will go back. What they do say, when it
   * happens, is that it IS going back — "Finalizado plazo retirada", phase
   * DEVOLUCION — and that event is what moves a parcel to `returning` now. So
   * the projection keeps the fact (`officeArrivedAt`) and stops deriving a
   * date from it.
   */
  /*
   * And now the two things the return leg is allowed to say, applied through
   * `canTransition` like anything else — so a parcel the operator has already
   * closed by hand is not reopened by a van.
   *
   * Delivered beats started: a leg that has both is a leg that finished.
   */
  if (returnedAt) {
    const next = applyEvent(state, 'returned');
    if (next !== state) { state = next; stateSince = returnedAt; }
  } else if (returnStartedAt) {
    const next = applyEvent(state, 'returning');
    if (next !== state) { state = next; stateSince = returnStartedAt; }
  }

  return {
    state,
    stateSince,
    officeArrivedAt,
    officeCode,
    officeName,
    failedAt,
    lastEventAt,
    preAdmittedAt,
    returnedAt,
    eventCount: ordered.length,
    unmappedCount,
  };
}

/**
 * Silence, not a state change. A parcel Correos has said nothing about for
 * longer than `afterHours` is worth asking about — the events stop arriving
 * long before anybody notices the parcel is missing.
 *
 * Only applies to parcels in motion. A parcel sitting at a post office is
 * *expected* to be silent for a fortnight; flagging that would bury the ones
 * that genuinely vanished.
 */
export function isStale(p: Projection, at: Date, afterHours: number): boolean {
  if (!p.lastEventAt) return false;
  if (p.state !== 'accepted' && p.state !== 'in_transit' && p.state !== 'out_for_delivery') {
    return false;
  }
  return at.getTime() - p.lastEventAt.getTime() > afterHours * HOUR;
}
