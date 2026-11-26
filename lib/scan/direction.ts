import type { CorreosCode } from './codes';
import type { ScanDirection } from './model';

/**
 * Is this pile going the way the phone thinks it is?
 *
 * TWO REAL MISTAKES, BOTH ALREADY MADE, and they need different answers.
 *
 * On 20 November the warehouse scanned fifty-two parcels in Incoming mode in
 * thirty-eight minutes. Correos had those parcels out for delivery, on the way
 * or delivered — they were an OUTGOING pile, and the phone was in the wrong
 * mode. One of them, Paquita's, then read "Back in the warehouse · 20 Nov"
 * while Correos were still driving it to her. On 25 November it happened again
 * with thirty labels, every one of them Pre-admisión. Meanwhile the five real
 * returns of 27 October — the only `DX` labels in the whole table — were filed
 * under "Not in Return Shield", because nothing here knew what a DX label was.
 *
 * So:
 *
 *   A DX LABEL IS CERTAIN. The code itself says the parcel came back; no
 *   lookup, no state, no doubt. A DX label in an Outgoing batch is wrong, and
 *   the phone can say so before the read has even been sent.
 *
 *   AN ORDINARY LABEL IN AN INCOMING BATCH NEEDS THE PARCEL. Scanning one is
 *   perfectly normal — a customer can bring a box back by hand, and half the
 *   Returns tab is parcels this system has never heard of. What is NOT normal
 *   is scanning IN a parcel Correos currently has out for delivery, or has
 *   already handed to the customer: that is a contradiction rather than a
 *   guess, and it is what both wrong-mode piles look like. Which is why this
 *   check needs the state and cannot live on the phone alone.
 *
 * NEITHER OF THEM EVER REFUSES A SCAN. "Beep means it is saved" is the
 * contract the warehouse works to, and a refusal here would have the phone
 * drop the read and tell the worker to write the number down — losing a
 * parcel to avoid a wrong label on a screen. Both verdicts are advisory and
 * both are fixable afterwards, from the phone or from the Returns tab.
 */

export type DirectionDoubt =
  /** A `DX` return label, scanned in an Outgoing batch. Certain. */
  | 'return-in-outgoing'
  /** Scanned IN, but Correos says it is still on its way out. */
  | 'outbound-in-incoming';

export interface DirectionVerdict {
  doubt: DirectionDoubt;
  /** What the worker is told, in the words they read. */
  message: string;
  /** Which direction the scan looks like it should have had. */
  shouldBe: ScanDirection;
}

/**
 * The states that mean "Correos does not think this parcel is coming back".
 *
 * Deliberately NOT all of them. A parcel whose delivery failed, or that is
 * sitting at a post office, or whose address is wrong, may well be on its way
 * back before Correos says so — eighteen of the eighty-seven returns were
 * still travelling when the operator counted them — so scanning one in is
 * early, not wrong. And `returning`, `returned` and `refused` are the parcels
 * this mode is FOR.
 *
 * What is left is the contradiction: a parcel Correos has not finished
 * delivering, or has already delivered, cannot also be on our shelf wearing
 * the label it went out on.
 */
const NOT_COMING_BACK: ReadonlySet<string> = new Set([
  'created', 'accepted', 'in_transit', 'out_for_delivery', 'delivered', 'collected',
]);

/** English for the states above, for the one sentence the worker reads. */
const SAYS: Record<string, string> = {
  created: 'has not been handed to Correos yet',
  accepted: 'has only just been accepted by Correos',
  in_transit: 'is on the way to the customer',
  out_for_delivery: 'is out for delivery to the customer',
  delivered: 'was delivered to the customer',
  collected: 'was picked up by the customer at the post office',
};

/**
 * The verdict the phone can reach on its own, instantly, from the code alone.
 *
 * It runs before the read has been sent, which is the only moment a warning
 * can reach the worker while the parcel is still in their hand.
 */
export function doubtFromCode(
  code: CorreosCode,
  direction: ScanDirection,
): DirectionVerdict | null {
  if (code.isReturn && direction === 'outgoing') {
    return {
      doubt: 'return-in-outgoing',
      shouldBe: 'incoming',
      /*
       * NOT "This is a return label — …". The banner puts that in its own
       * title for this verdict, and until the title actually rendered (it was
       * keyed off a field nothing set) nobody saw the two together: the box
       * read "This is a return label" and then, one line down, "This is a
       * return label — the parcel came back to us." One of the two carries
       * the sentence, and the title is the one the worker reads first.
       */
      message: 'The parcel came back to us.',
    };
  }
  return null;
}

/**
 * The verdict only the server can reach, because it needs the parcel.
 *
 * `null` for everything the code-only check already covers, so a scan never
 * carries two verdicts and the phone never has to decide which one to show.
 */
export function doubtFromParcel(
  code: CorreosCode,
  direction: ScanDirection,
  parcel: { state: string } | null,
): DirectionVerdict | null {
  const fromCode = doubtFromCode(code, direction);
  if (fromCode) return fromCode;

  if (direction !== 'incoming') return null;
  if (code.isReturn) return null;
  // No parcel means no contradiction. Half the Returns tab is codes this
  // system has never heard of, and those are not a mistake.
  if (!parcel) return null;
  if (!NOT_COMING_BACK.has(parcel.state)) return null;

  return {
    doubt: 'outbound-in-incoming',
    shouldBe: 'outgoing',
    message: `Correos says this parcel ${SAYS[parcel.state] ?? 'is not coming back'}.`
      + ' Did it really arrive back here?',
  };
}

/**
 * How many doubtful reads in a row before the whole batch is worth questioning.
 *
 * Three, because one is a parcel and three is a pile. The wrong-mode batches
 * were fifty-two and thirty labels long: a worker told after three has
 * twenty-seven left to save.
 */
export const DOUBT_RUN = 3;

/**
 * A run of doubtful reads, and which reads have already been counted into it.
 *
 * `count` is the number the banner prints, so it has to be the number of
 * PARCELS the worker has read — not the number of verdicts the app has
 * handled. Those differ for exactly one case: a DX label in an Outgoing
 * batch, which the phone settles from the code before the read is even sent
 * and which the server then agrees with on purpose (see `doubtFromParcel`).
 * Counting both landed the same parcel twice, so two DX labels announced
 * "That is 3 in a row" to a worker who had read two.
 *
 * `counted` holds readIds, and a readId survives a resend, so a lost response
 * that comes back twice is still one parcel.
 */
export type DoubtRun = {
  readonly count: number;
  readonly counted: readonly string[];
};

/** No doubtful reads: where a batch starts, and what any good read restores. */
export const NO_DOUBT_RUN: DoubtRun = { count: 0, counted: [] };

/**
 * Whether this read is already in the run.
 *
 * The phone needs this as well as the count: it beeps when a run STARTS, and
 * a read it has already beeped for must not beep again when the server sends
 * the same verdict back.
 */
export function alreadyCounted(run: DoubtRun, readId: string): boolean {
  return run.counted.includes(readId);
}

/**
 * The run after one read, doubtful or not.
 *
 * A read the server was happy with breaks it: three in a row is a pile, three
 * scattered through sixty is not.
 */
export function afterRead(run: DoubtRun, readId: string, doubtful: boolean): DoubtRun {
  if (!doubtful) return NO_DOUBT_RUN;
  if (alreadyCounted(run, readId)) return run;
  return { count: run.count + 1, counted: [...run.counted, readId] };
}
