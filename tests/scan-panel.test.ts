import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { orders, shipments, tasks } from '@/db/schema';
import { parcelsView, parcelsExport } from '@/lib/views/parcels';
import { parcelScans } from '@/lib/views/scans';
import { returnsView, returnsCount } from '@/lib/views/returns';
import { TestClock, resetClock } from '@/lib/clock';
import { resetDb, closeDb } from './helpers/db';
import { makeScan, makeShipment, makeUser } from './helpers/fixtures';

/**
 * What a scan changes in Return Shield, and what it carefully does not.
 *
 * THE OUTGOING BADGE IS THE POINT OF THE WHOLE FEATURE. A parcel Correos still
 * calls "Pre-admisión" four days after the label was printed is one of two
 * completely different problems — with Correos and unscanned by them, or on a
 * shelf here and never posted — and they want opposite actions. The badge and
 * the filter beside it are what tell them apart.
 *
 * THE INCOMING BADGE CHANGES NOTHING ELSE, deliberately. A warehouse opening a
 * box is not Correos reporting a return, so the parcel's state, its escalation
 * and its tasks all carry on exactly as they were.
 */

const CODE = 'PKA6TP980010152E';
const BULTO = 'PKA6TP9800101520108320G';

let clock: InstanceType<typeof TestClock>;
let worker = '';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-16T10:00:00+02:00');
  clock.install();
  worker = (await makeUser({ role: 'scanner', name: 'María' })).id;
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

describe('the outgoing badge', () => {
  it('appears on the parcel page and on the row, with the time and the worker', async () => {
    const parcel = await makeShipment({ shippingCode: CODE, orderNumber: '#22709' });
    await makeScan({ code: BULTO, userId: worker, direction: 'outgoing', at: clock.now() });

    const marks = await parcelScans(parcel.shipmentId);
    expect(marks.left?.label).toBe('Left the warehouse');
    expect(marks.left?.worker).toBe('María');
    expect(marks.left?.when).toContain('16 Oct');
    expect(marks.back).toBeNull();

    const view = await parcelsView({ status: 'created', at: clock.now() });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].left?.label).toBe('Left the warehouse');
    expect(view.rows[0].back).toBeNull();
  });

  it('shows the latest scan when a parcel was scanned out twice', async () => {
    const parcel = await makeShipment({ shippingCode: CODE });
    const first = clock.now();
    await makeScan({ code: BULTO, userId: worker, at: first });

    const later = (await makeUser({ role: 'scanner', name: 'Jon' })).id;
    clock.advanceHours(3);
    await makeScan({ code: BULTO, userId: later, at: clock.now() });

    // The parcel left the warehouse at the second attempt; the first is of no
    // interest to anybody.
    expect((await parcelScans(parcel.shipmentId)).left?.worker).toBe('Jon');
  });

  it('is not put on the other box of a multi-parcel shipment', async () => {
    // Scanning parcel 01 says nothing about parcel 02.
    const one = await makeShipment({ shippingCode: 'PKA6TP9800101520108320G', storeKey: 'shop-a' });
    const two = await makeShipment({ shippingCode: 'PKA6TP9800101520208320H', storeKey: 'shop-a' });

    await makeScan({ code: 'PKA6TP9800101520108320G', userId: worker, at: clock.now() });

    expect((await parcelScans(one.shipmentId)).left).not.toBeNull();
    expect((await parcelScans(two.shipmentId)).left).toBeNull();
  });

  it('appears on a parcel uploaded after it was scanned', async () => {
    // Match when reading, not when scanning. The scan is two days older than
    // the parcel row it belongs to.
    await makeScan({ code: BULTO, userId: worker, at: clock.now() });
    clock.advanceDays(2);
    const parcel = await makeShipment({ shippingCode: CODE });

    expect((await parcelScans(parcel.shipmentId)).left?.label).toBe('Left the warehouse');
  });
});

