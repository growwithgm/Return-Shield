'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseCorreosCode, type CorreosCode } from '@/lib/scan/codes';
import {
  DOUBT_RUN, doubtFromCode, type DirectionDoubt, type DirectionVerdict,
} from '@/lib/scan/direction';
import { summarise, type Batch, type ScanItem } from '@/lib/scan/items';
import { DIRECTION_LABEL, type ScanDirection, type ScanSource } from '@/lib/scan/model';
import { SCAN_BOX, useScanner } from './useScanner';
import { beepDuplicate, beepSaved, beepWrongWay, unlockAudio } from './feedback';
import { adoptBatch, countTry, forgetRead, pendingReads, queueRead, type Outgoing } from './outbox';
import { BatchList, madridTime, type DisplayRow, type RemoveTarget } from './BatchList';
import { TypeSheet } from './TypeSheet';
import { FinishSheet } from './FinishSheet';
import { BatchSaved } from './BatchSaved';
import {
  ChevronDown, IncomingIcon, KeypadIcon, OutgoingIcon, TickIcon, TorchIcon, WarnIcon,
} from './icons';

/**
 * The scanning screen: images 3 to 9.
 *
 * THE ORDER OF THE THREE THINGS A SCAN DOES IS THE WHOLE DESIGN.
 *
 *   1. write the read to IndexedDB
 *   2. beep
 *   3. send it, and keep sending it until the server says it has it
 *
 * In that order, because "beep means it is saved" has to be true in a warehouse
 * where the signal drops between the aisles. A beep that waited for the network
 * would be a beep that sometimes never comes, and a worker cannot stand holding
 * a parcel wondering whether to scan it again. A beep that came before the
 * write would be a beep that lies.
 *
 * The consequence is that this screen shows two kinds of row: the ones the
 * server has, with what they matched, and the ones still in the queue, marked
 * "Sending…". The second kind never has a match yet, and does not pretend to.
 *
 * ONE QUERY TO RESUME. The open batch comes from the server when the page is
 * opened, so a phone that ran out of battery mid-pile — or a different phone
 * entirely — picks the pile back up.
 */

/** How long the green or orange banner stays up. The next scan is already live. */
const FLASH_MS = 1_200;
/** How long the newest row keeps its "Just now" pill. */
const JUST_NOW_MS = 4_000;
/** How often the queue is retried while anything is waiting. */
const RETRY_MS = 3_000;

/*
 * A THIRD KIND OF BANNER, and it is not a flash.
 *
 * `saved` and `duplicate` live for 1.2 seconds, which is right for "carry on
 * scanning". A wrong-direction warning is something the worker has to ACT on —
 * switch the batch, or confirm the parcel really came back — so it stays until
 * they answer it. On 20 November fifty-two outgoing parcels went into an
 * Incoming batch in thirty-eight minutes, every one of them beeping "saved";
 * a warning that disappears before the next parcel is picked up would have
 * changed nothing.
 */
type Flash = { kind: 'saved' | 'duplicate' | 'wrong-way'; base: string; at: number };

/**
 * The open question: this pile may be going the other way.
 *
 * `kind` is `DirectionVerdict.doubt` under another name, and the rename is why
 * this is built field by field below rather than with a spread. A
 * `{ ...verdict, code, run }` typechecked — every field it needed was
 * somewhere in the object — and produced a banner whose `kind` was
 * `undefined`, so EVERY warning fell through to "Is this pile going the other
 * way?", including a DX label in an Outgoing batch, which is the one case the
 * phone can be certain about and the one that most needed its own words.
 *
 * Two types that differ by one field name must never be spread into each
 * other. `doubtVerdict` below is the only place the two meet.
 */
type Doubt = {
  kind: DirectionDoubt;
  message: string;
  shouldBe: ScanDirection;
  /** The code that raised it, so the worker can see which parcel. */
  code: string;
  /** How many in a row have looked like this. See DOUBT_RUN. */
  run: number;
};

