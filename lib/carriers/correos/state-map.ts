import type { ShipmentState } from '@/lib/state-machine/states';
import type { EventLeg } from './return-code';

/**
 * The one place Spanish becomes a state. Nothing else in the codebase is
 * allowed to look at a Correos description — if you find yourself comparing
 * strings somewhere else, the mapping belongs here instead.
 *
 * Correos identifies events by a numeric code and sends a Spanish description
 * alongside. We match on either: the code when we recognise it, the wording
 * when we do not. Codes are the stable key, but we have only seen the wording
 * so far, so the wording is what the table is built from and codes are added
 * as they are confirmed against real traffic.
 *
 * Anything that matches neither is NOT an error. It is kept on the event, shown
 * in the timeline in Correos' own words, queued for a human to look at, and
 * changes no state. Correos will send codes nobody here has seen before, and
 * that must never take the system down.
 */

export interface CorreosMapping {
  state: ShipmentState;
  /** What we show under their Spanish, in plain English. */
  label: string;
}

/** Descriptions, normalised (see `normaliseDesc`) → state. */
const BY_DESCRIPTION: Record<string, ShipmentState> = {
  // The label exists in Correos' systems and the parcel is still with us.
  'prerregistrado': 'created',
  'admitido': 'accepted',
  'en transito': 'in_transit',
  'en reparto': 'out_for_delivery',
  'intento de entrega fallido - ausente': 'failed',
  'disponible en oficina para recoger': 'at_office',
  'entregado en oficina': 'collected',
  'entregado': 'delivered',
  'direccion incorrecta': 'bad_address',
  'envio rehusado por el destinatario': 'refused',
  'devolucion a origen iniciada': 'returning',
};

/**
 * Extra wordings seen in the wild for the same events. Kept separate from the
 * table above so the canonical list stays exactly the one that was agreed.
 */
