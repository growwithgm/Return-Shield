import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { scanBatches, scans } from '@/db/schema';
import { readFileSync } from 'node:fs';
import { parseCorreosCode } from '@/lib/scan/codes';
import {
  DOUBT_RUN, NO_DOUBT_RUN, afterRead, alreadyCounted, doubtFromCode, doubtFromParcel,
  type DirectionDoubt,
} from '@/lib/scan/direction';
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
    expect(verdict?.message).toContain('return label');
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

describe('counting the reads that look wrong', () => {
  type Read = {
    id: string;
    /** The phone settled it from the code: a DX label in an Outgoing batch. */
    instant: boolean;
    /** What the server said when the read came back, or nothing yet. */
    flush?: boolean;
  };

  function shift(reads: readonly Read[]): { count: number; beeps: string[] } {
    let run = NO_DOUBT_RUN;
    const beeps: string[] = [];
    for (const r of reads) {
      if (r.instant) {
        run = afterRead(run, r.id, true);
        beeps.push(`${r.id}:phone`);
      }
      if (r.flush !== undefined) {
        const beeped = alreadyCounted(run, r.id);
        run = afterRead(run, r.id, r.flush);
        if (r.flush && !beeped && run.count === 1) beeps.push(`${r.id}:server`);
      }
    }
    return { count: run.count, beeps };
  }

  /** A DX return label read into an Outgoing batch: both halves fire. */
  const DX = (id: string): Read => ({ id, instant: true, flush: true });
  /** An ordinary label the server doubts: only the server fires. */
  const FROM_SERVER = (id: string): Read => ({ id, instant: false, flush: true });
  /** A read the server was happy with. */
  const GOOD = (id: string): Read => ({ id, instant: false, flush: false });

  it('counts one DX label as one parcel, and beeps once', () => {
    expect(shift([DX('a')])).toEqual({ count: 1, beeps: ['a:phone'] });
  });

  it('counts two DX labels as two, not three', () => {
    // The whole bug, in one line.
    expect(shift([DX('a'), DX('b')]).count).toBe(2);
  });

  it('beeps once per parcel, never twice for one box', () => {
    expect(shift([DX('a'), DX('b')]).beeps).toEqual(['a:phone', 'b:phone']);
  });

  it('offers the whole-batch switch on the third parcel, not the second', () => {
    expect(shift([DX('a'), DX('b')]).count).toBeLessThan(DOUBT_RUN);
    expect(shift([DX('a'), DX('b'), DX('c')]).count).toBe(DOUBT_RUN);
  });

  it('counts a read that had to be sent twice once', () => {
    // A lost response: the phone counted it, then the queue resent the same
    // readId and the server answered the same verdict both times.
    const resent: Read[] = [
      { id: 'a', instant: true },
      { id: 'a', instant: false, flush: true },
      { id: 'a', instant: false, flush: true },
    ];
    expect(shift(resent)).toEqual({ count: 1, beeps: ['a:phone'] });
  });

  it('still counts one per read when only the server doubts it', () => {
    // The 20 and 25 November case, which the phone cannot see coming.
    expect(shift([FROM_SERVER('a'), FROM_SERVER('b'), FROM_SERVER('c')]).count).toBe(3);
    expect(shift([FROM_SERVER('a')]).beeps).toEqual(['a:server']);
  });

  it('starts again after a read the server was happy with', () => {
    expect(shift([DX('a'), GOOD('g')]).count).toBe(0);
    expect(shift([DX('a'), DX('b'), GOOD('g'), DX('c')]).count).toBe(1);
  });

  it('holds nothing before the first read', () => {
    expect(NO_DOUBT_RUN.count).toBe(0);
    expect(alreadyCounted(NO_DOUBT_RUN, 'a')).toBe(false);
    expect(afterRead(NO_DOUBT_RUN, 'a', false)).toEqual(NO_DOUBT_RUN);
  });
});
