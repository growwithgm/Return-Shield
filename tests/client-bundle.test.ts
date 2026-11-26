import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * No `'use client'` component drags the server into the browser bundle.
 *
 * THIS IS THE GUARD FOR A COMMIT THAT TYPECHECKED AND COULD NOT BUILD.
 *
 * `components/ReturnCatchUp.tsx` is a client component, and it had one line:
 *
 *   import { describeProbe } from '@/lib/shipments/return-leg';
 *
 * A VALUE import, so webpack followed it — and `return-leg.ts` imports the
 * database pool, which imports `node:async_hooks`, which has no browser
 * equivalent. `next build` stopped with
 *
 *   Module build failed: UnhandledSchemeError: Reading from "node:async_hooks"
 *   is not handled by plugins (Unhandled scheme).
 *   Import trace: ./db/index.ts -> ./lib/shipments/return-leg.ts
 *                 -> ./components/ReturnCatchUp.tsx
 *
 * and the same for `node:child_process` (through nodemailer, reached via
 * `lib/alerts`) and `node:crypto`. `npm run typecheck` passed: the import is
 * perfectly well typed, and only the bundler knows it cannot be followed. So
 * the suite could not catch it either, and the commit would have failed on
 * Vercel.
 *
 * The fix was to split the three pure things the component needed into
 * `lib/shipments/return-probe.ts`. This test is what stops the next one.
 *
 * IT READS THE FILES rather than building anything, so it runs wherever the
 * typecheck runs — no database, no bundler, about as fast as reading the tree.
 *
 * TWO THINGS MAKE THE RULE RIGHT RATHER THAN NEARLY RIGHT:
 *
 *   It stops at a `'use server'` boundary. Next replaces such a module with an
 *   RPC reference in the client bundle; its body never crosses. Every client
 *   component in this app calls a server action, and every server action
 *   reaches the database — so a walk that did not stop there would flag all
 *   thirty-nine of them and say nothing about the mistake that happened.
 *
 *   It follows the graph rather than checking a list of forbidden module
 *   names. A denylist of "@/db, lib/shipments/*, lib/alerts, …" would have
 *   caught this one and would not catch the next server module somebody
 *   writes. What is banned here is what actually breaks the build: a `node:`
 *   builtin, and the four packages that only run on a server.
 */

/* ------------------------------------------------------------------ the rule */

/**
 * What cannot be in a browser bundle, and why each one is here.
 *
 * `node:` anything — no browser equivalent, and the exact error above.
 * `postgres` and `drizzle-orm/postgres-js` — the driver; it opens sockets.
 * `nodemailer` — reaches `node:child_process`, which is the second trace.
 * `pg-boss` — the job runner, which is the driver again plus timers.
 * `exceljs` — the export writer; it streams to the filesystem.
 *
 * Deliberately NOT here: `drizzle-orm` and `drizzle-orm/pg-core`, which is
 * what `db/schema.ts` is built from. Pulling the schema into a bundle is a
 * waste rather than a failure, and the day somebody has a real reason to share
 * a type from it, this test should not be the thing standing in the way.
 */
const BANNED_PACKAGE = /^(postgres|nodemailer|pg-boss|exceljs|drizzle-orm\/postgres-js)$/;
const BANNED_BUILTIN = /^node:/;

export interface Offence {
  file: string;
  /** The import chain, as the bundler would report it. */
  chain: string;
  /** What it ends at. */
  reaches: string;
}

/**
 * Comments taken out before any import is read.
 *
 * The notes in this very file name `@/lib/shipments/return-leg` and
 * `node:async_hooks` in order to explain the bug, and the files it guards do
 * the same. A check that failed on the explanation of the thing it guards
 * against would teach people to delete the explanation.
 *
 * Block comments are blanked rather than removed so a reported line number
 * still points at the real line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

/** True for a file whose first real statement is `directive`. */
function hasDirective(source: string, directive: 'use client' | 'use server'): boolean {
  const head = source
    .replace(/^﻿/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trimStart();

  return new RegExp(`^(['"])${directive}\\1\\s*;?`).test(head);
}

/**
 * Every module specifier this file imports a VALUE from.
 *
 * `import type { X } from '…'` and `import { type X } from '…'` are erased at
 * compile time and reach no bundle, so they are not imports for this purpose —
 * which is the whole reason the split in `return-probe.ts` works and why a
 * component may keep importing its action's result types.
 *
 * A bare `import './x'` counts: a side effect is a value.
 */
export function valueImports(source: string): string[] {
  const code = stripComments(source);
  const out = new Set<string>();

  const withClause = /\bimport\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = withClause.exec(code); m; m = withClause.exec(code)) {
    const clause = m[1];
    // `import type { … }` / `import type X` — the whole statement is erased.
    if (/^type\s/.test(clause.trim())) continue;

    const braces = clause.match(/\{([\s\S]*)\}/);
    const outsideBraces = clause.replace(/\{[\s\S]*\}/, '').replace(/[,\s]/g, '');
    if (braces && !outsideBraces) {
      // Only named specifiers, and every one of them type-only.
      const names = braces[1].split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => /^type\s/.test(n))) continue;
    }
    out.add(m[2]);
  }

  const sideEffect = /^\s*import\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
  for (let m = sideEffect.exec(code); m; m = sideEffect.exec(code)) out.add(m[1]);

  /*
   * And `await import('…')`, which webpack follows into a chunk of its own
   * rather than skipping. `lib/shipments/return-leg.ts` reaches the ingest
   * path exactly this way, so a module whose only server import were dynamic
   * would otherwise read as pure.
   */
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for (let m = dynamic.exec(code); m; m = dynamic.exec(code)) out.add(m[1]);

  return [...out];
}