const DESCRIPTION_ALIASES: Record<string, string> = {
  'admitido en oficina': 'admitido',
  'admision': 'admitido',
  'en transito hacia destino': 'en transito',
  'llegada a oficina de reparto': 'en transito',
  'salida a reparto': 'en reparto',
  'intento de entrega fallido': 'intento de entrega fallido - ausente',
  'intento de entrega fallido ausente': 'intento de entrega fallido - ausente',
  'destinatario ausente': 'intento de entrega fallido - ausente',
  'disponible en oficina': 'disponible en oficina para recoger',
  'a disposicion en oficina': 'disponible en oficina para recoger',
  'entregado al destinatario': 'entregado',
  'entrega realizada': 'entregado',
  'recogido en oficina': 'entregado en oficina',
  'direccion erronea': 'direccion incorrecta',
  'direccion insuficiente': 'direccion incorrecta',
  'rehusado': 'envio rehusado por el destinatario',
  'rehusado por el destinatario': 'envio rehusado por el destinatario',
  'devolucion a origen': 'devolucion a origen iniciada',
  'inicio de devolucion': 'devolucion a origen iniciada',

  /*
   * Wordings taken from Correos' own public tracker, 7 October.
   *
   * Each one is here because its meaning is unambiguous on its own. The ones
   * NOT here are the point of the list:
   *
   *   "Llegada a la oficina de destino" is not `at_office`. It says the parcel
   *   reached the office, not that it is waiting there for the customer —
   *   "A disposición del destinatario" is what says that, and it is the event
   *   the deposit countdown starts from. Mapping the arrival would start the
   *   countdown early and send a customer to collect a parcel that is not yet
   *   collectable.
   *
   *   "Alta en unidad de reparto" is the delivery unit booking it in, which is
   *   still in transit rather than out with the postman. "En reparto" is the
   *   one that means a van.
   *
   * Both of those are left to the review queue, where a human can look at
   * real traffic and decide. Guessing either costs a wrong countdown.
   */
  'envio prerregistrado': 'prerregistrado',
  'envio prerregistrado en los sistemas de correos pendiente de deposito': 'prerregistrado',
  'el envio ha tenido admision en origen': 'admitido',
  'envio clasificado en centro logistico': 'en transito',
  'envio clasificado': 'en transito',
  'clasificado': 'en transito',
  'llegada a la oficina de destino': 'en transito',
  'a disposicion del destinatario': 'disponible en oficina para recoger',
  'envio entregado en buzon domiciliario': 'entregado',
  'retorno a remitente': 'devolucion a origen iniciada',

  /*
   * Wordings from the 7 October traffic, with the codes they arrived under
   * recorded in `BY_CODE` below.
   *
   *   "Intento de entrega. Ausente" is a failed delivery. The key keeps the
   *   full stop in the middle of it, because `normaliseDesc` strips trailing
   *   punctuation only — "intento de entrega. ausente" is what the normaliser
   *   actually produces, and a key spelled without the stop would never
   *   match. Until this was here the event fell through to its phase, EN
   *   ENTREGA, so the parcel read as out for delivery, the Failed delivery tab
   *   never saw it and the post-failure ladder never started.
   *
   *   "Finalizado plazo retirada" is Correos saying the collection window is
   *   over and the parcel is going back. Before this the parcel stayed
   *   "Waiting at the post office" and sat in the Missed-delivery worklist, so
   *   the operator would ring a customer about collecting a parcel that can no
   *   longer be collected.
   *
   * Two more wordings arrived with them and are NOT here, on purpose:
   * "Desestacionado" and "Entrega modificada". Neither meaning is clear from
   * the words alone, so they stay in the review queue until Correos tell us.
   */
  /*
   * "Alta en la unidad de reparto" — `G01L010V`.
   *
   * Correos' own tracker files this under OUT FOR DELIVERY, with the text
   * "Your shipment has arrived at the unit responsible for its delivery". So
   * `out_for_delivery` it is, by their classification rather than our reading
   * of the words.
   *
   * BOTH spellings are here, and that is the point of listing them together.
   * `'alta en unidad de reparto'` — no "la" — used to sit in the canonical
   * table mapped to `en transito`, taken off Correos' public web tracker; the
   * feed sends the longer spelling, which was left in the review queue. One
   * event, two keys, two different answers, and a round spent explaining why
   * they had to stay apart. They do not: Correos settled it.
   */
  'alta en la unidad de reparto': 'en reparto',
  'alta en unidad de reparto': 'en reparto',

  'intento de entrega. ausente': 'intento de entrega fallido - ausente',
  'finalizado plazo retirada': 'devolucion a origen iniciada',
  'devolucion del envio por finalizacion de plazo de retirada': 'devolucion a origen iniciada',

  /*
   * Two more from the same traffic, read off `shipment_events` and
   * `event_review_queue` in production, each unambiguous on its own.
   *
   *   "En proceso de devolución" is the parcel on its way back to us, which
   *   is the same thing `L03D045R` says by code.
   *
   *   "Dirección Incorrecta. Se procede a remitir el envío a la oficina de
   *   referencia" is `bad_address`: the address is wrong and Correos are
   *   holding the parcel at an office rather than attempting it again. The
   *   short wording "Dirección incorrecta" is already in the canonical table
   *   above; this is the full sentence they actually send, which does not
   *   match the short key.
   *
   * NOT mapped, on purpose, and listed here so nobody adds them in passing.
   * Each one arrived with a code and each is waiting on an answer from
   * Correos, because the words alone do not settle what we should do:
   *
   *   H01R424V  Realizado intento de entrega
   *   H06P010V  En proceso de entrega
   *   H06P050V  En proceso de entrega
   *   M010090R  Envío a estacionar
   *   M01E020R  Envío a estacionar
   *   M01E320R  Estacionado
   *   M02E340V  Desestacionado
   *   M02E360V  Desestacionado
   *   R010751V  Entrega modificada
   *
   * "Realizado intento de entrega" is the one to be most careful with: it says
   * an attempt was made and NOT whether it succeeded, so reading it as a
   * failure would start the post-failure ladder on parcels that were
   * delivered. It is a near-miss for the four `intento de entrega …` keys
   * above, and it matches none of them.
   *
   * `G01L010V` "Alta en la unidad de reparto" used to be on this list, and
   * Correos answered it: their own tracker files it under OUT FOR DELIVERY.
   * Both spellings of it are mapped above.
   */
  'en proceso de devolucion': 'devolucion a origen iniciada',
  'direccion incorrecta. se procede a remitir el envio a la oficina de referencia': 'direccion incorrecta',
};

/**
 * Event codes confirmed against real traffic from the trackpub v2 `/search`
 * response. A code is only added here once it has been seen with its wording,
 * because a guessed code maps silently and wrongly, while a missing one asks a
 * human. Everything still unconfirmed falls through to the wording below.
 */
