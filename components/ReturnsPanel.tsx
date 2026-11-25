import Link from 'next/link';
import type { AwaitedReturn, ReturnRow, ReturnsView } from '@/lib/views/returns';
import { RETURNS_LIMIT } from '@/lib/views/returns';
import { Bilingual, Empty, ScanBadge, Th } from './ui';
import { ReturnsSearch } from './ReturnsSearch';
import { MoveToOutgoing } from './MoveToOutgoing';

/**
 * What came back, in four sections — and the sections are the whole point.
 *
 * It used to have two, split on "did the code match a parcel", and both halves
 * were wrong in a way nobody could see from the screen:
 *
 *   Eighty-two parcels were in the first section that had never come back at
 *   all. On 20 November the warehouse scanned fifty-two in Incoming mode while
 *   Correos still had them out for delivery, and on the 25th thirty more,
 *   every one of them Pre-admisión. Outgoing piles, scanned the wrong way
 *   round. One of them, Paquita's, read "Back in the warehouse · 20 Nov ·
 *   13:16" while Correos were driving it to her.
 *
 *   Five parcels that genuinely HAD come back were in the second section,
 *   filed as strangers — the only `DX` labels in the table. A return travels
 *   under a code of Correos' own and nothing here knew what one was.
 *
 *   And sixty-nine were on neither list. Correos had delivered them back to
 *   our door and nobody scanned them in, so a screen built entirely out of
 *   scans could not show them at all. That is the fourth section, and it is
 *   read from the parcels rather than from the scans.
 *
 * So "Back with us" now needs CONFIRMATION — Correos saying the parcel is
 * coming back or is back, or a return label, which only exists for the journey
 * home. Everything that merely matched a parcel Correos still has in flight is
 * under "Check the direction", with a button to move it.
 *
 * NO CUSTOMER DETAILS ANYWHERE. These rows are built from scans, which carry a
 * code, an order number and a shop and nothing else by design. The fourth
 * section comes from the parcels and is held to the same line: an order
 * number, a shop, and the code to go and look for.
 */
export function ReturnsPanel({ view }: { view: ReturnsView }) {
  return (
    <div className="flex flex-col gap-[14px]">
      <ReturnsSearch
        value={view.q}
        note={`The last ${view.days} days, newest first. A parcel scanned twice — or once on each of its two labels — appears once.`}
      />

      <Section
        title="Back with us"
        note="Correos says it is coming back or is back, or the return label itself was scanned."
        count={view.mineTotal}
        empty={view.q
          ? 'No confirmed return with that number.'
          : 'Nothing confirmed back in yet.'}
        show={view.mine.length > 0}
      >
        <Mine rows={view.mine} />
      </Section>

      {/*
        * The one section whose note says what to DO rather than what it is.
        * Every row in it is a correction waiting to be made, and the operator
        * is the one who makes it — not this code, and not on its own.
        */}
      <Section
        title="Check the direction"
        note="Scanned in, but Correos says these parcels are not coming back. They look like an outgoing pile scanned in Incoming mode."
        count={view.checkTotal}
        empty="Nothing to check."
        show={view.check.length > 0}
      >
        <Check rows={view.check} />
      </Section>

      <Section
        title="Not in Return Shield"
        note="Nothing matched: from before Return Shield, or the order had already been cleaned up."
        count={view.theirsTotal}
        empty={view.q
          ? 'No unmatched return with that number.'
          : 'Everything scanned back in matched a parcel.'}
        show={view.theirs.length > 0}
      >
        <Theirs rows={view.theirs} />
      </Section>

      <Section
        title="Back with us per Correos, never scanned in"
        note="Correos delivered the return to our door and nobody scanned it. Somebody has to find the box."
        count={view.awaitedTotal}
        empty="Nothing waiting."
        show={view.awaited.length > 0}
      >
        <Awaited rows={view.awaited} />
      </Section>
    </div>
  );
}

function Section({
  title, note, count, show, empty, children,
}: {
  title: string;
  note: string;
  count: number;
  /** Whether there is anything to draw. Kept out of here so the section can
   * take rows of any shape — the fourth one is not built from scans. */
  show: boolean;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-[10px]">
        <h2 className="m-0 font-display text-[14px] font-bold text-ink">{title}</h2>
        <span className="tnum text-[13px] font-bold text-muted">{count}</span>
        <span className="text-[11.5px] text-muted">{note}</span>
      </div>

      <div className="mt-[7px]">
        {!show ? (
          <div className="rounded-[5px] border border-line bg-surface"><Empty>{empty}</Empty></div>
        ) : children}
      </div>

      {count > RETURNS_LIMIT && (
        <div className="mt-[6px] text-[11.5px] text-muted">
          The newest {RETURNS_LIMIT} of {count}. Use the search box to find one.
        </div>
      )}
    </section>
  );
}