/**
 * One verdict, as the banner needs it. Written out field by field on purpose —
 * see `Doubt`.
 */
function doubtVerdict(v: DirectionVerdict, code: string, run: number): Doubt {
  return { kind: v.doubt, message: v.message, shouldBe: v.shouldBe, code, run };
}

export function ScannerApp({
  direction,
  worker,
  initialBatch,
}: {
  direction: ScanDirection;
  worker: string;
  initialBatch: Batch | null;
}) {
  const [batchId, setBatchId] = useState<string | null>(initialBatch?.id ?? null);
  /*
   * Null until the server says when the batch started, rather than `new
   * Date()`.
   *
   * This component renders once on the server and again when the browser
   * hydrates it, and a clock read during render gives two different answers —
   * which React notices and redraws over. The batch's real start time arrives
   * with the POST that opens it, a moment later.
   */
  const [startedAt, setStartedAt] = useState<string | null>(initialBatch?.startedAt ?? null);
  const [items, setItems] = useState<ScanItem[]>(initialBatch?.items ?? []);
  const [queue, setQueue] = useState<Outgoing[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [sheet, setSheet] = useState<'none' | 'type' | 'finish'>('none');
  const [saved, setSaved] = useState<{ batch: Batch; summary: ReturnType<typeof summarise> } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  /**
   * The wrong-direction question, and the run that led to it.
   *
   * Sticky: cleared only when the worker answers it, or when the batch is
   * finished. `run` counts consecutive doubtful reads and is reset by any
   * read the server was happy with, so three in a row really is a pile and
   * not three parcels scattered through a good one.
   */
  const [doubt, setDoubt] = useState<Doubt | null>(null);
  const doubtRun = useRef(0);

  // Refs for the things the flush loop and the decode loop read. Both run
  // outside React's render, and both must see the latest value rather than the
  // one captured when they were created.
  const batchIdRef = useRef(batchId);
  useEffect(() => { batchIdRef.current = batchId; }, [batchId]);
  const flushing = useRef(false);

  const upsert = useCallback((item: ScanItem) => {
    setItems((prev) => {
      const rest = prev.filter((i) => i.id !== item.id && i.codeAsRead !== item.codeAsRead);
      return [item, ...rest].sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
    });
  }, []);

  /** Open (or resume) the batch this phone writes into. */
  const ensureBatch = useCallback(async (): Promise<string | null> => {
    if (batchIdRef.current) return batchIdRef.current;
    try {
      const res = await fetch('/api/scan/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      if (res.status === 401) { setSignedOut(true); return null; }
      if (!res.ok) return null;

      const body = await res.json() as { batch: Batch };
      batchIdRef.current = body.batch.id;
      setBatchId(body.batch.id);
      setStartedAt(body.batch.startedAt);
      body.batch.items.forEach(upsert);
      // Reads taken before the batch existed — the camera is quicker than the
      // round trip, and the beep did not wait for it.
      await adoptBatch(direction, body.batch.id);
      return body.batch.id;
    } catch {
      return null;
    }
  }, [direction, upsert]);

  /**
   * Send everything in the queue, oldest first.
   *
   * One at a time and in order, so a pile keeps the order it was worked in. It
   * stops at the first read it cannot send and leaves the rest for the next
   * pass: a phone that has lost its signal gains nothing by trying the other
   * forty, and the retry is three seconds away.
   */
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;

    try {
      const waiting = await pendingReads(direction);
      if (!waiting.length) return;

      const id = await ensureBatch();
      if (!id) return;

      for (const read of waiting) {
        const res = await fetch('/api/scan/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            batchId: id,
            readId: read.readId,
            code: read.code,
            source: read.source,
            at: read.at,
          }),
        }).catch(() => null);

        // No network. Everything is still queued; try again in a moment.
        if (!res) { await countTry(read); return; }

        if (res.status === 401) { setSignedOut(true); return; }

        if (res.status === 404) {
          // The batch id has gone — finished from somewhere else, or a stale
          // phone. Get a new one and let the next pass use it.
          batchIdRef.current = null;
          setBatchId(null);
          return;
        }

        if (res.status === 422) {
          /*
           * The server could not parse the code. Both ends use the same parser
           * (lib/scan/codes.ts), so this should not happen — and if it does,
           * retrying for ever would block every read behind it. Drop this one
           * and say so, loudly enough that the label gets looked at.
           */
          await forgetRead(read.readId);
          setProblem(`${read.code} could not be stored. Write the number down and tell the office.`);
          continue;
        }

        if (!res.ok) {
          await countTry(read);
          return;
        }

        const body = await res.json() as { item: ScanItem; doubt?: DirectionVerdict };
        upsert(body.item);
        await forgetRead(read.readId);

        /*
         * "Correos says this parcel is still on its way out."
         *
         * Only the server can reach this verdict — it needs the parcel's state,
         * which the phone does not have — so it arrives here rather than in
         * `take`, possibly a parcel or two later. That is why it is a sticky
         * banner naming its own code rather than a flash: by the time it gets
         * here the 1.2-second flash would be over, and flashing it now would
         * flash it over an unrelated parcel.
         */
        if (body.doubt) {
          doubtRun.current += 1;
          const run = doubtRun.current;
          setDoubt(doubtVerdict(body.doubt, body.item.codeAsRead, run));
          if (run === 1) beepWrongWay();
        } else {
          // A read the server was happy with breaks the run: three in a row is
          // a pile, three scattered through sixty is not.
          doubtRun.current = 0;
        }
      }
    } finally {
      flushing.current = false;
      setQueue(await pendingReads(direction));
    }
  }, [direction, ensureBatch, upsert]);

  /* ------------------------------------------------------------- the scan */

  /*
   * The decode loop and `take` both need the current lists, and neither may be
   * rebuilt when one changes: a new `onCode` would restart the camera, and a
   * camera that restarts between parcels is a camera nobody can scan with.
   */
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const queueRef = useRef(queue);
  useEffect(() => { queueRef.current = queue; }, [queue]);

  /**
   * One parcel read. Called by the camera loop and by the "Type the number"
   * sheet, and it does the same three things either way.
   */
  const take = useCallback(async (code: CorreosCode, source: ScanSource) => {
    const already = itemsRef.current.some((i) => i.codeAsRead === code.raw)
      || queueRef.current.some((q) => q.code === code.raw);

    const read: Outgoing = {
      readId: newReadId(),
      batchId: batchIdRef.current,
      direction,
      code: code.raw,
      source,
      at: new Date().toISOString(),
      tries: 0,
    };

    // 1. On the phone. 2. Then the beep. In that order, always.
    await queueRead(read);
    setQueue(await pendingReads(direction));

    /*
     * The one verdict the code alone settles, reached before the read has even
     * been sent: a DX return label in an Outgoing batch. That is the only
     * moment a warning can reach the worker while the parcel is still in their
     * hand, and it needs no lookup to be certain of.
     *
     * The other direction — an ordinary label in an Incoming batch — is NOT
     * decided here, on purpose. Scanning one is perfectly normal; what is not
     * is scanning in a parcel Correos still has out for delivery, and only the
     * server knows that. See lib/scan/direction.ts.
     */
    const instant = doubtFromCode(code, direction);

    if (instant) {
      beepWrongWay();
      setFlash({ kind: 'wrong-way', base: code.base, at: Date.now() });
      doubtRun.current += 1;
      setDoubt(doubtVerdict(instant, code.raw, doubtRun.current));
    } else if (already) {
      beepDuplicate();
      setFlash({ kind: 'duplicate', base: code.base, at: Date.now() });
    } else {
      beepSaved();
      setFlash({ kind: 'saved', base: code.base, at: Date.now() });
    }

    // 3. On its way. The queue owns the retrying.
    void flush();
  }, [direction, flush]);

  /**
   * "Switch this batch to Outgoing" — the whole pile, not just this parcel.
   *
   * Offered once three reads in a row have looked wrong, because one is a
   * parcel and three is a pile. The two wrong-mode batches were fifty-two and
   * thirty labels long, so a worker who is told after three has twenty-seven
   * left to save and the twenty-five already taken get fixed by the same press.
   */
  const switchBatch = useCallback(async (to: ScanDirection) => {
    const id = batchIdRef.current;
    if (!id) return;
    setDoubt(null);
    doubtRun.current = 0;
    try {
      const res = await fetch('/api/scan/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: id, direction: to }),
      });
      if (res.status === 401) { setSignedOut(true); return; }
      if (!res.ok) {
        setProblem('The batch could not be switched. Tell the office which pile this is.');
        return;
      }
      /*
       * Off to the other mode, which is a page of its own: `direction` is a
       * prop of this component and the batch has just stopped being this
       * mode's. The scans came with it.
       */
      window.location.href = `/scan/${to}`;
    } catch {
      setProblem('The batch could not be switched. Tell the office which pile this is.');
    }
  }, []);

  const onCode = useCallback((code: CorreosCode) => { void take(code, 'barcode'); }, [take]);
  const camera = useScanner(onCode);

  /* ----------------------------------------------------------- the timers */

  // First pass: pick up anything left in the queue from a previous session,
  // and open a batch if there is not one.
  useEffect(() => { void flush(); }, [flush]);

  useEffect(() => {
    if (!queue.length) return undefined;
    const timer = setInterval(() => { void flush(); }, RETRY_MS);
    return () => clearInterval(timer);
  }, [queue.length, flush]);

  useEffect(() => {
    const again = () => { void flush(); };
    window.addEventListener('online', again);
    // Coming back to the app is the other moment worth trying: a phone that was
    // asleep in a pocket does not fire `online`.
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [flush]);

  useEffect(() => {
    if (!flash) return undefined;
    // A wrong-way banner outlives the flash window: the sticky `doubt` panel
    // below is what the worker answers, and the big orange edge has to stay up
    // with it rather than go green again after 1.2 seconds.
    const ms = flash.kind === 'wrong-way' ? FLASH_MS * 3 : FLASH_MS;
    const timer = setTimeout(() => setFlash(null), ms);
    return () => clearTimeout(timer);
  }, [flash]);

  /*
   * "Just now" is time-based, so it needs a tick of its own to come off — and
   * it must not be decided during the server render at all, for the same
   * reason `startedAt` is not: the server's clock and the browser's would
   * disagree about a scan four seconds old.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!items.length && !queue.length) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [items.length, queue.length]);

  /* -------------------------------------------------------------- the rows */

  const rows: DisplayRow[] = useMemo(() => {
    const now = Date.now();
    const stored: DisplayRow[] = items.map((i) => ({
      key: i.id,
      base: i.base,
      postalCode: i.postalCode,
      at: i.scannedAt,
      label: i.label,
      sharing: i.sharing,
      timesRead: i.timesRead,
      sending: false,
      justNow: mounted && now - new Date(i.scannedAt).getTime() < JUST_NOW_MS,
      remove: { kind: 'scan', id: i.id },
    }));

    const codes = new Set(items.map((i) => i.codeAsRead));
    const sending: DisplayRow[] = queue
      .filter((q) => !codes.has(q.code))
      .map((q) => ({
        key: q.readId,
        base: q.code.slice(0, 15),
        postalCode: q.code.length === 23 ? q.code.slice(17, 22) : null,
        at: q.at,
        label: null,
        sharing: 0,
        timesRead: 1,
        sending: true,
        justNow: mounted && now - new Date(q.at).getTime() < JUST_NOW_MS,
        remove: { kind: 'read', readId: q.readId },
      }));

    return [...stored, ...sending].sort((a, b) => b.at.localeCompare(a.at));
  }, [items, queue, mounted]);

  const summary = useMemo(() => summarise(items), [items]);

  /* ------------------------------------------------------------ the actions */

  const remove = useCallback(async (target: RemoveTarget) => {
    if (target.kind === 'read') {
      await forgetRead(target.readId);
      setQueue(await pendingReads(direction));
      return;
    }

    const gone = items.find((i) => i.id === target.id);
    setItems((prev) => prev.filter((i) => i.id !== target.id));

    try {
      const res = await fetch('/api/scan/scan', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id }),
      });
      if (res.status === 401) { setSignedOut(true); return; }
      // Put it back rather than quietly dropping a parcel off the list.
      if (!res.ok && gone) upsert(gone);
    } catch {
      if (gone) upsert(gone);
    }
  }, [direction, items, upsert]);

  const finish = useCallback(async () => {
    const id = batchIdRef.current;
    if (!id) return;
    setFinishing(true);

    try {
      // Every read has to be on the server first. The sheet's button is
      // disabled while the queue has anything in it, and this is the belt to
      // that braces.
      await flush();
      if ((await pendingReads(direction)).length) return;

      const res = await fetch('/api/scan/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: id }),
      });
      if (res.status === 401) { setSignedOut(true); return; }
      if (!res.ok) {
        setProblem('The batch could not be finished. Everything is saved — try again.');
        return;
      }

      const body = await res.json() as { batch: Batch; summary: ReturnType<typeof summarise> };
      setSheet('none');
      setSaved(body);
    } finally {
      setFinishing(false);
    }
  }, [direction, flush]);

  const startNew = useCallback(() => {
    setSaved(null);
    setItems([]);
    setProblem(null);
    batchIdRef.current = null;
    setBatchId(null);
    void ensureBatch();
  }, [ensureBatch]);

  /* ------------------------------------------------------------- the screens */

  if (signedOut) return <SignedOut />;

  if (saved) {
    return (
      <BatchSaved
        direction={direction}
        startedAt={saved.batch.startedAt}
        finishedAt={saved.batch.finishedAt}
        summary={saved.summary}
        onNewBatch={startNew}
      />
    );
  }

  const outgoing = direction === 'outgoing';
  const Icon = outgoing ? OutgoingIcon : IncomingIcon;

  return (
    // The first tap anywhere unlocks the audio, which an iPhone will not do by
    // itself. Capturing, so it fires whatever was tapped.
    <main
      onPointerDownCapture={unlockAudio}
      className="flex min-h-[100dvh] flex-col bg-ground"
    >
      <header
        className="flex h-14 flex-none items-center justify-between gap-2 bg-navy px-4 text-white"
        style={outgoing ? undefined : { borderBottom: '4px solid var(--crit)' }}
      >
        <div className="flex min-w-0 items-center gap-[10px]">
          <span className="h-3 w-3 flex-none rounded-[2px] bg-accent" />
          <span className="text-[18px] font-bold">Scanner</span>
          <Link
            href="/scan"
            aria-label={`${DIRECTION_LABEL[direction]}. Tap to change`}
            className="flex h-8 items-center gap-[5px] rounded-[8px] border pl-[10px] pr-2 text-[13px] font-semibold text-white"
            style={outgoing
              ? { borderColor: 'var(--navy2)' }
              : { borderColor: 'var(--crit)', background: 'var(--crit)' }}
          >
            <Icon size={14} width={2.4} />
            {DIRECTION_LABEL[direction]}
            <ChevronDown />
          </Link>
        </div>
        <span
          aria-live="polite"
          className="flex-none rounded-[8px] border border-accent px-[10px] py-[5px] text-[13px] font-semibold"
          style={flash?.kind === 'saved'
            ? { background: 'var(--accent)', color: 'var(--navy)', fontWeight: 700 }
            : { color: 'var(--accent)' }}
        >
          <span className="tnum">{rows.length}</span> scanned
        </span>
      </header>

      <CameraPanel camera={camera} flash={flash} />

      <div className="flex flex-none items-center justify-between gap-3 border-b border-line bg-surface px-4 py-[10px]">
        <div className="flex min-w-0 items-center gap-[10px]">
          <span
            className="h-[10px] w-[10px] flex-none rounded-full"
            style={{
              background: flash?.kind === 'wrong-way'
                ? 'var(--warn)'
                : flash?.kind === 'duplicate'
                  ? 'var(--warn)'
                  : flash?.kind === 'saved' ? 'var(--good)' : 'var(--crit)',
              boxShadow: '0 0 0 4px rgba(90,100,120,.16)',
            }}
          />
          <span className="flex min-w-0 flex-col">
            <span
              className="text-[15px] font-semibold"
              style={{
                color: flash?.kind === 'wrong-way'
                  ? 'var(--warn)'
                  : flash?.kind === 'duplicate'
                    ? 'var(--warn)'
                    : flash?.kind === 'saved' ? 'var(--good)' : 'var(--ink)',
              }}
            >
              {flash?.kind === 'wrong-way'
                ? 'Saved — but check the direction'
                : flash?.kind === 'duplicate'
                  ? 'Already in this batch'
                  : flash?.kind === 'saved'
                    ? 'Beep · saved'
                    : outgoing ? 'Scanning' : 'Scanning incoming'}
            </span>
            <span className="text-[13px] text-muted">
              {queue.length
                ? `Sending ${queue.length}…`
                : flash
                  ? flash.kind === 'wrong-way'
                    ? 'It is stored either way — read the orange box'
                    : flash.kind === 'duplicate'
                      ? 'Not added again'
                      : 'The next scan starts by itself'
                  : 'Hold still until the beep'}
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => setSheet('type')}
          className="flex h-11 flex-none items-center gap-2 rounded-[10px] border border-line bg-surface px-3 text-[14px] font-semibold text-navy"
        >
          <KeypadIcon />
          Type number
        </button>
      </div>

      {problem && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-start gap-3 rounded-[10px] border border-crit bg-critsoft px-[14px] py-3"
        >
          <span className="mt-[2px] flex-none text-crit"><WarnIcon /></span>
          <span className="text-[13px] leading-[1.45] text-crit">{problem}</span>
        </div>
      )}

      {/*
        * THE PILE MAY BE GOING THE OTHER WAY.
        *
        * Orange, not red, and it stays until it is answered. The parcel IS
        * saved — that is said first, because the worker's instinct on seeing a
        * warning is to scan it again, and a second read of the same label is
        * the one thing that cannot help.
        *
        * Two buttons and no cancel: either the pile is going out, or it really
        * came back. Both are one tap, and both are honest about what they do.
        */}
      {doubt && (
        <div
          role="alert"
          className="mx-4 mt-3 rounded-[10px] border-2 border-warn bg-warnsoft px-[14px] py-3"
        >
          <div className="flex items-start gap-3">
            <span className="mt-[2px] flex-none text-warn"><WarnIcon /></span>
            <div className="min-w-0">
              <div className="text-[15px] font-bold text-warn">
                {doubt.kind === 'return-in-outgoing'
                  ? 'This is a return label'
                  : 'Is this pile going the other way?'}
              </div>
              <div className="mt-[2px] font-mono text-[12px] text-muted">{doubt.code}</div>
              <div className="mt-1 text-[13px] leading-[1.45] text-ink">
                {doubt.message} It is saved either way — do not scan it again.
              </div>
              {doubt.run >= DOUBT_RUN && (
                <div className="mt-1 text-[13px] font-semibold leading-[1.45] text-warn">
                  {`That is ${doubt.run} in a row. This looks like a whole pile in the wrong mode.`}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { void switchBatch(doubt.shouldBe); }}
              className="h-11 flex-1 rounded-[10px] bg-navy px-3 text-[14px] font-semibold text-white"
            >
              {doubt.shouldBe === 'outgoing'
                ? 'Switch this batch to Outgoing'
                : 'Switch this batch to Incoming'}
            </button>
            <button
              type="button"
              onClick={() => { setDoubt(null); doubtRun.current = 0; }}
              className="h-11 flex-1 rounded-[10px] border border-line bg-surface px-3 text-[14px] font-semibold text-navy"
            >
              {doubt.shouldBe === 'outgoing' ? 'It really came back' : 'It really went out'}
            </button>
          </div>
        </div>
      )}

      <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4 pt-[14px]">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[.09em] text-ink">
            This batch{outgoing ? '' : ' · incoming'}
          </span>
          <span className="text-[13px] text-muted">newest first</span>
        </div>
        <BatchList rows={rows} onRemove={(t) => void remove(t)} />
      </section>

      <footer className="flex-none border-t border-line bg-surface px-4 pb-6 pt-3">
        <button
          type="button"
          onClick={() => { void flush(); setSheet('finish'); }}
          disabled={rows.length === 0}
          className="flex h-[54px] w-full items-center justify-center gap-[10px] rounded-[10px] bg-navy text-[17px] font-semibold text-white disabled:opacity-40"
        >
          Complete batch
          <span className="tnum rounded-[6px] bg-accent px-2 text-[15px] text-navy">
            {rows.length}
          </span>
        </button>
        <div className="mt-2 text-center text-[11.5px] text-muted">
          {worker}{startedAt ? ` · ${madridTime(startedAt)}` : ''}
        </div>
      </footer>

      {sheet === 'type' && (
        <TypeSheet
          onClose={() => setSheet('none')}
          onAdd={(code) => {
            setSheet('none');
            // The sheet only hands back a code it has already parsed; parsing
            // it again here is how the same module ends up being the only
            // parser either end uses.
            const parsed = parseCorreosCode(code);
            if (parsed) void take(parsed, 'typed');
          }}
        />
      )}

      {sheet === 'finish' && (
        <FinishSheet
          direction={direction}
          startedAt={startedAt ?? new Date().toISOString()}
          summary={summary}
          sending={queue.length}
          busy={finishing}
          onKeepScanning={() => setSheet('none')}
          onFinish={() => void finish()}
        />
      )}
    </main>
  );
}

