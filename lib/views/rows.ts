import { and, desc, eq, gte, inArray, sql as raw } from 'drizzle-orm';
import { getDb, retryableRead } from '@/db';
import { contactLog, offices, orders, shipments, stores, tasks } from '@/db/schema';
import type { ShipmentState } from '@/lib/state-machine/states';
import {
  actionable, callQueue, isSnoozed, money, nextAction, priority, reason, tone,
  type DecidableShipment, type NextAction, type OpenTask, type Tone,
} from '@/lib/escalation/decide';
import { daysAtOffice, exact, human, shortDate } from '@/lib/time';
import { now } from '@/lib/clock';
import {
  emailLink, mapsLink, officeDetails, officeEmailSubject, telLink, whatsappLink,
} from '@/lib/messaging/build-message';
import { customerLabel, isMarketplace, realFirstName } from '@/lib/orders/customer-label';
import { shopifyOrderLink } from '@/lib/orders/shopify-link';
import { firstName } from '@/lib/escalation/decide';
import { displayPhone } from '@/lib/import/phone';

/**
 * One shape for every list on every screen.
 *
 * The screens do no arithmetic and take no decisions — they render what this
 * file worked out. That is what keeps "no screen shows raw data where the
 * system could have reached the conclusion itself" true as screens get added.
 */

export interface ShipmentRow extends DecidableShipment {
  shippingCode: string;
  /**
   * The code the parcel comes back under, once it is coming back.
   *
   * Null for the great majority of parcels, which never do. It is here rather
   * than looked up per screen because three places need it: the timeline marks
   * the return leg's events with it, the Returns tab matches a `DX` label to
   * its order with it, and the operator types it into Correos' own tracker.
   */
  returnCode: string | null;
  /** Whether Correos named it or we worked it out. See return-code.ts. */
  returnCodeSource: string | null;
  /** When Correos delivered the return back to US. */
  returnedAt: Date | null;
  orderNumber: string;
  storeName: string;
  phoneE164: string | null;
  phoneDisplay: string;
  phoneStatus: string;
  email: string | null;
  addressLine: string | null;
  officeAddress: string | null;
  officeHours: string | null;
  lastEventAt: Date | null;
  snoozeReason: string | null;
  /** Why the operator gave up, when they did. Null for older closures. */
  closeReason: string | null;
  closeNote: string;

  /* --- worked out, so a screen never has to --- */
  /**
   * The big number: days at the post office, or ↩ when it is coming back.
   *
   * It used to be days LEFT, counted down from a last day worked out from a
   * deposit window nobody had confirmed with Correos. Correos does not say
   * when a parcel goes back, so the number counts up from the day they said it
   * arrived — the one date they do give us.
   */
  countdown: string;
  countdownTone: Tone;
  /** "At the office since 20 Sep · 8 days" / "last update yesterday". */
  when: string;
  /** The full timestamp, for the title attribute. */
  exactWhen: string;
  valueText: string;
  action: NextAction | null;
  /** The sentence under the row. */
  why: string;
  /** "Top of the list: 2 days left · €148.50, cash on delivery." */
  topReason: string;
  snoozed: boolean;
  /** Days at the post office, or null when it is not at one. */
  daysAtOffice: number | null;
  telHref: string;
  waHref: string;
  mapsHref: string;
  /** The finished Spanish message, ready to copy. */
  messageText: string;
  /** A `mailto:` with the same text, when the order has an email. */
  emailHref: string;
  /**
   * The order in the Shopify admin, or '' when it cannot be built — no shop
   * domain, or an order that did not come from Shopify. Never a guess: see
   * lib/orders/shopify-link.ts.
   */
  shopifyHref: string;
  lastContactLine: string;
}

export const loadRows = retryableRead('parcel rows', loadRowsQuery);

