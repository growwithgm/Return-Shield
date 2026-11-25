/**
 * A real trackpub v2 `/search` response.
 *
 * Captured from production on 6 October 2026. Every personal field was blank
 * or null in the capture and is kept that way here — this file is committed to
 * a public repository, and a fixture is not a place for a customer's name or
 * address.
 *
 * It is reproduced field for field, nulls included, because the nulls are the
 * interesting part: `z.string().optional()` rejects null, so a schema written
 * against a tidied-up sample parses the tidied-up sample and fails on the real
 * one. `phase`, `unit`, `location`, `codired` and `sectionCode` all arrive as
 * explicit nulls.
 */

/** The third event's wording is in `summaryText`; `expandedText` is longer. */
export const REAL_SEARCH_RESPONSE: unknown = [
  {
    code: 'PKA6TP9800095100123700D',
    reference1: '#22430',
    reference3: 'MODULO_Shopify/v1.2.99',
    expeditionCode: 'PKA6TP980009510M',
    weight: 2900,
    totalPackage: 1,
    numberPackage: 1,
    deliveryDate: null,
    dateExpiration: null,
    dateCalculated: null,
    remitName: null,
    destiName: null,
    receiverName: null,
    events: [
      {
        eventDate: '06/10/2026',
        eventHours: '16:17:03',
        eventCode: 'A090000V',
        phase: null,
        phaseDes: 'PRE-ADMISIÓN',
        summaryText: 'Prerregistrado',
        expandedText: 'Envío prerregistrado en los sistemas de Correos pendiente de depósito',
        unit: null,
        location: null,
        codired: null,
        sectionCode: null,
        desNipAgent: null,
        turn: null,
        color: null,
        webaction: null,
        paramWebAction: null,
        coordinateX: null,
        coordinateY: null,
      },
      {
        eventDate: '06/10/2026',
        eventHours: '20:13:23',
        eventCode: 'A010000V',
        phaseDes: 'EN CAMINO',
        summaryText: 'Admitido.',
        expandedText: 'El envío ha tenido admisión en origen.',
      },
      {
        eventDate: '06/10/2026',
        eventHours: '20:13:43',
        eventCode: 'P040000V',
        phaseDes: 'EN CAMINO',
        summaryText: 'Clasificado',
        expandedText: 'Envío clasificado en Centro Logístico',
      },
    ],
    error: { codError: 0, desError: '' },
    associatedShipments: [],
  },
];

export const REAL_CODE = 'PKA6TP9800095100123700D';

/** One shipment in the v2 shape, for building batches. */
export function v2Shipment(
  code: string,
  events: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    reference1: null,
    expeditionCode: null,
    events,
    error: { codError: 0, desError: '' },
    associatedShipments: [],
    ...extra,
  };
}

/** One event in the v2 shape. */
export function v2Event(
  eventCode: string,
  summaryText: string,
  phaseDes: string | null = null,
  at: { date?: string; hours?: string } = {},
): Record<string, unknown> {
  return {
    eventDate: at.date ?? '06/10/2026',
    eventHours: at.hours ?? '16:17:03',
    eventCode,
    phase: null,
    phaseDes,
    summaryText,
    expandedText: `${summaryText} (long form)`,
    unit: null,
    location: null,
    codired: null,
    sectionCode: null,
  };
}

/**
 * The response that showed what the system had been missing.
 *
 * Correos' own answer for `PKA6TP9800129340147006H` — Cristina Martínez's
 * parcel, TikTok order 576982410859617218 — with the field nothing here had
 * ever read:
 *
 *   associatedShipments: [{ shipmentCode: 'DXA6TP9800129340128012S' }]
 *
 * That second code is the parcel coming back. Correos created it on 18
 * November at 11:44 and delivered it to our warehouse on the 19th at 09:37,
 * while Return Shield went on showing "Wrong address · Desestacionado, 18
 * Nov", because the original code's last event is the one that starts the
 * return and then it goes quiet for ever.
 *
 * Shortened to the events that matter. Every personal field was blank in the
 * capture and is kept blank: this file is in a public repository.
 */
export const RETURN_STARTED_RESPONSE: unknown = [
  {
    code: 'PKA6TP9800129340147006H',
    reference1: '576982410859617218',
    expeditionCode: 'PKA6TP980012934D',
    totalPackage: 1,
    numberPackage: 1,
    remitName: null,
    destiName: null,
    receiverName: null,
    events: [
      {
        eventDate: '18/11/2026',
        eventHours: '10:00:00',
        eventCode: 'M02E340V',
        phase: null,
        phaseDes: 'SIN FASE',
        summaryText: 'Desestacionado',
        expandedText: 'Envío pendiente de devolución',
      },
      {
        eventDate: '18/11/2026',
        eventHours: '11:44:00',
        eventCode: 'L03D099R',
        phase: null,
        phaseDes: 'DEVOLUCION',
        summaryText: 'Dirección incorrecta',
        expandedText: 'La dirección de destino no es correcta y se procede a la devolución del envío',
      },
    ],
    error: { codError: 0, desError: '' },
    associatedShipments: [{ shipmentCode: 'DXA6TP9800129340128012S' }],
  },
];

/** The parcel's own code, and the one it comes back under. */
export const RETURN_ORIGINAL = 'PKA6TP9800129340147006H';
export const RETURN_CODE = 'DXA6TP9800129340128012S';

/**
 * And the return leg's own answer: the journey to our door, ending delivered.
 *
 * This is the response nobody has yet seen from trackpub — the codes were read
 * off Correos' PUBLIC tracker, which is a different service, and no DX code
 * has been put to `/search` with these credentials. So this fixture is built
 * from the public tracker's eight events rather than captured, and the
 * Settings test is what will confirm the real shape. Said plainly here so
 * nobody mistakes it for a capture.
 */
export const RETURN_LEG_RESPONSE: unknown = [
  {
    code: 'DXA6TP9800129340128012S',
    reference1: null,
    expeditionCode: 'DXA6TP980012934A',
    totalPackage: 1,
    numberPackage: 1,
    events: [
      {
        eventDate: '18/11/2026',
        eventHours: '11:44:00',
        eventCode: 'A090000V',
        phaseDes: 'PRE-ADMISIÓN',
        summaryText: 'Devolución admitida',
        expandedText: 'Devolución admitida',
      },
      {
        eventDate: '18/11/2026',
        eventHours: '19:02:00',
        eventCode: 'P040000V',
        phaseDes: 'EN CAMINO',
        summaryText: 'Clasificado',
        expandedText: 'Envío clasificado en Centro Logístico',
      },
      {
        eventDate: '19/11/2026',
        eventHours: '08:11:00',
        eventCode: 'G01L010V',
        phaseDes: 'EN ENTREGA',
        summaryText: 'Alta en la unidad de reparto',
        expandedText: 'Alta en la unidad de reparto',
      },
      {
        eventDate: '19/11/2026',
        eventHours: '09:37:00',
        eventCode: 'I01E010V',
        phaseDes: 'ENTREGADO',
        summaryText: 'Entregado',
        expandedText: 'Envío entregado',
      },
    ],
    error: { codError: 0, desError: '' },
    associatedShipments: [],
  },
];
