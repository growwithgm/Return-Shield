import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { notifications, tasks } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runShipment } from '@/lib/escalation/run';
import { setSetting } from '@/lib/settings';
import { setMessageProvider, messageProvider } from '@/lib/messaging';
import { integrationStatus } from '@/lib/integrations';
import { nextAction, type DecidableShipment } from '@/lib/escalation/decide';
import { restockTexts } from '@/lib/views/rows';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * Nothing on the screen pretends.
 *
 * The operator has to be able to see exactly how far the system really goes,
 * and a control that does nothing in today's set-up makes that impossible. On
 * 7 October the Step 1 / Step 2 switch in the top bar was flipped back and
 * forth several times and nothing changed, because Step 2 also needs a
 * WhatsApp provider that can send and `WHATSAPP_PROVIDER` is `none`.
 *
 * So the switch is gone, two Connections rows that only ever said "not set up"
 * are gone, the two push jobs are off the schedule, and the restock buttons
 * say "Mark as" rather than claiming to move Shopify's stock. Every code path
 * behind them is intact; this file is what stops one of them coming back on
 * screen before it works.
 */

/** A file with its comments taken out — the notes explain what was removed. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

let clock: InstanceType<typeof TestClock>;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T10:00:00+02:00');
  clock.install();
  setMessageProvider(null);
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.CORREOS_PUSH_CLIENT_ID;
  delete process.env.CORREOS_PUSH_CLIENT_SECRET;
  delete process.env.SMTP_HOST;
  delete process.env.MAIL_TO;
});

afterAll(async () => {
  resetClock();
  setMessageProvider(null);
  await closeDb();
});

describe('the top bar', () => {
  it('has no Step switch', () => {
    const src = codeOf('components/TopBar.tsx');
    expect(src).not.toContain('setPhase');
    expect(src).not.toContain('Step 1');
    expect(src).not.toContain('Step 2');
    // And no prop for it either, so the layout cannot pass one by accident.
    expect(src).not.toContain('phase');
  });

  it('has no action behind it any more', () => {
    expect(codeOf('app/actions/settings.ts')).not.toContain('export async function setPhase');
  });

  it('says nothing about steps anywhere the operator reads', () => {
    for (const file of [
      'components/TopBar.tsx',
      'components/Tabs.tsx',
      'components/DockTabs.tsx',
      'lib/integrations.ts',
      'lib/escalation/run.ts',
      'lib/escalation/ladder.ts',
    ]) {
      const src = codeOf(file);
      expect(src, file).not.toMatch(/Step [12]/);
    }
  });
});

describe('the escalation tick', () => {
  it('writes the message for a person whatever the stored phase says', async () => {
    const f = await makeShipment();
    // The switch is gone but the number is still in the table, and an old
    // database has it set to 2. The provider is what decides.
    await setSetting('phase', 2);
    expect(messageProvider().canSend).toBe(false);

    await ingestEvent({
      shippingCode: f.shippingCode,
      eventCode: 'H01I350V',
      eventDesc: 'A disposición del destinatario',
      occurredAt: clock.now(),
      source: 'poll',
      officeCode: f.officeCode,
      rawPayload: {},
    });
    await runShipment(f.shipmentId, clock.now());

    const [msg] = await getDb().select().from(notifications)
      .where(eq(notifications.shipmentId, f.shipmentId));
    expect(msg.status).toBe('queued');
    expect(msg.sentAt).toBeNull();

    // And a job for a person to do it, which is the honest outcome.
    const open = await getDb().select().from(tasks).where(eq(tasks.shipmentId, f.shipmentId));
    expect(open.some((t) => t.type === 'contact')).toBe(true);
  });

  it('keeps the code path for a provider that can send', () => {
    // Not removed, only unreachable today. This is the line that brings it
    // back, and it is still there.
    expect(codeOf('lib/escalation/run.ts')).toContain("settings.phase === 2 && provider.canSend");
  });
});

describe('Connections', () => {
  it('has no WhatsApp row while no provider is configured', async () => {
    const rows = await integrationStatus();
    expect(rows.map((r) => r.key)).not.toContain('whatsapp');
  });

  it('shows a WhatsApp row the moment somebody starts configuring one', async () => {
    process.env.WHATSAPP_PROVIDER = 'whatsapp-cloud';
    try {
      const rows = await integrationStatus();
      const wa = rows.find((r) => r.key === 'whatsapp');
      expect(wa?.name).toBe('WhatsApp sending');
      expect(wa?.status).toBe('missing');
      expect(wa?.missingVars).toContain('WHATSAPP_API_TOKEN');
    } finally {
      delete process.env.WHATSAPP_PROVIDER;
    }
  });

  it('has no Correos live push row while push is not configured', async () => {
    const rows = await integrationStatus();
    expect(rows.map((r) => r.key)).not.toContain('correos-push');
  });

  it('shows the push row again once its credentials exist', async () => {
    process.env.CORREOS_PUSH_CLIENT_ID = 'id';
    process.env.CORREOS_PUSH_CLIENT_SECRET = 'secret';
    try {
      const rows = await integrationStatus();
      expect(rows.map((r) => r.key)).toContain('correos-push');
    } finally {
      delete process.env.CORREOS_PUSH_CLIENT_ID;
      delete process.env.CORREOS_PUSH_CLIENT_SECRET;
    }
  });

  it('has an Email row that says Not set up without SMTP', async () => {
    const rows = await integrationStatus();
    const mail = rows.find((r) => r.key === 'email');

    expect(mail).toBeDefined();
    expect(mail!.name).toBe('Email');
    expect(mail!.status).toBe('missing');
    // The failure this row exists for: `logged` counts as delivered, so an
    // alert nobody will ever read is stored as sent and nothing said so.
    expect(mail!.detail).toContain('only go to the logs');
    expect(mail!.missingVars).toEqual(['SMTP_HOST', 'MAIL_TO']);
  });

  it('says Connected once SMTP is really configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.MAIL_TO = 'ops@example.com';
    try {
      const mail = (await integrationStatus()).find((r) => r.key === 'email');
      expect(mail!.status).toBe('ready');
      expect(mail!.detail).toContain('ops@example.com');
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.MAIL_TO;
    }
  });

  it('is partly set up when SMTP_HOST is there and nobody is listed', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    try {
      const mail = (await integrationStatus()).find((r) => r.key === 'email');
      expect(mail!.status).toBe('missing');
      expect(mail!.missingVars).toEqual(['MAIL_TO']);
    } finally {
      delete process.env.SMTP_HOST;
    }
  });
});

describe('the push jobs', () => {
  it('are off the schedule but still exist', async () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string }[];
    };
    const paths = config.crons.map((c) => c.path);
    expect(paths).not.toContain('/api/cron/push-drain');
    expect(paths).not.toContain('/api/cron/push-heartbeat');

    // Receiver and routes untouched: hitting one by hand still works.
    const drain = await import('@/app/api/cron/push-drain/route');
    expect(typeof drain.GET).toBe('function');
    const receiver = await import('@/app/api/webhooks/correos/track/route');
    expect(typeof receiver.POST).toBe('function');
  });

  it('are off the Scheduled jobs list', async () => {
    const { jobHealth } = await import('@/lib/engine-health');
    const jobs = (await jobHealth()).map((j) => j.job as string);
    expect(jobs).not.toContain('push-drain');
    expect(jobs).not.toContain('push-heartbeat');
  });
});

describe('the restock buttons', () => {
  const coming: DecidableShipment = {
    id: 'x',
    state: 'returning',
    officeArrivedAt: null,
    officeName: 'Oficina Madrid Sucursal 12',
    returnedAt: null,
    town: 'Getafe, Madrid',
    customerName: 'Lucía Fernández Ortiz',
    valueCents: 6490,
    paymentMethod: 'cod',
    dropped: false,
    restocked: false,
    redirectPending: false,
    mutedUntil: null,
    openTasks: [],
    lastContactOutcome: null,
  };

  it('say "Mark as back in stock", not "Put back in stock"', () => {
    // All either one does is record the restock here. Shopify's inventory does
    // not move, because the access token is `read_orders` only.
    expect(nextAction(coming)!.label).toBe('Mark as back in stock');
    expect(codeOf('components/RestockAll.tsx')).toContain('Mark as back in stock');
    expect(codeOf('components/RestockAll.tsx')).not.toContain('Put all back in stock');
  });

  it('are still there — the record is what clears the parcel', () => {
    expect(nextAction(coming)!.kind).toBe('restock');
  });
});

describe('the labels stored on a task', () => {
  /*
   * A TASK LABEL IS A STORED STRING, written once and read for as long as the
   * task is open — so it must not promise a state the parcel will have moved
   * past. One of the five `receive_return` labels read "Put back in stock when
   * it lands", written during a call while the parcel was still at a counter,
   * and it was still saying it a fortnight later with the box on the bench: it
   * told the operator to wait for a parcel they were holding.
   *
   * Read as source text rather than by calling the openers, because that is
   * what makes it total: every one of them is checked, including the next one
   * somebody writes.
   */
  const OPENERS = [
    'lib/shipments/ingest.ts',
    'lib/escalation/outcomes.ts',
    'lib/escalation/run.ts',
    'lib/escalation/tasks.ts',
  ];

  /** Every `label:` passed to an openTask call in these files. */
  function labels(): { file: string; label: string }[] {
    return OPENERS.flatMap((file) => {
      const src = codeOf(file);
      const out: { file: string; label: string }[] = [];
      const pattern = /label:\s*'([^']*)'/g;
      for (let m = pattern.exec(src); m; m = pattern.exec(src)) {
        out.push({ file, label: m[1] });
      }
      return out;
    });
  }

  it('is actually finding them — an empty sweep would pass by accident', () => {
    const found = labels();
    expect(found.map((l) => l.label)).toContain('Put back in stock');
    // The five receive_return openers, plus the ladder's own.
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it('promises nothing about where the parcel will be later', () => {
    /*
     * "when it lands", "once it arrives", "on arrival" — each of them is true
     * on the day it is written and false for the rest of the task's life. The
     * parcel's own screens say where it is; a label says what the job is.
     */
    const AGEING = ['when it lands', 'once it arrives', 'on arrival', 'when it arrives'];

    const offenders = labels()
      .filter((l) => AGEING.some((p) => l.label.toLowerCase().includes(p)))
      .map((l) => `${l.file} — "${l.label}"`);

    expect(offenders).toEqual([]);
  });
});