const BY_CODE: Record<string, ShipmentState> = {
  // Captured 6 October from a real parcel: PRE-ADMISIÓN → EN CAMINO.
  A090000V: 'created',          // "Prerregistrado"
  A010000V: 'accepted',         // "Admitido."
  P040000V: 'in_transit',       // "Clasificado"

  // Captured 7 October from the thirty-day pull.
  //
  // `H01I350V` is the event the whole post-office part of the system hangs
  // off: "A disposición del destinatario", the moment the parcel is actually
  // collectable. Its wording was already mapped; the code is here because the
  // code is the stable key and the wording is not.
  H01I350V: 'at_office',        // "A disposición del destinatario" · EN ENTREGA
  // And this is Correos saying it is going back, which is the only thing that
  // ever said so. Nothing else in the system claims to know when a parcel is
  // returned to us.
  L03D320R: 'returning',        // "Finalizado plazo retirada" · DEVOLUCION

  /*
   * Read straight out of `shipment_events` and `event_review_queue` in
   * production, which is also how the first of these finally got its code:
   * "Intento de entrega. Ausente" was mapped by wording alone last time
   * because the payload we had was a summary, and `remapKnownEvents` wrote the
   * real code onto the review-queue row it resolved. Nothing here is a guess.
   */
  H01R420V: 'failed',           // "Intento de entrega. Ausente" · EN ENTREGA
  L03D045R: 'returning',        // "En proceso de devolución" · DEVOLUCION
  H01R421V: 'bad_address',      // "Dirección Incorrecta. Se procede a remitir…"

  // Correos' own tracker groups this one under OUT FOR DELIVERY: "Your
  // shipment has arrived at the unit responsible for its delivery". It is the
  // van, not the depot. See the note on both wordings above.
  G01L010V: 'out_for_delivery', // "Alta en la unidad de reparto" · EN ENTREGA
};

/**
 * Correos' coarse delivery phase (`phaseDes`), as a last resort.
 *
 * This is the list Mi Oficina offers as a filter, so it is the full set. It is
 * deliberately the weakest signal available: a phase covers dozens of distinct
 * events, so `EN CAMINO` is true of a parcel that was just classified and of
 * one sitting in a depot three days later. It can keep a parcel moving through
 * the state machine when we have never seen the event before, and it must
 * never be allowed to overrule a code or a wording that we do know.
 *
 * `SIN FASE` is absent on purpose rather than mapped to anything — it is
 * Correos saying they have no phase for this event, which is not information.
 *
 * Keyed by `normalisePhase`, which is `normaliseDesc` without the dash
 * flattening — that step would turn `PRE-ADMISIÓN` into `pre - admision`.
 */
const BY_PHASE: Record<string, ShipmentState> = {
  'pre-admision': 'created',
  'en camino': 'in_transit',
  'en entrega': 'out_for_delivery',
  entregado: 'delivered',
  /*
   * Correos marks every return event with this phase, so an unmapped return
   * wording still reaches "Coming back" rather than leaving the parcel sitting
   * in a post-office worklist nobody can act on.
   *
   * It is still the weakest signal and still never overrules a code or a
   * wording we know: `matchCorreosEvent` only looks here when both of those
   * came back empty, and a phase match goes to the review queue all the same.
   */
  devolucion: 'returning',
};

/**
 * What each state means, in the words the screens use.
 *
 * ENGLISH LEADS, EVERYWHERE THE OPERATOR LOOKS. The operator does not read
 * Spanish, so a screen that shows only "Clasificado" is a screen they cannot
 * use. Correos' own words still appear, in `STATE_ES` below, as a smaller
 * second line — because when somebody rings Correos or opens the public
 * tracker, that is the phrase they need to match.
 *
 * Customer-facing text is the other way round and stays Spanish: the WhatsApp
 * and email templates, and the public /e/{token} pages. Those are read by
 * Spanish customers, and nothing here touches them.
 */
export const STATE_LABEL: Record<string, string> = {
  created: 'Pre-admission (label made, not handed to Correos)',
  accepted: 'Accepted by Correos',
  in_transit: 'On the way',
  out_for_delivery: 'Out for delivery',
  failed: 'Failed delivery (nobody home)',
  at_office: 'Waiting at the post office',
  collected: 'Picked up at the post office',
  delivered: 'Delivered',
  bad_address: 'Wrong address',
  refused: 'Refused by customer',
  returning: 'Coming back',
  returned: 'Returned',
  stale: 'No news from Correos',
};

