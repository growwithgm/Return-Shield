import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { scanBatches, scans } from '@/db/schema';
import { readFileSync } from 'node:fs';
import { parseCorreosCode } from '@/lib/scan/codes';
import {
  DOUBT_RUN, NO_DOUBT_RUN, afterRead, doubtFromCode, doubtFromParcel,
  phoneSettlesEveryRead, type DirectionDoubt,
} from '@/lib/scan/direction';
import type { ScanDirection } from '@/lib/scan/model';
import {
  addScan, moveBatchDirection, moveScanDirection, openBatch, switchBatchDirection,
} from '@/lib/scan/batches';
import { matchForCode } from '@/lib/scan/match';
import { TestClock, resetClock } from '@/lib/clock';
import { resetDb, closeDb } from './helpers/db';
import { makeScan, makeShipment, makeUser } from './helpers/fixtures';

/**
 * Which way the pile was going.
 *
 * TWO MISTAKES, BOTH ALREADY MADE, and they point in opposite directions.
 *
 * On 20 November the warehouse scanned fifty-two parcels in Incoming mode in
 * thirty-eight minutes while Correos had them out for delivery, on the way or
 * delivered. On the 25th it happened again with thirty more, every one of them
 * Pre-admisión. Both were OUTGOING piles, and one of their parcels — Paquita's
 * — then read "Back in the warehouse · 20 Nov · 13:16" on a screen the office
 * trusts, while Correos were still driving it to her.
 *
 * Meanwhile the five real returns of 27 October, the only `DX` labels in the
 * table, were filed under "Not in Return Shield": a return travels under a
 * code of Correos' own and nothing here knew what one was.
 *
 * NOTHING HERE EVER REFUSES A SCAN. "Beep means it is saved" is the contract
 * the warehouse works to, and a refusal would have the phone drop the read and
 * tell the worker to write the number down — losing a parcel to avoid a wrong
 * label on a screen.
 */

const OUT = 'PKA6TP9800129340147006H';
const BACK = 'DXA6TP9800129340128012S';

let clock: InstanceType<typeof TestClock>;
let worker = '';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-11-20T13:16:00+01:00');
  clock.install();
  worker = (await makeUser({ role: 'scanner', name: 'Naeem' })).id;
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

describe('the verdict the phone can reach on its own', () => {
  it('knows a return label in an Outgoing batch, with no lookup at all', () => {
    const verdict = doubtFromCode(parseCorreosCode(BACK)!, 'outgoing');

    expect(verdict?.doubt).toBe('return-in-outgoing');
    expect(verdict?.shouldBe).toBe('incoming');
    /*
     * NOT `toContain('return label')`, which is what this asked for until the
     * banner had a title of its own. The title names the return label now and
     * the message carries the consequence, so asking for the label here is
     * asking for the stutter back — see `what the wrong-way banner says`,
     * which holds the two lines together and forbids any overlap.
     */
    expect(verdict?.message).toMatch(/came back/i);
    expect(verdict?.message).not.toMatch(/return label/i);
  });

  it('says nothing about a return label scanned the right way round', () => {
    expect(doubtFromCode(parseCorreosCode(BACK)!, 'incoming')).toBeNull();
  });

  it('says nothing about an ordinary label in either mode', () => {
    /*
     * ON PURPOSE. Scanning an ordinary label IN is perfectly normal — a
     * customer can bring a box back by hand, and half the Returns tab is
     * parcels this system has never heard of. Warning on every incoming scan
     * would be crying wolf, and a warning nobody believes is worse than none.
     */
    expect(doubtFromCode(parseCorreosCode(OUT)!, 'incoming')).toBeNull();
    expect(doubtFromCode(parseCorreosCode(OUT)!, 'outgoing')).toBeNull();
  });
});