async function loadRowsQuery(opts: { at?: Date } = {}): Promise<ShipmentRow[]> {
  const at = opts.at ?? now();

  const rows = await getDb().select({
    id: shipments.id,
    state: shipments.state,
    shippingCode: shipments.shippingCode,
    returnCode: shipments.returnCode,
    returnCodeSource: shipments.returnCodeSource,
    returnedAt: shipments.returnedAt,
    officeArrivedAt: shipments.officeArrivedAt,
    lastEventAt: shipments.lastEventAt,
    mutedUntil: shipments.mutedUntil,
    snoozeReason: shipments.snoozeReason,
    droppedAt: shipments.droppedAt,
    closeReason: shipments.closeReason,
    closeNote: shipments.closeNote,
    restockedAt: shipments.restockedAt,
    redirectPending: shipments.redirectPending,
    orderNumber: orders.orderNumber,
    customerName: orders.customerName,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    phoneE164: orders.phoneE164,
    phoneStatus: orders.phoneStatus,
    email: orders.email,
    addressLine: orders.addressLine,
    city: orders.city,
    postalCode: orders.postalCode,
    storeName: stores.name,
    storePlatform: stores.platform,
    shopDomain: stores.shopDomain,
    externalOrderId: orders.externalOrderId,
    officeName: offices.name,
    officeAddress: offices.address,
    officeHours: offices.openingHours,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .leftJoin(offices, eq(offices.id, shipments.officeId));

  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const [taskRows, lastContacts] = await Promise.all([
    getDb().select().from(tasks).where(and(inArray(tasks.shipmentId, ids), eq(tasks.status, 'open'))),
    lastContactByShipment(ids),
  ]);

  const tasksBy = new Map<string, OpenTask[]>();
  for (const t of taskRows) {
    const list = tasksBy.get(t.shipmentId) ?? [];
    list.push({ type: t.type, reason: t.reason, label: t.label });
    tasksBy.set(t.shipmentId, list);
  }

  return rows.map((r) => {
    const last = lastContacts.get(r.id) ?? null;
    const base: DecidableShipment = {
      id: r.id,
      state: r.state as ShipmentState,
      officeArrivedAt: r.officeArrivedAt,
      officeName: r.officeName,
      // The DECISION needs this, not only the row: the reason line for a
      // parcel that is back says the day it landed, and `nextAction` is
      // handed this literal rather than the row it is built from.
      returnedAt: r.returnedAt,
      town: r.city ?? '',
      // The label, so every screen and every alert says something useful about
      // a parcel with no customer name. See lib/orders/customer-label.ts.
      customerName: customerLabel({
        customerName: r.customerName,
        orderNumber: r.orderNumber,
        platform: r.storePlatform,
      }),
      valueCents: r.valueCents,
      paymentMethod: r.paymentMethod,
      dropped: r.droppedAt !== null,
      restocked: r.restockedAt !== null,
      redirectPending: r.redirectPending,
      mutedUntil: r.mutedUntil,
      openTasks: tasksBy.get(r.id) ?? [],
      lastContactOutcome: last?.outcome ?? null,
    };

    const action = nextAction(base, at);
    const days = r.state === 'at_office' ? daysAtOffice(r.officeArrivedAt, at) : null;
    const snoozed = isSnoozed(base, at);
    const coming = r.state === 'returning' || r.state === 'refused' || r.state === 'returned';

    /*
     * `realFirstName`, not `firstName`: the marketplace files carry no name,
     * so the column is empty and `officeDetails` writes "Hola," rather than
     * "Hola Unknown". And `viaMarketplace` drops "somos {store}", because the
     * text is pasted into Amazon's or TikTok's own chat, which already shows
     * the seller.
     */
    const viaMarketplace = isMarketplace(r.storePlatform);
    const messageText = officeDetails({
      firstName: realFirstName(r.customerName),
      viaMarketplace,
      storeName: r.storeName,
      orderNumber: r.orderNumber,
      shippingCode: r.shippingCode,
      officeName: r.officeName,
      officeAddress: r.officeAddress,
      // The office's real hours or nothing at all — never a hard-coded line.
      officeHours: r.officeHours,
      officeArrivedAt: r.officeArrivedAt,
      daysAtOffice: daysAtOffice(r.officeArrivedAt, at),
      actionUrl: null,
    });

    return {
      ...base,
      shippingCode: r.shippingCode,
      returnCode: r.returnCode,
      returnCodeSource: r.returnCodeSource,
      returnedAt: r.returnedAt,
      orderNumber: r.orderNumber,
      storeName: r.storeName,
      phoneE164: r.phoneE164,
      phoneDisplay: displayPhone(r.phoneE164),
      phoneStatus: r.phoneStatus,
      email: r.email,
      addressLine: [r.addressLine, r.postalCode, r.city].filter(Boolean).join(' · ') || null,
      officeAddress: r.officeAddress,
      officeHours: r.officeHours,
      lastEventAt: r.lastEventAt,
      snoozeReason: r.snoozeReason,
      closeReason: r.closeReason,
      closeNote: r.closeNote ?? '',

      countdown: coming ? '↩' : (days === null ? '–' : String(days)),
      countdownTone: tone(base.state, r.officeArrivedAt, at),
      // The fact, not a guess: the day Correos said it got there and how long
      // ago that was. There is deliberately no "goes back on" date anywhere.
      when: r.officeArrivedAt && r.state === 'at_office'
        ? `At the office since ${shortDate(r.officeArrivedAt)} · ${days} ${days === 1 ? 'day' : 'days'}`
        : (r.lastEventAt ? `last update ${human(r.lastEventAt, at)}` : ''),
      exactWhen: r.officeArrivedAt && r.state === 'at_office'
        ? exact(r.officeArrivedAt)
        : (r.lastEventAt ? exact(r.lastEventAt) : ''),
      valueText: money(r.valueCents),
      action,
      why: snoozed
        ? `Quiet until ${human(r.mutedUntil!, at)}`
        : (action ? action.why : 'Nothing to do'),
      topReason: reason(base, at),
      snoozed,
      daysAtOffice: days,
      telHref: r.phoneE164 ? telLink(r.phoneE164) : '',
      waHref: r.phoneE164 ? whatsappLink(r.phoneE164, messageText) : '',
      mapsHref: mapsLink(r.officeName, r.officeAddress),
      messageText,
      emailHref: r.email
        ? emailLink(r.email, officeEmailSubject(r.orderNumber), messageText)
        : '',
      shopifyHref: shopifyOrderLink(r.storePlatform, r.shopDomain, r.externalOrderId) ?? '',
      lastContactLine: last
        ? `Last time: ${last.outcome} ${human(last.at, at)}${last.note ? ` — "${last.note}"` : ''}`
        : 'Never contacted',
    } satisfies ShipmentRow;
  });
}

async function lastContactByShipment(ids: readonly string[]) {
  const rows = await getDb().select({
    shipmentId: contactLog.shipmentId,
    at: contactLog.at,
    outcome: contactLog.outcome,
    note: contactLog.note,
  })
    .from(contactLog)
    .where(inArray(contactLog.shipmentId, ids as string[]))
    .orderBy(desc(contactLog.at));

  const out = new Map<string, { at: Date; outcome: string; note: string }>();
  for (const r of rows) if (!out.has(r.shipmentId)) out.set(r.shipmentId, r);
  return out;
}

/* -------------------------------------------------------------------------- */

export interface TodayView {
  rows: ShipmentRow[];
  headline: string;
  digest: string[];
  focus: ShipmentRow | null;
  comingBack: ShipmentRow[];
  /**
   * The heading above "Mark as back in stock": the digest's split again, on
   * one line, because that strip is one row with one button over the whole
   * pile. Decided here rather than in the page, which used to filter and sum
   * cents in JSX against this file's own contract above.
   */
  restockLine: string;
  /**
   * The sentence under it. Separate from `restockLine` because it is the one
   * the page used to hard-code, and hard-coding it was the same mistake
   * `restockLine` had just been built to stop making.
   */
  restockNote: string;
  doneToday: number;
  totalToday: number;
  progressLabel: string;
  callCount: number;
}

/**
 * Every sentence the Today screen says about the pile coming back.
 *
 * All four in one place — the two digest lines, the heading over "Mark as
 * back in stock" and the sentence under it — because they describe the same
 * two halves and the screen showed what happens when they do not agree: the
 * heading said "18 parcels coming back (€720.00)" and the line under it said
 * "The ones already here can be done now" over a half holding nobody. That is
 * the steady state, not an edge case: the morning the operator presses the
 * button on the sixty-nine that have landed, `backWithUs` empties and stays
 * empty until the next return arrives, and from then on the screen sent them
 * to look for boxes on a shelf that holds none.
 *
 * Pure on purpose, and it takes the two halves rather than the rows: the
 * whole of this is strings and plurals, which is the part that was wrong
 * ("1 parcels coming back"), and it can be driven straight from a test
 * without a database.
 */
export function restockTexts(
  stillComing: readonly { valueCents: number }[],
  backWithUs: readonly { valueCents: number }[],
): { digest: string[]; line: string; note: string } {
  const sum = (rows: readonly { valueCents: number }[]) =>
    rows.reduce((a, s) => a + s.valueCents, 0);
  const parcels = (n: number) => `${n} ${n === 1 ? 'parcel' : 'parcels'}`;
  const still = stillComing.length;
  const here = backWithUs.length;

  const digest: string[] = [];
  if (still) {
    digest.push(`${parcels(still)} coming back — ${money(sum(stillComing))}`
      + ` to put back in stock when ${still === 1 ? 'it lands' : 'they land'}.`);
  }
  if (here) {
    digest.push(`${parcels(here)} back with us — ${money(sum(backWithUs))}`
      + ' to put back in stock now.');
  }

  const line = [
    still ? `${parcels(still)} coming back (${money(sum(stillComing))})` : '',
    here ? `${parcels(here)} back with us (${money(sum(backWithUs))})` : '',
  ].filter(Boolean).join(' · ');

  /*
   * The job is the same for both halves — log the stock back in — and the
   * only question is which of them can be done this morning. So the note
   * names a half only when that half holds something.
   *
   * AND IT SAYS WHO SAYS SO. `returned` is Correos' handover scan on the DX
   * code and nothing else: the catch-up sets it without any warehouse scan,
   * and sixty-nine of the eighty-seven are in exactly that state. The
   * Returns tab lists those same rows under "Back with us per Correos, never
   * scanned in" and tells the operator somebody has to find the box. A note
   * here reading "they are all here now" contradicted it, on the screen the
   * operator starts the morning on. What is certain is that Correos have
   * handed them over; where the box is standing is not.
   */
  let note = '';
  if (still && here) {
    note = 'Same job for all of them: log them back into stock.'
      + ' The ones Correos has handed back can be done now.';
  } else if (here) {
    note = here === 1
      ? 'Log it back into stock: Correos has handed it back.'
      : 'Same job for all of them: log them back into stock —'
        + ' Correos has handed all of these back.';
  } else if (still) {
    note = still === 1
      ? 'Log it back into stock when it lands.'
      : 'Same job for all of them: log them back into stock as they land.';
  }

  return { digest, line, note };
}

/** Everything the Today screen needs, already decided. */
export async function todayView(focusIndex = 0, at: Date = now()): Promise<TodayView> {
  const all = await loadRows({ at });
  const act = actionable(all, at);
  const calls = callQueue(all, at);
  const comingBack = all.filter((r) =>
    (r.state === 'returning' || r.state === 'refused' || r.state === 'returned')
    && !r.restocked && !r.dropped);

  /*
   * ONE PILE, TWO PLACES, SO TWO LINES.
   *
   * Until the return leg landed, nothing in this database had ever reached
   * `returned`, so one sentence covered the whole pile and "coming back" was
   * true of all of it. It is not true of the sixty-nine the catch-up is about:
   * Correos delivered their return code back to our door, the box is on a
   * shelf in the building, and telling the operator it is "coming back" sends
   * them to wait for a parcel they could go and fetch.
   *
   * The JOB is the same for both halves — log the stock back in, which is why
   * they share `comingBack`, the Mark-as-back-in-stock button and the to-do
   * count — and the DAY is not, which is why the counts and the two money
   * figures are separate. One total over both answers neither "what can I put
   * away this morning" nor "what is still out there".
   *
   * Split on `!== 'returned'` rather than by naming the other two states, so
   * the halves stay exhaustive of `comingBack` however that filter changes.
   *
   * And on the STATE, not on `returnedAt`: a `returned` row reached by a hand
   * correction has no date, and that parcel must not fall quietly into
   * "coming back". `state` is what the projection writes.
   */
  const stillComing = comingBack.filter((r) => r.state !== 'returned');
  const backWithUs = comingBack.filter((r) => r.state === 'returned');
  const restock = restockTexts(stillComing, backWithUs);

  const doneToday = await countDoneToday(at);

  const digest: string[] = [];
  if (calls.length) {
    const names = calls.slice(0, 3).map((s) =>
      `${firstName(s.customerName)} (${s.daysAtOffice !== null ? `${s.daysAtOffice} days at the office, ` : ''}`
      + `${s.valueText}${s.paymentMethod === 'cod' ? ' cash on delivery' : ''})`).join(', ');
    digest.push(
      `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}: ${names}`
      + (calls.length > 3 ? ` and ${calls.length - 3} more` : ''),
    );
  }
  digest.push(...restock.digest);
  const other = act.length - calls.length - comingBack.length;
  if (other > 0) digest.push(`${other} other thing${other === 1 ? '' : 's'} need${other === 1 ? 's' : ''} you.`);
  if (!act.length) digest.push('Nothing else needs you.');

  const totalToday = doneToday + act.length;

  return {
    rows: act,
    headline: act.length
      ? `${calls.length ? `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}` : 'No calls'}`
        + ` and ${Math.max(0, act.length - calls.length)} other thing`
        + `${act.length - calls.length === 1 ? '' : 's'} need you today.`
      : 'Nothing needs you today.',
    digest,
    focus: act.length ? act[focusIndex % act.length] : null,
    comingBack,
    restockLine: restock.line,
    restockNote: restock.note,
    doneToday,
    totalToday,
    progressLabel: totalToday ? `${doneToday} of ${totalToday} done today` : 'nothing owed today',
    callCount: calls.length,
  };
}

/** Tasks closed since midnight in Madrid. The progress bar's numerator. */
async function countDoneToday(at: Date): Promise<number> {
  const { madridMidnightUtc, madridParts } = await import('@/lib/time');
  const p = madridParts(at);
  const midnight = madridMidnightUtc(p.year, p.month, p.day);
  // gte() rather than a raw fragment: drizzle then knows the column's type and
  // hands the driver a timestamp, instead of a bare Date it cannot serialise.
  const [row] = await getDb().select({ n: raw<number>`count(*)::int` }).from(tasks)
    .where(and(eq(tasks.status, 'done'), gte(tasks.closedAt, midnight)));
  return row?.n ?? 0;
}

export async function officeView(at: Date = now()): Promise<ShipmentRow[]> {
  const all = await loadRows({ at });
  return all
    .filter((r) => r.state === 'at_office' && !r.dropped)
    // Longest at the office first. That used to be "fewest days left", which
    // is the same ordering read off a guessed deadline; this one is read off
    // the day Correos said the parcel arrived.
    .sort((a, b) => (b.daysAtOffice ?? -1) - (a.daysAtOffice ?? -1));
}

export async function callsView(at: Date = now()): Promise<ShipmentRow[]> {
  return callQueue(await loadRows({ at }), at);
}

export { actionable, callQueue, priority, money, firstName };