describe('the Correos buttons that only record', () => {
  it('say "Mark", because nothing here talks to Correos', () => {
    const base: DecidableShipment = {
      id: 'x',
      state: 'at_office',
      officeArrivedAt: null,
      officeName: null,
      returnedAt: null,
      town: '',
      customerName: 'Lucía',
      valueCents: 1000,
      paymentMethod: 'prepaid',
      dropped: false,
      restocked: false,
      redirectPending: true,
      mutedUntil: null,
      openTasks: [],
      lastContactOutcome: null,
    };

    // A redirection is arranged by a person, through Mi Oficina or on the
    // phone, and Correos charges for it. The button recorded that and said
    // "Send new address to Correos", with "Tap again — Correos charges" on the
    // confirm: together, that the press itself would arrange and pay for it.
    expect(nextAction(base)!.label).toBe('Mark new address as sent');
    expect(nextAction(base)!.needsConfirm).toBe(true);

    const chasing = {
      ...base,
      redirectPending: false,
      openTasks: [{ type: 'chase_carrier' as const, reason: 'no_updates', label: 'No update for 3 days' }],
    };
    expect(nextAction(chasing)!.label).toBe('Mark as asked Correos');

    const panel = codeOf('components/DangerActions.tsx');
    expect(panel).not.toContain('Send to a new address');
    expect(panel).not.toContain('Correos charges');
  });
});