/**
 * A short English label, for places too narrow for the full one — a chip on a
 * row, the heading on a parcel. Same meaning, fewer words.
 */
export const STATE_LABEL_SHORT: Record<string, string> = {
  created: 'Pre-admission',
  accepted: 'Accepted',
  in_transit: 'On the way',
  out_for_delivery: 'Out for delivery',
  failed: 'Nobody home',
  at_office: 'At post office',
  collected: 'Picked up',
  delivered: 'Delivered',
  bad_address: 'Wrong address',
  refused: 'Refused',
  returning: 'Coming back',
  returned: 'Returned',
  stale: 'No news',
};

/**
 * THE SAME EVENTS, READ AS THE JOURNEY HOME.
 *
 * A return travels under a code of Correos' own, and they describe that
 * journey in exactly the words they use for a journey to a customer — because
 * to them it IS one, with us as the addressee. So the mapper, which reads an
 * event and knows nothing about which leg it came from, maps the return's
 * first event to `created`, the van bringing the box to our door to
 * `out_for_delivery`, and the handover to `delivered`. Rendered through
 * `STATE_LABEL` those read:
 *
 *   "Devolución admitida"  ->  Pre-admission (label made, not handed to Correos)
 *   the van to our door    ->  Out for delivery
 *   "Entregado"            ->  Delivered
 *
 * Every one of which is a lie about the customer, sitting on a timeline the
 * operator reads down to answer "where is this parcel". The "Return · DX…" tag
 * beside them says which leg they are, and is not enough: nobody reads a tag
 * and then re-translates the sentence next to it.
 *
 * WHAT THE LEG CHANGES IS THE SUBJECT OF THE SENTENCE, not the fact. So this
 * is a second table rather than a rewording of the first, and it is HERE
 * because this file is "the one place Spanish becomes a state" — a label
 * table that lived next to a screen would be a second answer to the same
 * question, and the Settings Correos test needs the same answer.
 *
 * EVERY STATE IS SPELLED OUT, not only the three anybody has reported, and
 * most of the rest are reachable rather than theoretical. The mapper reads a
 * code, a wording and a phase; it never reads a leg; so a return shipment can
 * produce any event an outbound one can, with us as the addressee:
 *
 *   `failed`      Correos tried OUR door and nobody was in.
 *   `at_office`   the return is at a counter waiting for US to collect it.
 *   `bad_address` `H01R421V` on the return leg, which is Correos saying the
 *                 address they are returning it TO is wrong — i.e. ours, the
 *                 one RETURN_POSTCODE put in the code.
 *   `refused`     somebody at our end turned the return away at the door.
 *   `returning`   a DEVOLUCION-phase event on the return shipment itself. It
 *                 says the return is being sent back and NOT where to, so the
 *                 label says only that.
 *
 * Two are genuinely unreachable from any event, on either leg, because no
 * table maps to them: `returned` (a parcel state the projection decides across
 * a whole leg, never one event) and `stale` (our own word for silence). They
 * are here so the table is total over `SHIPMENT_STATES`, which
 * tests/language.test.ts holds it to.
 *
 * `in_transit` and `out_for_delivery` get separate sentences, as they do
 * outbound: the depot and the van at our door are different news, and the
 * second is the one the operator can act on.
 */
export const RETURN_LEG_LABEL: Record<string, string> = {
  created: 'Return accepted by Correos',
  accepted: 'Return accepted by Correos',
  in_transit: 'In transit back to us',
  out_for_delivery: 'On its way back to us',
  failed: 'Correos could not deliver the return to us',
  at_office: 'Waiting for us at a post office',
  collected: 'Back with us (collected at a Correos counter)',
  delivered: 'Back with us',
  bad_address: 'Correos says our returns address is wrong',
  refused: 'Return refused at our door',
  returning: 'The return itself is being sent back',
  // Not reachable from an event. See the note above.
  returned: 'Back with us',
  stale: 'No news from Correos about the return',
};

/**
 * One event's English, read on the leg it actually belongs to.
 *
 * Null for an event we have no mapping for, so a caller keeps its own "not
 * seen before" wording rather than being handed a guess.
 */