/* --------------------------------------------------------------- the camera */

function CameraPanel({
  camera,
  flash,
}: {
  camera: ReturnType<typeof useScanner>;
  flash: Flash | null;
}) {
  /*
   * Three kinds now, and a THIRD BRANCH IS NEEDED AT EVERY SITE: each of these
   * reads was a two-branch ternary falling through to the neutral style, so a
   * kind added only to the type would render as "Scanning" with a white edge
   * and no card — a warning nobody sees.
   */
  const wrong = flash?.kind === 'wrong-way';
  const edge = wrong || flash?.kind === 'duplicate'
    ? 'var(--warn)'
    : flash?.kind === 'saved' ? 'var(--good)' : 'rgba(255,255,255,.75)';
  const line = wrong || flash?.kind === 'duplicate'
    ? 'var(--warn)'
    : flash?.kind === 'saved' ? 'var(--good)' : 'var(--crit)';

  return (
    <div className="relative h-[360px] flex-none overflow-hidden bg-[#0A0F1C]">
      <video
        ref={camera.videoRef}
        playsInline
        muted
        autoPlay
        className="block h-full w-full object-cover"
      />

      {camera.status !== 'camera-error' && (
        <div
          className="absolute rounded-[10px]"
          style={{
            left: `${SCAN_BOX.x * 100}%`,
            top: `${SCAN_BOX.y * 100}%`,
            width: `${SCAN_BOX.w * 100}%`,
            height: `${SCAN_BOX.h * 100}%`,
            border: `2px solid ${edge}`,
            boxShadow: '0 0 0 999px rgba(6,10,20,.58)',
          }}
        >
          <span
            className="absolute left-3 right-3 top-1/2 h-[2px]"
            style={{ background: line }}
          />
        </div>
      )}

      {flash && (
        <div
          role="status"
          className="absolute left-3 right-[68px] top-3 flex flex-col gap-2 rounded-[12px] px-3 pb-3 pt-[10px] shadow-card"
          style={flash.kind === 'saved'
            ? { background: 'var(--good)', color: '#fff' }
            : { background: 'var(--warn)', color: '#fff' }}
        >
          <div className="flex items-center gap-[10px]">
            <span
              className="grid h-[30px] w-[30px] flex-none place-items-center rounded-full bg-white"
              style={{ color: flash.kind === 'saved' ? 'var(--good)' : 'var(--warn)' }}
            >
              {flash.kind === 'saved' ? <TickIcon /> : <WarnIcon size={18} />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[17px] font-bold leading-[1.2]">
                {flash.kind === 'wrong-way'
                  ? 'Saved · wrong way round?'
                  : flash.kind === 'duplicate' ? 'Already in this batch' : 'Scanned'}
              </span>
              <span className="font-mono text-[14px] leading-[1.3]">{flash.base}</span>
            </span>
          </div>
          <div aria-hidden="true" className="h-1 overflow-hidden rounded-[2px] bg-[rgba(255,255,255,.3)]">
            <div className="scan-countdown h-1 rounded-[2px] bg-white" />
          </div>
        </div>
      )}

      {camera.torchAvailable && camera.status !== 'camera-error' && (
        <>
          <button
            type="button"
            onClick={camera.toggleTorch}
            aria-label={camera.torchOn ? 'Turn off the light' : 'Turn on the light'}
            className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full border p-0"
            style={camera.torchOn
              ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--navy)' }
              : { background: 'rgba(255,255,255,.14)', borderColor: 'rgba(255,255,255,.28)', color: '#fff' }}
          >
            <TorchIcon />
          </button>
          {camera.torchOn && (
            <span className="absolute right-[62px] top-6 text-[12px] font-semibold text-accent">
              Light on
            </span>
          )}
        </>
      )}

      {camera.status === 'camera-error' ? (
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          <div>
            <p className="m-0 text-[15px] font-semibold leading-[1.5] text-white">
              {camera.cameraError}
            </p>
            <p className="m-0 mt-2 text-[13px] leading-[1.5] text-[#C9D1E0]">
              The numbers can still be typed in: use <b>Type number</b> below.
            </p>
          </div>
        </div>
      ) : (
        <p
          className="absolute bottom-[18px] left-4 right-4 m-0 text-center text-[14px] font-semibold leading-[1.4]"
          style={{
            color: wrong || flash?.kind === 'duplicate'
              ? 'var(--accent)'
              : flash?.kind === 'saved' ? 'var(--goodsoft)' : '#E5E9F0',
          }}
        >
          {flash?.kind === 'wrong-way'
            ? 'Saved. Read the orange box below'
            : flash?.kind === 'duplicate'
              ? 'Not added again. Move to the next parcel'
              : flash?.kind === 'saved'
                ? 'Saved. Move to the next parcel'
                : camera.status === 'starting' ? 'Opening the camera…' : 'Fill the box with the barcode'}
        </p>
      )}
    </div>
  );
}

function SignedOut() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-ground px-6 text-center">
      <h1 className="m-0 text-[22px] font-semibold text-ink">Signed out</h1>
      <p className="m-0 max-w-[280px] text-[14px] leading-[1.5] text-muted">
        Everything scanned has been saved. Sign in again to carry on with the batch.
      </p>
      <Link
        href="/scan/login"
        className="flex h-[52px] items-center justify-center rounded-[10px] bg-navy px-6 text-[16px] font-semibold text-white"
      >
        Sign in
      </Link>
    </main>
  );
}

/* ---------------------------------------------------------------- plumbing */

/**
 * The id of one read.
 *
 * `crypto.randomUUID` needs a secure context, which the camera needs anyway —
 * but the fallback is there because an id that comes back undefined would make
 * every read look like the same read, and the server would count one.
 */
function newReadId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
