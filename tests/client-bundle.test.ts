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

/**
 * Node builtins, WITH AND WITHOUT the `node:` prefix.
 *
 * `/^node:/` alone was a hole. `import { readFileSync } from 'fs'` is the same
 * mistake with a different spelling, and `next build` answers it with
 * `Module not found: Can't resolve 'fs'` — the same class of failure, a
 * different message, and the guard silent. The repo has none today, which is
 * exactly why nothing would have stopped the first.
 */
export const BANNED_BUILTIN = /^(node:|(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(\/|$))/;

/**
 * Modules that are server-only by POLICY rather than by what they import, and
 * so are invisible to the walk.
 *
 * `lib/carriers/correos/trackpub.ts` imports only its own normaliser, the
 * token provider and `lib/env` — nothing banned — so the graph walk reports it
 * clean, and a client component could import `TrackpubClient` and ship the
 * carrier gateway's base URL and request shapes to a browser. The token
 * provider is worse: it mints a bearer token for a live carrier account, and
 * tests/correos-test-button.test.ts exists mostly to prove that token never
 * leaves the server.
 *
 * DELIBERATELY NOT A WIDER LIST. `@/db`, `@/lib/alerts`, `@/lib/mail/*` and
 * every `@/lib/shipments/*` module that reaches the server are already caught
 * by the walk, which is better than naming them: it catches the next one
 * nobody added here. And a blanket `lib/shipments/*` entry would refuse
 * `lib/shipments/return-probe.ts` — the module the fix created precisely so a
 * client component COULD import it. A denylist that forbids the fix is worse
 * than no denylist.
 */
const SERVER_ONLY_MODULES = [
  'lib/carriers/correos/trackpub.ts',
  'lib/carriers/correos/token.ts',
];

/**
 * The stand-in for a dynamic import nobody can resolve statically. Refused
 * rather than followed — see `valueImports`.
 */
export const OPAQUE_DYNAMIC_IMPORT = '<dynamic import with a computed path>';

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
   * `export { x } from './y'` and `export * from './y'`, which are import
   * edges wearing another word. A barrel file is the obvious way to leak
   * through this rule otherwise: one `export * from './server-thing'` in a
   * module a client component imports, and webpack follows it while a walk
   * that only reads `import` statements reports the file clean. There are five
   * such edges in this repo already — `lib/messaging/index.ts` has two.
   *
   * The same type-erasure test applies: `export type { … } from` is erased.
   */
  const reExport = /\bexport\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = reExport.exec(code); m; m = reExport.exec(code)) {
    const braces = m[1].match(/\{([\s\S]*)\}/);
    if (braces) {
      const names = braces[1].split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => /^type\s/.test(n))) continue;
    }
    out.add(m[2]);
  }

  const starExport = /\bexport\s*\*\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g;
  for (let m = starExport.exec(code); m; m = starExport.exec(code)) out.add(m[1]);

  /*
   * And `await import('…')`, which webpack follows into a chunk of its own
   * rather than skipping. `lib/shipments/return-leg.ts` reaches the ingest
   * path exactly this way, so a module whose only server import were dynamic
   * would otherwise read as pure.
   */
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for (let m = dynamic.exec(code); m; m = dynamic.exec(code)) out.add(m[1]);

  /*
   * A dynamic import whose argument is NOT a literal — `import(spec)`, or
   * `import(\`@/lib/${name}\`)`. Webpack does not skip those: given a template
   * with a static prefix it builds a context module and bundles every file
   * matching it, so one such call can pull a whole directory, and any server
   * module in it, into the browser. There are none in this repo today, which
   * is why it has to be refused rather than followed: the walk cannot know
   * where it goes, so the honest answer is to make somebody say.
   */
  const opaque = /\bimport\s*\((?!\s*['"])/g;
  if (opaque.test(code)) out.add(OPAQUE_DYNAMIC_IMPORT);

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

  // Server-only by policy, asked about directly. The sweep never starts here:
  // a `'use client'` file is never on the list. Checking the file itself as
  // well as the files it reaches makes this ONE predicate — "this module, or
  // anything it reaches, belongs to the server" — so the list can be tested by
  // naming a module, instead of by hunting for a file that happens to import
  // one and hoping that import is the first banned edge in it. Ahead of the
  // `'use server'` check because the policy wins: the list names modules that
  // must never be bundled whatever directive they grow later.
  if (SERVER_ONLY_MODULES.includes(here)) {
    cache.set(file, here);
    return here;
  }

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
    if (spec === OPAQUE_DYNAMIC_IMPORT) {
      found = `${here} -> ${spec}`;
      break;
    }
    if (BANNED_BUILTIN.test(spec) || BANNED_PACKAGE.test(spec)) {
      found = `${here} -> ${spec}`;
      break;
    }
    const next = fileFor(spec, file);
    if (!next) continue;
    // No second copy of the policy check here: the recursive call makes it on
    // the resolved path, so `@/…`, a relative hop and a barrel all reach the
    // same verdict, and the chain reads the same either way.
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

  it('counts a re-export, which is an import edge wearing another word', () => {
    /*
     * A barrel file is the obvious way round a rule that only reads `import`
     * statements: one `export * from './server-thing'` in a module a client
     * component imports, and webpack follows it while the walk reports the
     * file clean. Five such edges exist in this repo already.
     */
    expect(valueImports("export { x } from '@/db';")).toEqual(['@/db']);
    expect(valueImports("export * from '@/db';")).toEqual(['@/db']);
    expect(valueImports("export * as db from '@/db';")).toEqual(['@/db']);
    // Erased, so not an edge — which is what makes the return-probe split work.
    expect(valueImports("export type { A } from '@/db';")).toEqual([]);
    expect(valueImports("export { type A, type B } from '@/db';")).toEqual([]);
    expect(valueImports("export { type A, b } from '@/db';")).toEqual(['@/db']);
  });

  it('refuses a dynamic import nobody can resolve, rather than following it', () => {
    /*
     * Given a template with a static prefix webpack builds a context module
     * and bundles every file matching it, so one such call can pull a whole
     * directory — and any server module in it — into the browser. The walk
     * cannot know where it goes, so the honest answer is to make somebody say.
     * There are none in this repo today.
     */
    expect(valueImports('const m = await import(spec);')).toEqual([OPAQUE_DYNAMIC_IMPORT]);
    expect(valueImports('const m = await import(`@/lib/${name}`);')).toEqual([OPAQUE_DYNAMIC_IMPORT]);
    // A literal is resolvable and is followed normally.
    expect(valueImports("const m = await import('@/db');")).toEqual(['@/db']);
  });

  it('refuses the carrier gateway and the token minter by name', () => {
    /*
     * The two modules that are server-only by POLICY rather than by what they
     * import, and so are invisible to the walk: `trackpub.ts` imports only its
     * own normaliser, the token provider and `lib/env`, and the token provider
     * mints a bearer token for a live carrier account.
     */
    expect(chainToServer(join(process.cwd(), 'lib/carriers/correos/trackpub.ts')))
      .toContain('lib/carriers/correos/trackpub.ts');
    expect(chainToServer(join(process.cwd(), 'lib/carriers/correos/token.ts')))
      .toContain('lib/carriers/correos/token.ts');

    /*
     * And NOT a wider list. A blanket `lib/shipments/*` entry — which is how
     * the rule was first described — would refuse `return-probe.ts`, the
     * module the fix created precisely so a client component could import it.
     * A denylist that forbids the fix is worse than no denylist, so the walk
     * does that half of the job.
     */
    expect(chainToServer(join(process.cwd(), 'lib/shipments/return-probe.ts'))).toBeNull();
  });

  it('refuses a node builtin written without its prefix', () => {
    // `import { readFileSync } from 'fs'` is the same mistake as 'node:fs',
    // and `next build` answers it with "Can't resolve 'fs'".
    for (const spec of ['fs', 'crypto', 'child_process', 'async_hooks', 'path']) {
      expect(BANNED_BUILTIN.test(spec), spec).toBe(true);
      expect(BANNED_BUILTIN.test(`node:${spec}`), spec).toBe(true);
    }
    // And does not catch a package that merely starts the same way.
    for (const spec of ['pathe', 'crypto-js', 'fs-extra', 'react', 'next/link']) {
      expect(BANNED_BUILTIN.test(spec), spec).toBe(false);
    }
  });

  it('stops at a server action, which is a boundary and not a leak', () => {
    // Every client component in this app calls one, and every one of them
    // reaches the database. A rule without this would flag all of them.
    const action = join(process.cwd(), 'app/actions/returns.ts');
    expect(hasDirective(readFileSync(action, 'utf8'), 'use server')).toBe(true);
    expect(chainToServer(action)).toBeNull();
  });
});