export function eventStateLabel(
  mappedState: string | null | undefined,
  leg: EventLeg = 'outbound',
): string | null {
  if (!mappedState) return null;

  /*
   * NO FALLING BACK TO THE OUTBOUND TABLE. A return-leg state this table has
   * no word for shows the bare state name — ugly, obvious, and somebody fixes
   * it — because the alternative is the one failure the table exists to
   * prevent: a van at OUR door quietly reading "Out for delivery" again, on
   * the day somebody adds a state and forgets a line.
   *
   * tests/language.test.ts holds the table total over `SHIPMENT_STATES`, so
   * this branch is unreachable today. It is written this way for the day it
   * is not.
   */
  if (leg === 'return') return RETURN_LEG_LABEL[mappedState] ?? mappedState;

  return STATE_LABEL[mappedState] ?? mappedState;
}

/**
 * What a PARCEL's state reads as to somebody who typed its RETURN code.
 *
 * The Settings Correos test's "Reads as" line. Typing
 * `DXA6TP9800129340128012S` into it and being told "Delivered" is true of
 * nothing anybody wanted to know: the box is on our own shelf. The parcel's
 * state in brackets because that is the word every other screen uses for it,
 * and somebody comparing two screens should not have to guess that "Back with
 * us" and "Returned" are the same thing.
 */
export function returnLegStateLabel(state: string): string {
  const own: Record<string, string> = {
    returned: 'Back with us',
    returning: 'Still on its way back to us',
  };
  const plain = STATE_LABEL[state] ?? state;
  return own[state] ? `${own[state]} (${plain})` : plain;
}

/**
 * Correos' own word for each state, for the muted second line.
 *
 * Not a translation of the English: it is the phrase Correos themselves use,
 * so it matches what the public tracker and their phone agents say. `stale` is
 * empty because it is not a Correos state at all — it is our own word for
 * silence, and inventing Spanish for it would be putting words in their mouth.
 *
 * NO PER-LEG VARIANT, unlike `STATE_LABEL`, and that is not an omission. This
 * line exists so somebody on the phone to Correos can match what they are
 * being told, and Correos say "Entregado" for both legs — they do not know
 * they are the second one. Translating it would be putting our reading in
 * their mouth, which is the one thing this table must never do.
 */
export const STATE_ES: Record<string, string> = {
  created: 'Pre-admisión / Prerregistrado',
  accepted: 'Admitido',
  in_transit: 'Clasificado / En tránsito',
  out_for_delivery: 'En reparto',
  failed: 'Ausente / Intento de entrega fallido',
  at_office: 'Disponible en oficina',
  collected: 'Entregado en oficina',
  delivered: 'Entregado',
  bad_address: 'Dirección incorrecta',
  refused: 'Rehusado',
  returning: 'En devolución',
  returned: 'Devuelto',
  stale: '',
};

/** The pair a screen renders: English first, Correos' words beneath. */
export interface Bilingual {
  en: string;
  /** Empty when Correos has no word of their own for it. */
  es: string;
}

export function stateLabels(state: string | null | undefined, short = false): Bilingual {
  if (!state) return { en: 'Not recognised yet', es: '' };
  const table = short ? STATE_LABEL_SHORT : STATE_LABEL;
  return { en: table[state] ?? state, es: STATE_ES[state] ?? '' };
}

/**
 * What one Correos event means, for a timeline row: our English on top, their
 * exact sentence underneath.
 *
 * `desc` is passed through untouched. It is evidence — the sentence to read
 * out on the phone — so it is never rewritten, only labelled.
 */
export function eventLabels(mappedState: string | null | undefined, desc: string): Bilingual {
  return { en: mappedState ? (STATE_LABEL[mappedState] ?? mappedState) : 'Not recognised yet', es: desc };
}

/**
 * Lowercase, strip accents, flatten every kind of dash and collapse spaces.
 * Correos' own feed is inconsistent about "—", "-" and "–" in the same event.
 *
 * The order of the last three steps is load-bearing, and used to be wrong.
 * Whitespace is collapsed and trimmed BEFORE the trailing punctuation is
 * stripped, because `/[.,;:]+$/` is anchored at the end of the string: with
 * `"Admitido. "` the `$` sat after the space, the period survived, and the
 * event did not match `admitido`. Correos does send trailing punctuation —
 * `summaryText` is literally `"Admitido."` — so this is the real traffic, not
 * a hypothetical.
 */