function Mine({ rows }: { rows: ReturnRow[] }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>Where Correos says it is</Th>
            <Th>Left the warehouse</Th>
            <Th>Came back</Th>
            <Th>Code on the label</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top hover:bg-hover">
              <td className="border-b border-line px-3 py-[10px]">
                {r.shipmentId ? (
                  <Link
                    href={`/parcel/${r.shipmentId}`}
                    prefetch={false}
                    className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
                  >
                    {r.label?.lead ?? r.base}
                  </Link>
                ) : (
                  <span className="text-[13px] font-semibold text-ink">{r.label?.lead ?? r.base}</span>
                )}
                <div className="text-[12.5px] text-muted">{r.label?.note ?? ''}</div>
              </td>

              <td className="min-w-[200px] border-b border-line px-3 py-[10px]">
                {r.status ? (
                  <Bilingual en={r.status.en} es={r.status.es} size={12.5} />
                ) : (
                  /*
                    The parcel itself has gone with the thirty-day window, and
                    the scan outlived it. Said plainly rather than left blank:
                    "we do not know" and "we never knew" are different answers
                    and only one of them means the return is a surprise.
                  */
                  <span className="text-[12.5px] text-muted">
                    Removed after 30 days — the return came back later
                  </span>
                )}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                {r.left
                  ? <ScanBadge mark={r.left} direction="outgoing" />
                  : <span className="text-[12.5px] text-muted">Never scanned out</span>}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                <ScanBadge mark={r.back} direction="incoming" />
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[12.5px] text-ink">
                {/*
                  * The code AS SCANNED, not its 15-character base.
                  *
                  * For a return that is the difference between
                  * "DXA6TP9800129340128012S" — the number Correos answer to,
                  * and the one the operator types into Mi Oficina — and
                  * "DXA6TP980012934", which is useful to nobody. The base was
                  * shown because it was what the row was keyed on; the row is
                  * keyed on the parcel now.
                  */}
                {r.code}
                {r.postalCode && <span className="text-muted"> · CP {r.postalCode}</span>}
                {r.viaReturn && (
                  <div className="font-sans text-[11px] font-semibold text-navy">
                    Return label — Correos only print this for the way back
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Scanned in, but Correos says the parcel is not coming back.
 *
 * Every row is a question with two honest answers, and the screen offers both:
 * move it to Outgoing, or leave it and let Correos catch up. Nothing here is
 * decided automatically — a scan is a person saying they held the box, and the
 * system does not get to overrule that on the strength of a carrier's feed.
 */
function Check({ rows }: { rows: ReturnRow[] }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-warn bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>What Correos says</Th>
            <Th>Scanned in</Th>
            <Th>Code on the label</Th>
            <Th>This went out instead</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top hover:bg-hover">
              <td className="border-b border-line px-3 py-[10px]">
                {r.shipmentId ? (
                  <Link
                    href={`/parcel/${r.shipmentId}`}
                    prefetch={false}
                    className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
                  >
                    {r.label?.lead ?? r.base}
                  </Link>
                ) : (
                  <span className="text-[13px] font-semibold text-ink">{r.label?.lead ?? r.base}</span>
                )}
                <div className="text-[12.5px] text-muted">{r.label?.note ?? ''}</div>
              </td>

              <td className="min-w-[220px] border-b border-line px-3 py-[10px]">
                {r.status && <Bilingual en={r.status.en} es={r.status.es} size={12.5} />}
                {r.doubt && (
                  <div className="mt-[2px] text-[11.5px] leading-[1.4] text-warn">{r.doubt}</div>
                )}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                <ScanBadge mark={r.back} direction="incoming" />
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[12.5px] text-ink">
                {r.code}
                {r.postalCode && <span className="text-muted"> · CP {r.postalCode}</span>}
              </td>

              <td className="border-b border-line px-3 py-[10px]">
                <MoveToOutgoing scanId={r.id} batchId={r.batchId} batchSize={r.batchSize} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Correos brought it back to our door and nobody scanned it in.
 *
 * Sixty-nine of the eighty-seven returns were in this state, and no screen
 * could show them: this one was built entirely out of scans, and there is no
 * scan. The row's job is to get somebody to the box, so it leads with the code
 * Correos delivered it under — that is what is printed on the label on the
 * shelf — and says whether that code came from Correos or was worked out here.
 */
function Awaited({ rows }: { rows: AwaitedReturn[] }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>Where Correos says it is</Th>
            <Th>Correos delivered it back</Th>
            <Th>Look for this code</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.shipmentId} className="align-top hover:bg-hover">
              <td className="border-b border-line px-3 py-[10px]">
                <Link
                  href={`/parcel/${r.shipmentId}`}
                  prefetch={false}
                  className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
                >
                  {r.orderNumber}
                </Link>
                <div className="text-[12.5px] text-muted">{r.storeName}</div>
              </td>

              <td className="min-w-[200px] border-b border-line px-3 py-[10px]">
                <Bilingual en={r.status.en} es={r.status.es} size={12.5} />
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]" title={r.exactWhen}>
                <span className="text-[12.5px] text-ink">{r.when}</span>
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[12.5px] text-ink">
                {r.returnCode}
                <div className="font-sans text-[11px] text-muted">
                  {r.returnCodeSource === 'correos' ? 'named by Correos' : 'worked out from the original'}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Theirs({ rows }: { rows: ReturnRow[] }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Code on the label</Th>
            <Th>Postal code</Th>
            <Th>Came back</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top hover:bg-hover">
              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[13px] font-medium text-ink">
                {r.code}
              </td>
              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[12.5px] text-muted">
                {r.postalCode ?? '—'}
              </td>
              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                <ScanBadge mark={r.back} direction="incoming" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