describe('the pre-admission filter', () => {
  beforeEach(async () => {
    await makeShipment({ shippingCode: 'PKA6TP980010001E', storeKey: 'shop-a', orderNumber: '#1' });
    await makeShipment({ shippingCode: 'PKA6TP980010002E', storeKey: 'shop-a', orderNumber: '#2' });
    await makeShipment({ shippingCode: 'PKA6TP980010003E', storeKey: 'shop-a', orderNumber: '#3' });

    await makeScan({ code: 'PKA6TP980010001E', userId: worker, at: clock.now() });
    await makeScan({ code: 'PKA6TP980010002E', userId: worker, at: clock.now() });
  });

  it('counts both sides, and the counts equal the rows', async () => {
    const all = await parcelsView({ status: 'created', at: clock.now() });
    expect(all.scan).toEqual({ current: null, out: 2, not: 1 });

    const out = await parcelsView({ status: 'created', scanned: 'out', at: clock.now() });
    expect(out.rows).toHaveLength(out.scan?.out ?? -1);
    expect(out.rows.every((r) => r.left !== null)).toBe(true);

    const not = await parcelsView({ status: 'created', scanned: 'not', at: clock.now() });
    expect(not.rows).toHaveLength(not.scan?.not ?? -1);
    expect(not.rows.every((r) => r.left === null)).toBe(true);
    expect(not.rows[0].orderNumber).toBe('#3');
  });

  it('keeps both counts whichever side is selected', async () => {
    // They are the labels on the two buttons. Counting them through their own
    // filter would make one the total and the other zero, for ever.
    const out = await parcelsView({ status: 'created', scanned: 'out', at: clock.now() });
    expect(out.scan).toEqual({ current: 'out', out: 2, not: 1 });
  });

  it('narrows the tab counts, the way the search and the shop do', async () => {
    const out = await parcelsView({ status: 'created', scanned: 'out', at: clock.now() });
    expect(out.tabs.find((t) => t.id === 'created')?.count).toBe(2);
  });

  it('is not offered on a tab where it answers nothing', async () => {
    const delivered = await parcelsView({ status: 'delivered', at: clock.now() });
    expect(delivered.scan).toBeNull();
  });

  it('is ignored when it is typed onto a tab that does not offer it', async () => {
    // A hand-typed `?scanned=out` must not quietly hide rows behind a control
    // that is not on the screen.
    const all = await parcelsView({ status: 'all_open', scanned: 'out', at: clock.now() });
    expect(all.rows).toHaveLength(3);
  });

  it('is followed by the export, so the file is the list that was on screen', async () => {
    const file = await parcelsExport({ status: 'created', scanned: 'not', at: clock.now() });
    expect(file.rows.map((r) => r.orderNumber)).toEqual(['#3']);
  });
});

describe('the incoming badge', () => {
  it('changes nothing else about the parcel', async () => {
    const parcel = await makeShipment({ shippingCode: CODE, state: 'returning' });

    const before = await getDb().select().from(shipments).where(eq(shipments.id, parcel.shipmentId));
    const tasksBefore = await getDb().select().from(tasks).where(eq(tasks.shipmentId, parcel.shipmentId));

    await makeScan({ code: BULTO, userId: worker, direction: 'incoming', at: clock.now() });

    const after = await getDb().select().from(shipments).where(eq(shipments.id, parcel.shipmentId));
    const tasksAfter = await getDb().select().from(tasks).where(eq(tasks.shipmentId, parcel.shipmentId));

    // The state, the escalation stage, the closure and the tasks: all exactly
    // as they were. Correos reports a return; a warehouse bench does not.
    expect(after[0]).toEqual(before[0]);
    expect(tasksAfter).toEqual(tasksBefore);

    const marks = await parcelScans(parcel.shipmentId);
    expect(marks.back?.label).toBe('Back in the warehouse');
    expect(marks.left).toBeNull();
  });
});