describe('the verdict that needs the parcel', () => {
  it.each([
    ['created', 'has not been handed to Correos yet'],
    ['in_transit', 'is on the way to the customer'],
    ['out_for_delivery', 'is out for delivery to the customer'],
    ['delivered', 'was delivered to the customer'],
  ] as const)('questions an incoming scan of a parcel Correos says %s', (state, says) => {
    const verdict = doubtFromParcel(parseCorreosCode(OUT)!, 'incoming', { state });

    expect(verdict?.doubt).toBe('outbound-in-incoming');
    expect(verdict?.shouldBe).toBe('outgoing');
    expect(verdict?.message).toContain(says);
  });

  it.each(['failed', 'at_office', 'bad_address', 'returning', 'returned', 'refused'] as const)(
    'does not question a parcel in %s: arriving early is not arriving wrongly',
    (state) => {
      expect(doubtFromParcel(parseCorreosCode(OUT)!, 'incoming', { state })).toBeNull();
    },
  );

  it('does not question a code it has never heard of', () => {
    // Half the Returns tab is these. They are not a mistake.
    expect(doubtFromParcel(parseCorreosCode(OUT)!, 'incoming', null)).toBeNull();
  });

  it('agrees with the phone about the one case the phone decides', () => {
    // The two must never disagree, or a scan carries two verdicts and the
    // phone has to choose between them.
    const fromCode = doubtFromCode(parseCorreosCode(BACK)!, 'outgoing');
    const fromParcel = doubtFromParcel(parseCorreosCode(BACK)!, 'outgoing', { state: 'returned' });
    expect(fromParcel).toEqual(fromCode);
  });

  it('offers the whole-batch switch after three, because three is a pile', () => {
    // One is a parcel. The wrong-mode batches were 52 and 30 labels long, so a
    // worker told after three has twenty-seven left to save.
    expect(DOUBT_RUN).toBe(3);
  });
});