export function normaliseDesc(desc: string): string {
  return desc
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    // `…` as well as `.`: Correos' tracker truncates longer wordings with a
    // real ellipsis character, so "Envío prerregistrado…" and the full
    // sentence are the same event and must reach the same state.
    .replace(/[.,;:\u2026]+$/g, '')
    .trim();
}

/**
 * The same, minus the dash flattening.
 *
 * Phases are single words or short fixed strings where a hyphen is part of the
 * name: `PRE-ADMISIÓN` is one token, and `normaliseDesc` would spell it
 * `pre - admision`. Descriptions need the flattening because Correos mixes
 * "—", "-" and "–" inside one sentence; phases never do.
 */
export function normalisePhase(phase: string): string {
  return phase
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:\u2026]+$/g, '')
    .trim();
}

/** Which signal decided the state. See `matchCorreosEvent`. */
export type MappingSource = 'code' | 'description' | 'phase' | 'return-phase' | 'return-text';

export interface CorreosMatch {
  state: ShipmentState;
  via: MappingSource;
}

/**
 * Correos' own phase for every event on a parcel that is coming back.
 *
 * `normalisePhase('DEVOLUCION')`. They do not use it for anything else, which
 * is what makes it strong enough to beat a wording — see `matchCorreosEvent`.
 */
const RETURN_PHASE = 'devolucion';

/**
 * The wording Correos uses when a parcel held for instructions is released,
 * and the long text that says which way it was released.
 *
 * "Desestacionado" on its own means the hold is over and NOT what happens
 * next: the parcel can go on to the customer or back to us, and the word is
 * identical either way. The long text is the only thing that says which, so
 * that is what is read — and any Desestacionado without it stays in the review
 * queue exactly as before, because guessing it costs a parcel in the wrong
 * state.
 */
const UNHELD = 'desestacionado';
const UNHELD_MEANS_RETURN = 'pendiente de devolucion';

/** Does the code or the wording name an event we already recognise? */
function recognised(code: string | null | undefined, desc: string): boolean {
  if (code && BY_CODE[code.trim()]) return true;
  const key = normaliseDesc(desc);
  if (BY_DESCRIPTION[key]) return true;
  const alias = DESCRIPTION_ALIASES[key];
  return Boolean(alias && BY_DESCRIPTION[alias]);
}

/**
 * Map one Correos event to a state, saying which signal decided it.
 *
 * In order of how much each signal is worth:
 *
 *   1. the event code, when we recognise it
 *   2. phase DEVOLUCION — Correos' own word for "this parcel is coming back"
 *   3. "Desestacionado" whose long text says a return is pending
 *   4. the wording
 *   5. the coarse phase, for anything else
 *
 * Two and three are the return rules, and they sit above the wording because
 * Correos describe the start of a return with a sentence about why it started
 * — "Dirección incorrecta" — and the wording table reads that as a wrong
 * address. See the notes on each.
 *
 * A match `via: 'phase'` is a guess good enough to move the state machine and
 * not good enough to stop asking a human, which is why callers queue it for
 * review all the same.
 *
 * `longText` is Correos' longer sibling of the description: `expandedText` in
 * the trackpub feed, `extendedText` on their public tracker. Optional, so
 * every caller that has only the summary still compiles and still behaves
 * exactly as it did.
 *
 * Null is a normal outcome, not a failure.
 */