describe('the Returns tab', () => {
  it('puts each scan in the right section', async () => {
    await makeShipment({
      shippingCode: CODE, orderNumber: '#22709', storeName: 'Don Cabello Profesional',
      state: 'returning',
    });

    await makeScan({ code: BULTO, userId: worker, direction: 'incoming', at: clock.now() });
    await makeScan({
      code: 'PKA6TP980010999E', userId: worker, direction: 'incoming', at: clock.now(),
    });

    const view = await returnsView({ at: clock.now() });

    expect(view.mineTotal).toBe(1);
    expect(view.checkTotal).toBe(0);
    expect(view.theirsTotal).toBe(1);
    expect(view.mine[0].label).toEqual({ lead: '#22709', note: 'Don Cabello Profesional' });
    expect(view.mine[0].shipmentId).not.toBeNull();
    expect(view.theirs[0].base).toBe('PKA6TP980010999');
    // The sections add up to the number on the tab. They do so by
    // construction now — the count runs the same CTE — rather than by two
    // queries happening to agree.
    expect(view.mineTotal + view.checkTotal + view.theirsTotal)
      .toBe(await returnsCount(clock.now()));
  });

  /*
   * THE 20 AND 25 NOVEMBER PILES.
   *
   * Fifty-two parcels scanned in Incoming mode in thirty-eight minutes while
   * Correos had them out for delivery, and thirty more a few days later, every
   * one of them Pre-admisión. They read "Back in the warehouse" on a screen
   * the office trusts. They are still shown — a scan is a person saying they
   * held the box, and the system does not get to overrule that — but under a
   * heading that says what is doubtful about them, with the reason named.
   */
  it('questions a parcel Correos says is still on its way out', async () => {
    await makeShipment({ shippingCode: CODE, orderNumber: '#22709', state: 'out_for_delivery' });
    await makeScan({ code: BULTO, userId: worker, direction: 'incoming', at: clock.now() });

    const view = await returnsView({ at: clock.now() });

    expect(view.mineTotal).toBe(0);
    expect(view.checkTotal).toBe(1);
    expect(view.check[0].doubt).toBe('Correos says this parcel is out for delivery to the customer.');
    // And it carries what the button needs to move it.
    expect(view.check[0].batchId).toBeTruthy();
    expect(view.check[0].batchSize).toBe(1);
  });

  it('questions a Pre-admisión parcel too: it was never even posted', async () => {
    await makeShipment({ shippingCode: CODE, state: 'created' });
    await makeScan({ code: BULTO, userId: worker, direction: 'incoming', at: clock.now() });

    const view = await returnsView({ at: clock.now() });
    expect(view.checkTotal).toBe(1);
    expect(view.check[0].doubt).toBe('Correos says this parcel has not been handed to Correos yet.');
  });

  /*
   * And the states it must NOT question. A parcel whose delivery failed, or
   * that is sitting at a post office, may well be on its way back before
   * Correos says so — eighteen of the eighty-seven returns were still
   * travelling when the operator counted them. Scanning one in is EARLY, not
   * wrong, and a section that cried wolf about those would be ignored.
   */
  it.each(['failed', 'at_office', 'bad_address'] as const)(
    'does not question a parcel in %s: coming back early is not wrong',
    async (state) => {
      await makeShipment({ shippingCode: CODE, state });
      await makeScan({ code: BULTO, userId: worker, direction: 'incoming', at: clock.now() });

      const view = await returnsView({ at: clock.now() });
      expect(view.checkTotal).toBe(0);
      expect(view.mineTotal).toBe(1);
      expect(view.mine[0].doubt).toBeNull();
    },
  );

  /*
   * THE FIVE REAL RETURNS OF 27 OCTOBER, which were filed as strangers.
   *
   * A return travels under a code of Correos' own — same core, `DX` prefix —
   * and the fifteen characters this system matched on are PREFIX plus core, so
   * a DX label matched nothing at all. Now it names its parcel, and the label
   * itself is enough to put the row under "Back with us": Correos only ever
   * print that code for the journey home.
   */
  it('matches a DX return label to its parcel, with no Correos event at all', async () => {
    await makeShipment({
      shippingCode: 'PKA6TP9800129340147006H',
      orderNumber: '576982410859617218',
      storeName: 'TikTok Shop ES',
      platform: 'tiktok',
      // Deliberately a state that would otherwise be questioned: the label is
      // the stronger signal and has to win.
      state: 'out_for_delivery',
    });
    await makeScan({
      code: 'DXA6TP9800129340128012S', userId: worker, direction: 'incoming', at: clock.now(),
    });

    const view = await returnsView({ at: clock.now() });

    expect(view.checkTotal).toBe(0);
    expect(view.mineTotal).toBe(1);
    expect(view.mine[0].viaReturn).toBe(true);
    expect(view.mine[0].shipmentId).not.toBeNull();
    // The code as read, not its base: DXA6TP980012934 is useful to nobody.
    expect(view.mine[0].code).toBe('DXA6TP9800129340128012S');
  });

  it('counts one return when the same parcel was scanned on both of its labels', async () => {
    /*
     * The two labels have DIFFERENT fifteen-character bases —
     * PKA6TP980012934 and DXA6TP980012934 — so keying the list on the base
     * showed one return as two lines about one order.
     */
    await makeShipment({ shippingCode: 'PKA6TP9800129340147006H', state: 'returning' });
    await makeScan({
      code: 'PKA6TP9800129340147006H', userId: worker, direction: 'incoming', at: clock.now(),
    });
    clock.advanceHours(1);
    await makeScan({
      code: 'DXA6TP9800129340128012S', userId: worker, direction: 'incoming', at: clock.now(),
    });

    const view = await returnsView({ at: clock.now() });
    expect(view.mineTotal).toBe(1);
    expect(view.mineTotal + view.checkTotal + view.theirsTotal)
      .toBe(await returnsCount(clock.now()));
  });

  it('shows a parcel once when it was scanned in two batches', async () => {
    await makeShipment({ shippingCode: CODE, orderNumber: '#22709', state: 'returning' });
    await makeScan({ code: BULTO, userId: worker, direction: 'incoming', at: clock.now() });

    const second = (await makeUser({ role: 'scanner', name: 'Jon' })).id;
    clock.advanceHours(4);
    await makeScan({ code: BULTO, userId: second, direction: 'incoming', at: clock.now() });

    const view = await returnsView({ at: clock.now() });
    expect(view.mineTotal).toBe(1);
    // With its latest scan: the second worker, four hours later.
    expect(view.mine[0].back.worker).toBe('Jon');
  });

  it('shows when it left the warehouse, if the warehouse ever scanned it out', async () => {
    await makeShipment({ shippingCode: CODE, state: 'returning' });
    await makeScan({ code: BULTO, userId: worker, direction: 'outgoing', at: clock.now() });

    clock.advanceDays(9);
    await makeScan({ code: BULTO, userId: worker, direction: 'incoming', at: clock.now() });

    const view = await returnsView({ at: clock.now() });
    expect(view.mine[0].left?.label).toBe('Left the warehouse');
    expect(view.mine[0].left?.when).toContain('16 Oct');
    expect(view.mine[0].back.when).toContain('25 Oct');
  });

  it('keeps a matched return under "From Return Shield" after the parcel is gone', async () => {
    /*
     * Day 31. The rolling window takes the order and cascades through the
     * shipment, and the scan — which has no foreign key to either — stays for
     * its own ninety days. It must not jump sections: the order number was
     * copied onto it when it was scanned, for exactly this.
     */
    const parcel = await makeShipment({
      shippingCode: CODE, orderNumber: '#22709', storeName: 'Don Cabello Profesional',
      state: 'returning',
    });
    await makeScan({
      code: BULTO,
      userId: worker,
      direction: 'incoming',
      at: clock.now(),
      orderNumber: '#22709',
      storeName: 'Don Cabello Profesional',
    });

    await getDb().delete(orders).where(eq(orders.id, parcel.orderId));

    const view = await returnsView({ at: clock.now() });
    expect(view.mineTotal).toBe(1);
    expect(view.theirsTotal).toBe(0);
    expect(view.mine[0].label).toEqual({ lead: '#22709', note: 'Don Cabello Profesional' });
    expect(view.mine[0].parcelGone).toBe(true);
    // No parcel page to link to any more, and the screen says why.
    expect(view.mine[0].shipmentId).toBeNull();
    expect(view.mine[0].status).toBeNull();
  });

  it('finds one by the number on the label', async () => {
    await makeScan({ code: 'PKA6TP980010111E', userId: worker, direction: 'incoming', at: clock.now() });
    await makeScan({ code: 'PKA6TP980010222E', userId: worker, direction: 'incoming', at: clock.now() });

    const found = await returnsView({ q: '0222', at: clock.now() });
    expect(found.theirsTotal).toBe(1);
    expect(found.theirs[0].base).toBe('PKA6TP980010222');
  });

  it('leaves outgoing scans out of it entirely', async () => {
    await makeShipment({ shippingCode: CODE });
    await makeScan({ code: BULTO, userId: worker, direction: 'outgoing', at: clock.now() });

    const view = await returnsView({ at: clock.now() });
    expect(view.mineTotal + view.checkTotal + view.theirsTotal).toBe(0);
    expect(view.awaitedTotal).toBe(0);
  });

  /*
   * THE SIXTY-NINE NOBODY COULD SEE.
   *
   * Correos delivered the return to our door and the warehouse never scanned
   * it in. This screen was built entirely out of scans, so there was nothing
   * to show — a parcel could be back in the building for a month with no row
   * anywhere saying so. It is read from the parcel instead.
   */
  it('lists a parcel Correos brought back that nobody scanned in', async () => {
    await makeShipment({
      shippingCode: 'PKA6TP9800129340147006H',
      orderNumber: '576982410859617218',
      state: 'returned',
      returnCode: 'DXA6TP9800129340128012S',
      returnCodeSource: 'correos',
      returnedAt: clock.now(),
    });

    const view = await returnsView({ at: clock.now() });

    expect(view.awaitedTotal).toBe(1);
    expect(view.awaited[0].returnCode).toBe('DXA6TP9800129340128012S');
    expect(view.awaited[0].returnCodeSource).toBe('correos');
    expect(view.awaited[0].orderNumber).toBe('576982410859617218');
    // And no scan-built section claims it, because there is no scan.
    expect(view.mineTotal + view.checkTotal + view.theirsTotal).toBe(0);
  });

  it('drops it off that list the moment either label is scanned in', async () => {
    await makeShipment({
      shippingCode: 'PKA6TP9800129340147006H',
      state: 'returned',
      returnCode: 'DXA6TP9800129340128012S',
      returnCodeSource: 'correos',
      returnedAt: clock.now(),
    });
    await makeScan({
      code: 'DXA6TP9800129340128012S', userId: worker, direction: 'incoming', at: clock.now(),
    });

    const view = await returnsView({ at: clock.now() });
    expect(view.awaitedTotal).toBe(0);
    expect(view.mineTotal).toBe(1);
  });
});