describe('what a scan does with the verdict', () => {
  it('stores the scan and reports the doubt, never refusing it', async () => {
    await makeShipment({ shippingCode: OUT, state: 'out_for_delivery' });
    const batch = await openBatch(worker, 'incoming');

    const answer = await addScan(worker, {
      batchId: batch.id, readId: 'r1', code: OUT, source: 'barcode',
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    // SAVED. This is the line that matters most in the file.
    expect(answer.item.codeAsRead).toBe(OUT);
    expect(answer.counted).toBe(true);
    expect(answer.doubt?.doubt).toBe('outbound-in-incoming');
  });

  it('says nothing about a DX label scanned into an Incoming batch', async () => {
    await makeShipment({ shippingCode: OUT, state: 'returning' });
    const batch = await openBatch(worker, 'incoming');

    const answer = await addScan(worker, {
      batchId: batch.id, readId: 'r1', code: BACK, source: 'barcode',
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.doubt).toBeUndefined();
    // And it found the parcel, through the leg-independent core.
    expect(answer.item.label).not.toBeNull();
  });

  it('matches a DX label to its parcel through the part the two legs share', async () => {
    const parcel = await makeShipment({ shippingCode: OUT, state: 'returning' });

    const answer = await matchForCode(parseCorreosCode(BACK)!);
    expect(answer.match?.shipmentId).toBe(parcel.shipmentId);
    expect(answer.match?.viaReturn).toBe(true);
    expect(answer.sharing).toBe(1);
  });

  it('matches a 16-character DX EXPEDICIÓN on the core alone', async () => {
    /*
     * An expedición carries no parcel number, so only the 13-character core is
     * available — and its own check letter is computed some other way, which
     * is why it must be cut off rather than compared.
     */
    const parcel = await makeShipment({ shippingCode: OUT, state: 'returning' });

    const answer = await matchForCode(parseCorreosCode('DXA6TP980012934A')!);
    expect(answer.match?.shipmentId).toBe(parcel.shipmentId);
    expect(answer.match?.viaReturn).toBe(true);
  });
});

describe('moving a pile that went the wrong way', () => {
  it('moves one scan, and says so on the row', async () => {
    await makeShipment({ shippingCode: OUT, state: 'out_for_delivery' });
    const scan = await makeScan({
      code: OUT, userId: worker, direction: 'incoming', at: clock.now(),
    });

    expect(await moveScanDirection([scan.id], 'outgoing')).toBe(1);

    const [row] = await getDb().select().from(scans).where(eq(scans.id, scan.id));
    expect(row.direction).toBe('outgoing');
    // Stamped, so "it was in the warehouse on the 20th" and "it never was" can
    // be told apart afterwards.
    expect(row.directionChangedAt).not.toBeNull();
    // The scan stays in the batch it was taken in: Naeem worked that pile.
    expect(row.batchId).toBe(scan.batchId);

    // Safe to press twice.
    expect(await moveScanDirection([scan.id], 'outgoing')).toBe(0);
  });

  it('moves a whole batch, which is what the 20 November pile needs', async () => {
    const first = await makeScan({
      code: OUT, userId: worker, direction: 'incoming', at: clock.now(),
    });
    for (const code of ['PKA6TP9800108200128822S', 'PKA6TP9800120280111130R']) {
      await makeScan({
        code, userId: worker, direction: 'incoming', at: clock.now(), batchId: first.batchId,
      });
    }

    expect(await moveBatchDirection(first.batchId, 'outgoing')).toBe(3);
    expect(await moveBatchDirection(first.batchId, 'outgoing')).toBe(0);
  });

  it('switches an open batch mid-pile, scans and all', async () => {
    const batch = await openBatch(worker, 'incoming');
    await makeScan({
      code: OUT, userId: worker, direction: 'incoming', at: clock.now(), batchId: batch.id,
    });

    const result = await switchBatchDirection(worker, batch.id, 'outgoing');
    expect(result).toEqual({ moved: 1, batchFinished: false });

    const [row] = await getDb().select().from(scanBatches).where(eq(scanBatches.id, batch.id));
    expect(row.direction).toBe('outgoing');
  });

  it('finishes the batch instead when the worker already has one open that way', async () => {
    /*
     * `scan_batches_open_idx` allows one open batch per worker per direction,
     * so a relabel would violate it. The scans still move — the pile is filed
     * correctly either way — and this batch is finished where it stands; the
     * phone opens a fresh one on its next read.
     */
    const incoming = await openBatch(worker, 'incoming');
    await openBatch(worker, 'outgoing');
    await makeScan({
      code: OUT, userId: worker, direction: 'incoming', at: clock.now(), batchId: incoming.id,
    });

    const result = await switchBatchDirection(worker, incoming.id, 'outgoing');
    expect(result).toEqual({ moved: 1, batchFinished: true });

    const [row] = await getDb().select().from(scanBatches)
      .where(eq(scanBatches.id, incoming.id));
    expect(row.direction).toBe('incoming');
    expect(row.finishedAt).not.toBeNull();
  });

  it('will not touch a batch that is not this worker’s', async () => {
    const other = (await makeUser({ role: 'scanner', name: 'Jon' })).id;
    const batch = await openBatch(other, 'incoming');

    expect(await switchBatchDirection(worker, batch.id, 'outgoing')).toBeNull();
  });
});

/**
 * How many in a row, and how many beeps.
 *
 * The banner prints "That is 3 in a row. This looks like a whole pile in the
 * wrong mode." next to a button that moves the whole batch, so the number is
 * not decoration: it is the reason the worker presses it. It has to be the
 * number of PARCELS they have read.
 *
 * The screen counted verdicts instead, and a DX label in an Outgoing batch
 * raises two of them — the phone's, from the code, before the read is sent,
 * and the server's, which agrees on purpose (see the test above). So two DX
 * labels announced three in a row, and the one thing the phone is CERTAIN
 * about was the one thing it could not count. Nobody saw it while the
 * banner's title was keyed off a field nothing set.
 *
 * The beep is the other half. The phone beeps when a run STARTS, and the
 * second verdict for the same box must not beep again: a worker who hears two
 * beeps for one parcel learns to ignore the sound, and the sound is the only
 * thing that reaches them while the parcel is still in their hand.
 *
 * `shift` below drives the rule the way ScannerApp does — `take` first, then
 * `flush` when the read comes back — because that interleaving is where the
 * double count lived, not in either half on its own.
 */
/**
 * The two sentences the banner shows, together.
 *
 * They are written in two files — the title in the screen, the body in the
 * verdict — and until the title rendered at all nobody read them one after
 * the other. They said the same thing: "This is a return label", then "This
 * is a return label — the parcel came back to us." The pair is the unit, so
 * this test holds both ends of it.
 */
describe('what the wrong-way banner says', () => {
  const SCREEN = readFileSync('components/scan/ScannerApp.tsx', 'utf8');

  function titleFor(kind: DirectionDoubt): string {
    // The screen picks the title from the verdict's kind. Read both arms out
    // of the file rather than copying them, so a reworded title is caught
    // here instead of going quietly out of step with the body.
    const arms = SCREEN.match(
      /doubt\.kind === 'return-in-outgoing'\s*\n\s*\? '([^']+)'\s*\n\s*: '([^']+)'/,
    );
    expect(arms, 'the banner still chooses its title by kind').not.toBeNull();
    return kind === 'return-in-outgoing' ? arms![1] : arms![2];
  }

  it('does not say the same thing twice', () => {
    for (const verdict of [
      doubtFromCode(parseCorreosCode(BACK)!, 'outgoing')!,
      doubtFromParcel(parseCorreosCode(OUT)!, 'incoming', { state: 'out_for_delivery' })!,
    ]) {
      const title = titleFor(verdict.doubt);
      expect(title.length).toBeGreaterThan(0);
      // Not "starts with": any overlap at all reads as a stutter when the two
      // lines sit three millimetres apart on a phone.
      expect(verdict.message.toLowerCase()).not.toContain(title.toLowerCase());
    }
  });

  it('names the return label in the title, where the worker reads it first', () => {
    // What the screen was always meant to say for a DX code, and could not.
    expect(titleFor('return-in-outgoing')).toBe('This is a return label');
  });

  it('never offers "It really went out" against a code that says it came back', () => {
    /*
     * The dismiss button only clears the banner — the scan stays filed in
     * this batch either way. Against the server's verdict, which is a guess
     * from the parcel's state, "It really went out" is a fair thing to offer:
     * the worker holding the box may know better than Correos. Against a DX
     * code it is not. There is nothing the worker can know that makes it
     * true, and a button that invites them to say it is how a parcel on the
     * shelf gets recorded as having left the building.
     */
    const dismiss = SCREEN.slice(SCREEN.indexOf("setDoubt(null); doubtRun.current = NO_DOUBT_RUN"));
    const arm = dismiss.match(/doubt\.kind === 'return-in-outgoing'\s*\n\s*\? '([^']+)'/);
    expect(arm, 'the dismiss button still chooses its words by kind').not.toBeNull();
    expect(arm![1]).not.toMatch(/went out|came back/i);
  });
});

describe('counting the parcels that look wrong', () => {
  const SCREEN = readFileSync('components/scan/ScannerApp.tsx', 'utf8');

  /*
   * FIRST, THAT THE SCREEN STILL WORKS THE WAY THE DRIVER BELOW PRETENDS IT
   * DOES. The driver is a hand-written copy of two paths through
   * ScannerApp.tsx, and a copy is worth nothing once the original moves. What
   * cannot move without breaking everything is the shape: each read is
   * counted in exactly one place, and that place asks whose job it is first.
   */
  it('advances the run in exactly two places, each asking whose job it is', () => {
    const sites = [...SCREEN.matchAll(/doubtRun\.current = afterRead\(/g)].map((m) => m.index!);
    expect(sites, 'one place per direction: the phone for Outgoing, the server for Incoming')
      .toHaveLength(2);

    const negated = sites.map((at) => {
      const before = SCREEN.slice(Math.max(0, at - 400), at);
      const asked = before.lastIndexOf('phoneSettlesEveryRead(direction)');
      expect(asked, 'every place that advances the run asks `phoneSettlesEveryRead` first')
        .toBeGreaterThan(-1);
      return before.charAt(asked - 1) === '!';
    });
    // One of the two guards is negated and one is not, so exactly one of the
    // passes owns any given read. Both negated, or neither, is the old bug.
    expect([...negated].sort()).toEqual([false, true]);
  });

  /**
   * A phone, driven read by read.
   *
   * `take` is what happens with the box in the worker's hand. `answer` is the
   * server's reply landing later, and it is a SEPARATE step on purpose: the
   * gap between them is where the double beep lived, and the driver this
   * replaced answered every read inside the same loop turn that took it, so
   * it could not express a run of three boxes with a good box's answer
   * arriving in the middle. It called that "the interleaving" and never built
   * one.
   */
  function phone(direction: ScanDirection) {
    let run = NO_DOUBT_RUN;
    const beeps: string[] = [];
    let banner: { code: string; run: number } | null = null;

    return {
      /** `take`: the phone settles what the code alone can settle. */
      take(code: string, returnLabel: boolean) {
        const instant = returnLabel && direction === 'outgoing';
        if (phoneSettlesEveryRead(direction)) run = afterRead(run, code, instant);
        if (instant) {
          beeps.push(`${code}:phone`);
          banner = { code, run: run.count };
        }
      },
      /** `flush`: the server's reply for one read, whenever it comes back. */
      answer(code: string, doubted: boolean) {
        if (phoneSettlesEveryRead(direction)) return;
        const before = run.count;
        run = afterRead(run, code, doubted);
        if (doubted) {
          banner = { code, run: run.count };
          if (before === 0 && run.count === 1) beeps.push(`${code}:server`);
        }
      },
      /** "Just this one parcel". */
      dismiss() { banner = null; run = NO_DOUBT_RUN; },
      get count() { return run.count; },
      get beeps() { return beeps; },
      /** Whether the banner is claiming a whole pile is in the wrong mode. */
      get pile() { return banner !== null && banner.run >= DOUBT_RUN; },
      get shown() { return banner; },
    };
  }

  const DX = 'DXA6TP9800129340128012S';
  const DX2 = 'DXA6TP9800129340128013T';
  const DX3 = 'DXA6TP9800129340128014U';

  it('counts one wrong box as one parcel, and beeps once', () => {
    const p = phone('outgoing');
    p.take(DX, true);
    expect(p.count).toBe(1);
    expect(p.beeps).toEqual([`${DX}:phone`]);
    expect(p.pile).toBe(false);
  });

  it('offers the whole-batch switch on the third parcel, not the second', () => {
    const p = phone('outgoing');
    p.take(DX, true);
    p.take(DX2, true);
    expect(p.pile).toBe(false);
    p.take(DX3, true);
    expect(p.count).toBe(DOUBT_RUN);
    expect(p.pile).toBe(true);
  });

  it('counts one box scanned three times as one parcel, not a pile', () => {
    /*
     * The banner says "do not scan it again", and a worker can still scan it
     * again — the duplicate beep is a feature of this screen, so re-reads are
     * expected. Counting reads instead of parcels offered to re-file a whole
     * batch of sixty because one box had been waved at the camera three times.
     */
    const p = phone('outgoing');
    p.take(DX, true);
    p.take(DX, true);
    p.take(DX, true);
    expect(p.count).toBe(1);
    expect(p.pile).toBe(false);
    // Three scans, three beeps: that half is right. Each scan is an action the
    // worker took, and an action with no answer is one they take again.
    expect(p.beeps).toHaveLength(3);
  });

  it('does not beep again, or lose its count, when a good box is answered mid-run', () => {
    /*
     * THE OFFLINE CASE, which is most of a warehouse morning. Four boxes are
     * scanned with no signal — an ordinary one, then three return labels — and
     * the whole queue is answered at once when the signal comes back. The
     * queue is oldest-first, so the ordinary box is answered FIRST, after all
     * three return labels have already been counted.
     *
     * That answer used to reset the run, so the next answer looked like a
     * fresh one: it beeped a second time for a box the worker had already been
     * warned about, and walked "that is 3 in a row" down to 1 and back up to 3
     * while the Switch button sat still underneath it.
     */
    const p = phone('outgoing');
    p.take('PKA6TP9800129340147006H', false);
    p.take(DX, true);
    p.take(DX2, true);
    p.take(DX3, true);
    expect(p.count).toBe(3);

    p.answer('PKA6TP9800129340147006H', false);
    p.answer(DX, true);
    p.answer(DX2, true);
    p.answer(DX3, true);

    expect(p.count).toBe(3);
    expect(p.pile).toBe(true);
    expect(p.beeps).toEqual([`${DX}:phone`, `${DX2}:phone`, `${DX3}:phone`]);
  });

  it('keeps a dismissed parcel dismissed when its own answer comes back', () => {
    // The worker said "just this one parcel". The answer for that same read is
    // still on its way, and it must not undo what they just said.
    const p = phone('outgoing');
    p.take(DX, true);
    p.dismiss();
    p.answer(DX, true);
    expect(p.shown).toBeNull();
    expect(p.count).toBe(0);
    expect(p.beeps).toEqual([`${DX}:phone`]);
  });

  it('starts again after a box that looked fine', () => {
    const p = phone('outgoing');
    p.take(DX, true);
    p.take(DX2, true);
    p.take('PKA6TP9800129340147006H', false);
    p.take(DX3, true);
    // Three scattered through sixty is not a pile.
    expect(p.count).toBe(1);
    expect(p.pile).toBe(false);
  });

  it('lets the server count the parcels the phone cannot see coming', () => {
    // The 20 and 25 November case: ordinary labels read IN, which the phone
    // has nothing to say about, and only the parcel's state contradicts.
    const p = phone('incoming');
    for (const code of ['one', 'two', 'three']) p.take(code, false);
    expect(p.count).toBe(0);
    for (const code of ['one', 'two', 'three']) p.answer(code, true);
    expect(p.count).toBe(3);
    expect(p.pile).toBe(true);
    // One beep for the run, not one per parcel: by the time these land the
    // box is out of the worker's hand and the banner is doing the talking.
    expect(p.beeps).toEqual(['one:server']);
  });

  it('does not beep again when the same wrong parcel is read in twice', () => {
    const p = phone('incoming');
    p.take('one', false);
    p.answer('one', true);
    p.take('one', false);
    p.answer('one', true);
    expect(p.count).toBe(1);
    expect(p.beeps).toEqual(['one:server']);
  });

  it('holds nothing before the first read', () => {
    expect(NO_DOUBT_RUN.count).toBe(0);
    expect(NO_DOUBT_RUN.parcels).toEqual([]);
    expect(afterRead(NO_DOUBT_RUN, 'a', false)).toEqual(NO_DOUBT_RUN);
  });

  it('knows which end settles a read, and says so in one place', () => {
    /*
     * The fact the whole arrangement rests on: in an Outgoing batch the server
     * agrees with the phone by construction (`doubtFromParcel` returns
     * `doubtFromCode` and then gives up unless the direction is `incoming`),
     * so the phone may count alone; in an Incoming batch the phone can reach
     * no verdict at all, so the server must.
     */
    expect(phoneSettlesEveryRead('outgoing')).toBe(true);
    expect(phoneSettlesEveryRead('incoming')).toBe(false);

    const dx = parseCorreosCode(DX)!;
    expect(doubtFromParcel(dx, 'outgoing', { state: 'delivered' }))
      .toEqual(doubtFromCode(dx, 'outgoing'));
    expect(doubtFromCode(parseCorreosCode(OUT)!, 'incoming')).toBeNull();
  });
});