/**
 * What Today says about the pile coming back.
 *
 * TWO HALVES, AND THE SCREEN HAS TO MEAN THE ONE IT NAMES. Some of these
 * parcels are on a shelf in the building and some are still with Correos.
 * The job is the same for both — log the stock back in — and only one of them
 * can be done this morning, so every sentence that mentions "already here" or
 * "when they land" is a claim about a half that may hold nobody.
 *
 * It held nobody most days. The banner draws whenever the whole pile is more
 * than one parcel, and the sub-line was written out in the page: "The ones
 * already here can be done now", printed whether or not any were. The morning
 * the operator clears the sixty-nine the catch-up is about, the "here" half
 * empties and stays empty until the next return arrives — so from then on the
 * screen sent them to fetch boxes from a shelf that holds none. That is the
 * steady state, not an edge case.
 *
 * Driven straight, without a database: all of this is strings and plurals,
 * and "1 parcels coming back" is what the operator actually reported.
 */
describe('the pile coming back, as Today says it', () => {
  const pile = (n: number, cents: number) =>
    Array.from({ length: n }, () => ({ valueCents: cents }));

  /** Every sentence `restockTexts` can produce, for one shape of the pile. */
  const said = (still: number, here: number): string => {
    const r = restockTexts(pile(still, 6490), pile(here, 6490));
    return [...r.digest, r.line, r.note].join(' | ');
  };

  it('never says a parcel is already here when none is', () => {
    // The steady state: everything that has landed has been put away.
    expect(said(18, 0)).not.toMatch(/already here|here now/);
    expect(said(1, 0)).not.toMatch(/already here|here now/);
  });

  it('never says one is still on its way when none is', () => {
    expect(said(0, 69)).not.toMatch(/when they land|when it lands|as they land/);
    expect(said(0, 1)).not.toMatch(/when they land|when it lands|as they land/);
  });

  it('says both only when both halves hold something', () => {
    const both = restockTexts(pile(18, 4000), pile(69, 6490));
    expect(both.digest).toHaveLength(2);
    expect(both.line).toBe('18 parcels coming back (€720.00) · 69 parcels back with us (€4478.10)');
    expect(both.note).toContain('The ones already here can be done now');
  });

  it('counts the money of each half over that half only', () => {
    const r = restockTexts(pile(2, 1000), pile(3, 2000));
    expect(r.line).toBe('2 parcels coming back (€20.00) · 3 parcels back with us (€60.00)');
    // Not €80.00 twice, and not one total over both: the two answer different
    // questions — what can be put away now, and what is still out there.
    expect(r.line).not.toContain('€80.00');
  });

  it('says "1 parcel", not "1 parcels"', () => {
    // The operator's own words: "1 parcels coming back — €64.90".
    for (const shape of [said(1, 0), said(0, 1), said(1, 1)]) {
      expect(shape).not.toMatch(/\b1 parcels\b/);
      expect(shape).not.toMatch(/\b1 (parcel|parcels) .*\bthey land\b/);
    }
    expect(said(2, 0)).toContain('2 parcels');
    expect(said(2, 0)).not.toMatch(/\bit lands\b/);
  });

  it('says the returned ones are back with us, not coming back', () => {
    // "Coming back" is what sent them to wait for a parcel they could fetch.
    const r = restockTexts([], pile(69, 6490));
    expect(r.digest.join(' ')).toContain('69 parcels back with us');
    expect(r.digest.join(' ')).not.toContain('coming back');
    expect(r.line).not.toContain('coming back');
  });

  it('says nothing at all about an empty pile', () => {
    expect(restockTexts([], [])).toEqual({ digest: [], line: '', note: '' });
  });

  it('is the only place those sentences are written', () => {
    /*
     * The page renders decided strings. It used to filter and sum cents in
     * JSX, and then — once that moved here — still carried the sub-line as
     * literal text, which is how the two came to disagree.
     */
    const page = readFileSync('app/(panel)/today/page.tsx', 'utf8');
    expect(page).toContain('{view.restockLine}');
    expect(page).toContain('{view.restockNote}');
    for (const claim of ['already here', 'back with us', 'coming back', 'to put back in stock']) {
      // Only inside the comment that explains why they are not here.
      const code = page.split('\n').filter((l) => !l.trim().startsWith('*')).join('\n');
      expect(code).not.toContain(claim);
    }
  });
});