export function matchCorreosEvent(
  code: string | null | undefined,
  desc: string,
  phase?: string | null,
  longText?: string | null,
): CorreosMatch | null {
  const byCode = code ? BY_CODE[code.trim()] : undefined;
  if (byCode) return { state: byCode, via: 'code' };

  /*
   * PHASE DEVOLUCION MEANS THE PARCEL IS COMING BACK, WHATEVER THE WORDING
   * SAYS. Second only to the code, and above the wording tables on purpose.
   *
   * This is the rule that was missing, and it cost twenty-nine parcels. When
   * Correos start a return they send "Dirección incorrecta" in phase
   * DEVOLUCION, with the long text "La dirección de destino no es correcta y
   * se procede a la devolución del envío" — the address was wrong AND the
   * parcel is already on its way back. The wording table matched
   * `direccion incorrecta` first and called it `bad_address`, so twenty-nine
   * parcels sat in the Wrong-address worklist offering "Mark address as fixed
   * with Correos" while twenty-six of them were already back in the building.
   *
   * The phase is normally the weakest signal we have and is still the weakest
   * for everything else. DEVOLUCION is the exception because Correos use it
   * for one thing only: every confirmed code in it (`L03D320R`, `L03D045R`)
   * already maps to `returning`, and no event in any other phase does. A
   * wording is a sentence about what happened; this phase is Correos' own
   * classification of where the parcel is going.
   *
   * A KNOWN CODE STILL WINS, because it is the one signal more specific than
   * this: `H01R421V` is "Dirección Incorrecta. Se procede a remitir el envío a
   * la oficina de referencia" in phase EN ENTREGA — a genuinely wrong address
   * with the parcel held at an office — and it stays `bad_address`.
   */
  if (phase && normalisePhase(phase) === RETURN_PHASE) {
    return { state: 'returning', via: 'return-phase' };
  }

  const key = normaliseDesc(desc);

  /*
   * "Desestacionado", when the long text says which way it was released.
   *
   * It arrives in phase SIN FASE — Correos saying they have no phase for it —
   * so the rule above cannot see it, and the word alone is as true of a parcel
   * released onwards to the customer as of one released back to us. The long
   * text settles it: "Envío pendiente de devolución" is a return starting.
   *
   * Scoped to this wording rather than applied to any long text mentioning a
   * return, because the long text is prose: "se procede a la devolución del
   * envío" appears on events that are already handled by their phase, and a
   * blanket substring match over Correos' sentences is how a rule starts
   * catching things nobody checked.
   */
  if (key === UNHELD && longText && normaliseDesc(longText).includes(UNHELD_MEANS_RETURN)) {
    return { state: 'returning', via: 'return-text' };
  }

  if (BY_DESCRIPTION[key]) return { state: BY_DESCRIPTION[key], via: 'description' };

  const alias = DESCRIPTION_ALIASES[key];
  if (alias && BY_DESCRIPTION[alias]) return { state: BY_DESCRIPTION[alias], via: 'description' };

  if (phase) {
    const byPhase = BY_PHASE[normalisePhase(phase)];
    if (byPhase) return { state: byPhase, via: 'phase' };
  }

  return null;
}

/**
 * The state alone, for callers that do not care how it was reached.
 *
 * Anything deciding whether a human should look at the event wants
 * `matchCorreosEvent` instead: this cannot tell a recognised event from one
 * rescued by its phase.
 */
export function mapCorreosEvent(
  code: string | null | undefined,
  desc: string,
  phase?: string | null,
  longText?: string | null,
): ShipmentState | null {
  return matchCorreosEvent(code, desc, phase, longText)?.state ?? null;
}

/**
 * Is this event one a human should still look at?
 *
 * True when nothing matched, and when only the coarse phase did: the phase
 * keeps the parcel moving, but the code and the wording are still unknown to
 * us and that is exactly what the review queue is for.
 *
 * A DEVOLUCION match is the one that needs a second thought. It is queued when
 * the event is otherwise unknown — a return wording nobody here has seen is
 * worth collecting — and NOT queued when we already recognise the code or the
 * wording, because then there is nothing new to learn. Without that, the
 * twenty-nine "Dirección incorrecta" events this rule was written for would
 * each file a queue entry for a wording that has been in the table since the
 * first week.
 *
 * A `return-text` match is not queued: the long text told us plainly what the
 * event meant, which is the whole reason the rule exists. Every other
 * Desestacionado still falls through to null, and still queues.
 */
export function needsReview(
  code: string | null | undefined,
  desc: string,
  phase?: string | null,
  longText?: string | null,
): boolean {
  const match = matchCorreosEvent(code, desc, phase, longText);
  if (match === null) return true;
  if (match.via === 'phase') return true;
  if (match.via === 'return-phase') return !recognised(code, desc);
  return false;
}

/** Every wording we claim to understand. Used by the tests and the docs. */
export function knownDescriptions(): string[] {
  return [...Object.keys(BY_DESCRIPTION), ...Object.keys(DESCRIPTION_ALIASES)];
}

/** Every event code confirmed against real traffic. For the tests and docs. */
export function knownCodes(): string[] {
  return Object.keys(BY_CODE);
}