/** `@/x` and `./x` to a real file on disk; null for a package. */
function fileFor(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(process.cwd(), spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch { /* try the next shape */ }
  }
  return null;
}

/**
 * The chain from `file` to something the browser cannot have, or null.
 *
 * Memoised, because thirty-nine client components share most of their graph.
 * A module being walked is recorded as `pending` so an import cycle ends
 * rather than recurses — a cycle adds no new reach, so null is the right
 * answer for that edge.
 */
const cache = new Map<string, string | null | 'pending'>();

function chainToServer(file: string): string | null {
  const seen = cache.get(file);
  if (seen === 'pending') return null;
  if (seen !== undefined) return seen as string | null;
  cache.set(file, 'pending');

  const source = readFileSync(file, 'utf8');
  const here = relative(process.cwd(), file);

  // The boundary. A server action's body is compiled to an RPC reference, so
  // nothing it imports reaches the browser. Checked after the memo so the
  // module is still walked when something ELSE asks about it from the server
  // side; this function is only ever called from a client root.
  if (hasDirective(source, 'use server')) {
    cache.set(file, null);
    return null;
  }

  let found: string | null = null;

  for (const spec of valueImports(source)) {
    if (BANNED_BUILTIN.test(spec) || BANNED_PACKAGE.test(spec)) {
      found = `${here} -> ${spec}`;
      break;
    }
    const next = fileFor(spec, file);
    if (!next) continue;
    const deeper = chainToServer(next);
    if (deeper) { found = `${here} -> ${deeper}`; break; }
  }

  cache.set(file, found);
  return found;
}

/** Every client component that would break `next build`, and how. */
export function offences(clientFiles: readonly string[]): Offence[] {
  return clientFiles.flatMap((file) => {
    const chain = chainToServer(join(process.cwd(), file));
    if (!chain) return [];
    return [{ file, chain, reaches: chain.slice(chain.lastIndexOf('-> ') + 3) }];
  });
}

/* ----------------------------------------------------------------- the files */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const CLIENT_FILES = ['app', 'components']
  .flatMap((dir) => walk(join(process.cwd(), dir)))
  .filter((f) => hasDirective(readFileSync(f, 'utf8'), 'use client'))
  .map((f) => relative(process.cwd(), f))
  .sort();

/* ------------------------------------------------------------------ the test */

describe('every client component', () => {
  it('is actually being looked at — an empty sweep would pass by accident', () => {
    // The two that matter most: the card that broke the build, and the phone,
    // which is the largest client component in the app.
    expect(CLIENT_FILES).toContain('components/ReturnCatchUp.tsx');
    expect(CLIENT_FILES).toContain('components/scan/ScannerApp.tsx');
    expect(CLIENT_FILES.length).toBeGreaterThanOrEqual(30);
  });

  it('imports no value that reaches the database, the mailer or a node builtin', () => {
    const found = offences(CLIENT_FILES);

    expect(
      found.map((o) => `${o.file}\n    ${o.chain}`),
      'A client component value-imports something only the server can have. '
      + 'Split the pure part into a module of its own — lib/shipments/return-probe.ts '
      + 'is the worked example — or make it an `import type`.',
    ).toEqual([]);
  });

  /*
   * THE NEGATIVE CONTROL, and the reason this file is not a no-op waiting to
   * happen. A rule that has never been seen to fail is a rule that might match
   * nothing at all; this drives it over the exact import that broke the build.
   */
  it('refuses the import that actually broke the build', () => {
    const chain = chainToServer(join(process.cwd(), 'lib/shipments/return-leg.ts'));

    expect(chain).not.toBeNull();
    expect(chain).toContain('lib/shipments/return-leg.ts');
    // Via the database pool, which is what the bundler could not follow.
    expect(chain).toContain('db/index.ts');
  });

  it('allows the module the fix moved those three things into', () => {
    // If `return-probe.ts` ever grows an import that reaches the server, the
    // card breaks the build again and this is what says so first.
    expect(chainToServer(join(process.cwd(), 'lib/shipments/return-probe.ts'))).toBeNull();
  });

  it('counts an erased import as no import at all', () => {
    // This is what makes the rule usable: a component may keep importing the
    // types of whatever its server action returns.
    expect(valueImports("import type { A } from '@/db';")).toEqual([]);
    expect(valueImports("import { type A, type B } from '@/db';")).toEqual([]);
    expect(valueImports("import { type A, b } from '@/db';")).toEqual(['@/db']);
    expect(valueImports("import A from '@/db';")).toEqual(['@/db']);
    expect(valueImports("import A, { type B } from '@/db';")).toEqual(['@/db']);
    expect(valueImports("import '@/db';")).toEqual(['@/db']);
    expect(valueImports("import * as A from '@/db';")).toEqual(['@/db']);
    // A dynamic import is followed too: webpack gives it a chunk, not a pass.
    expect(valueImports("const x = await import('@/db');")).toEqual(['@/db']);
    // And the long notes in these files are not imports.
    expect(valueImports("/* import { x } from '@/db' */")).toEqual([]);
    expect(valueImports("// import { x } from '@/db'")).toEqual([]);
  });

  it('stops at a server action, which is a boundary and not a leak', () => {
    // Every client component in this app calls one, and every one of them
    // reaches the database. A rule without this would flag all of them.
    const action = join(process.cwd(), 'app/actions/returns.ts');
    expect(hasDirective(readFileSync(action, 'utf8'), 'use server')).toBe(true);
    expect(chainToServer(action)).toBeNull();
  });
});
