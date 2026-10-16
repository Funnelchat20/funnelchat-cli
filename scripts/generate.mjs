#!/usr/bin/env node
/**
 * The single generation script of the CLI (`npm run generate`).
 *
 *   node scripts/generate.mjs                 regenerate src/generated/routes.ts from spec/funnelchat.json
 *   node scripts/generate.mjs --spec <file>   copy a new unified spec into spec/, record where it came
 *                                             from in spec/procedencia.json, then regenerate
 *   node scripts/generate.mjs --check         regenerate in memory and fail if src/generated/* differs
 *
 * Steps:
 *   1. (with --spec) copy the spec and write spec/procedencia.json (repository, branch, commit, sha256).
 *   2. Merge spec/pending.json (routes of unmerged branches) into the snapshot, only while the snapshot
 *      lacks them. The report lists the entries a new snapshot made obsolete.
 *   3. Resolve every route of spec/routes-used.json against the merged spec. A route or a query parameter
 *      the spec does not have fails the generation: the CLI never calls a route it made up.
 *   4. Write src/generated/routes.ts: method, path, domain, permission, pagination shape, perPage ceiling
 *      and, for a pending route, where it comes from.
 *
 * The import step (1) is adapted from funnelchat-node, branch feat/inicial @ de14b86, scripts/generate.mjs.
 * Nothing in src/generated/ is edited by hand.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_FILE = resolve(ROOT, 'spec/funnelchat.json');
const PROVENANCE_FILE = resolve(ROOT, 'spec/procedencia.json');
const PENDING_FILE = resolve(ROOT, 'spec/pending.json');
const USED_FILE = resolve(ROOT, 'spec/routes-used.json');
const OUT_FILE = resolve(ROOT, 'src/generated/routes.ts');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

function parseArgs(argv) {
  const args = { spec: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--spec') args.spec = argv[++i];
    else if (arg.startsWith('--spec=')) args.spec = arg.slice('--spec='.length);
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (args.spec === undefined) throw new Error('--spec necesita la ruta del archivo');
  return args;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function git(cwd, ...args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function countOperations(spec) {
  let n = 0;
  for (const item of Object.values(spec.paths ?? {})) for (const m of HTTP_METHODS) if (item[m]) n++;
  return n;
}

/** Step 1: copy a new spec into the repo and record its provenance. */
function importSpec(source) {
  const sourcePath = resolve(source);
  const bytes = readFileSync(sourcePath);
  const spec = JSON.parse(bytes.toString('utf8'));
  const dir = dirname(sourcePath);
  const top = git(dir, 'rev-parse', '--show-toplevel');
  const relPath = top ? relative(top, sourcePath) : null;
  const tracked = top ? git(top, 'ls-files', '--error-unmatch', relPath) !== null : null;
  const dirty = top ? git(top, 'status', '--porcelain', '--untracked-files=no') : null;

  const provenance = {
    description:
      'De dónde salió spec/funnelchat.json. Lo escribe `npm run generate -- --spec <archivo>`; no lo edites a mano.',
    file: 'spec/funnelchat.json',
    sha256: sha256(bytes),
    bytes: bytes.length,
    source: {
      repository: top ? git(top, 'remote', 'get-url', 'origin') : null,
      path: relPath,
      branch: top ? git(top, 'branch', '--show-current') : null,
      commit: top ? git(top, 'rev-parse', 'HEAD') : null,
      commit_date: top ? git(top, 'log', '-1', '--format=%cI') : null,
      file_tracked_in_git: tracked,
      tracked_files_clean: dirty === null ? null : dirty === '',
      file_modified_at: statSync(sourcePath).mtime.toISOString(),
    },
    imported_at: new Date().toISOString(),
    spec: {
      openapi: spec.openapi ?? null,
      title: spec.info?.title ?? null,
      version: spec.info?.version ?? null,
      paths: Object.keys(spec.paths ?? {}).length,
      operations: countOperations(spec),
      webhooks: Object.keys(spec.webhooks ?? {}).length,
      domains: (spec['x-fc-sources'] ?? []).map((s) => ({
        domain: s.domain,
        sha: s.sha,
        branch: s.branch,
        snapshot_at: s.snapshot_at,
      })),
    },
  };

  mkdirSync(dirname(SPEC_FILE), { recursive: true });
  writeFileSync(SPEC_FILE, bytes);
  writeFileSync(PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`spec: copiada de ${relPath ?? sourcePath} (${provenance.source.branch ?? '?'} @ ${provenance.source.commit?.slice(0, 7) ?? '?'})`);
}

/** Step 2: merge the pending layer into a copy of the snapshot. */
function mergePending(spec, pending) {
  const merged = structuredClone(spec);
  merged.paths ??= {};
  merged.components ??= {};
  merged.components.schemas ??= {};
  const report = { applied: [], superseded: [] };

  for (const [name, schema] of Object.entries(pending.components?.schemas ?? {})) {
    if (merged.components.schemas[name]) {
      throw new Error(`spec/pending.json: el esquema ${name} ya existe en la instantánea; renombralo.`);
    }
    merged.components.schemas[name] = schema;
  }

  for (const [path, item] of Object.entries(pending.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (merged.paths[path]?.[method]) {
        report.superseded.push(label);
        continue;
      }
      merged.paths[path] ??= {};
      merged.paths[path][method] = operation;
      report.applied.push(label);
    }
  }
  return { merged, report };
}

function resolveRef(spec, node) {
  let current = node;
  for (let i = 0; i < 10 && current && typeof current === 'object' && typeof current.$ref === 'string'; i++) {
    const parts = current.$ref.replace(/^#\//, '').split('/');
    current = parts.reduce((acc, key) => (acc ? acc[key] : undefined), spec);
  }
  return current;
}

/** Every `meta` object of the 200 response, wherever it sits (anyOf of array | paginated object). */
function collectMetaKeys(spec, schema, out = new Set(), depth = 0) {
  const node = resolveRef(spec, schema);
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectMetaKeys(spec, child, out, depth + 1);
    return out;
  }
  const meta = node.properties?.meta ? resolveRef(spec, node.properties.meta) : undefined;
  if (meta?.properties) for (const key of Object.keys(meta.properties)) out.add(key);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(node[key])) collectMetaKeys(spec, node[key], out, depth + 1);
  return out;
}

function acceptsPlainArray(spec, schema) {
  const node = resolveRef(spec, schema);
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'array') return true;
  return (node.anyOf ?? node.oneOf ?? []).some((child) => resolveRef(spec, child)?.type === 'array');
}

/** Step 3: resolve one used route against the merged spec. */
function resolveRoute(spec, used, pending) {
  const label = `${used.method} ${used.path}`;
  const operation = spec.paths?.[used.path]?.[used.method.toLowerCase()];
  if (!operation) throw new Error(`${label}: la ruta no está en la especificación ni en spec/pending.json.`);

  const parameters = [...(spec.paths[used.path].parameters ?? []), ...(operation.parameters ?? [])].map((p) => resolveRef(spec, p));
  const queryParams = new Map(parameters.filter((p) => p?.in === 'query').map((p) => [p.name, p]));
  // Some listings declare their size parameter only in the portal's listing note (`x-fc-listing`).
  const listing = operation['x-fc-listing'];
  for (const name of listing?.size_params ?? []) {
    if (!queryParams.has(name)) queryParams.set(name, { name, in: 'query', schema: { type: 'integer', maximum: listing.per_page_max } });
  }

  const schema = operation.responses?.['200']?.content?.['application/json']?.schema;
  const metaKeys = collectMetaKeys(spec, schema);
  const pagination = metaKeys.has('next_cursor') ? 'cursor' : metaKeys.has('current_page') ? 'page' : 'none';

  for (const name of used.query) {
    if (!queryParams.has(name)) throw new Error(`${label}: la especificación no tiene el parámetro de query "${name}".`);
  }

  const perPage = queryParams.get('perPage');
  const perPageMax = perPage?.schema?.maximum ?? operation['x-fc-listing']?.per_page_max ?? null;
  const pendingKey = operation['x-fc-pending'] ?? null;

  return {
    id: used.id,
    method: used.method,
    path: used.path,
    summary: operation.summary ?? null,
    domain: operation['x-fc-domain'] ?? null,
    permission: operation['x-fc-permission'] ?? null,
    pagination,
    plainArray: acceptsPlainArray(spec, schema),
    perPageMax,
    query: used.query,
    pending: pendingKey ? { key: pendingKey, source: pending['x-fc-pending']?.sources?.[pendingKey] ?? null } : null,
  };
}

function render(routes, provenance) {
  const lines = [
    '// Generated by scripts/generate.mjs from spec/funnelchat.json, spec/pending.json and spec/routes-used.json.',
    '// Do not edit by hand: run `npm run generate`.',
    '',
    'export interface RouteInfo {',
    "  readonly id: string;",
    "  readonly method: 'GET';",
    '  readonly path: string;',
    '  readonly summary: string | null;',
    "  /** Domain that serves the route (`x-fc-domain`): accounts and communities have a daily call cap per key. */",
    '  readonly domain: string | null;',
    '  /** Permission the key needs (`x-fc-permission`). */',
    '  readonly permission: string | null;',
    "  readonly pagination: 'page' | 'cursor' | 'none';",
    '  /** The 200 answer may be a plain array (one page with everything). */',
    '  readonly plainArray: boolean;',
    '  readonly perPageMax: number | null;',
    '  readonly query: readonly string[];',
    '  /** Set when the route comes from an unmerged branch (spec/pending.json), not from the snapshot. */',
    '  readonly pending: { readonly key: string; readonly source: string | null } | null;',
    '}',
    '',
    '/** Where spec/funnelchat.json came from (spec/procedencia.json). */',
    `export const SPEC_SOURCE = ${JSON.stringify(
      {
        sha256: provenance?.sha256 ?? null,
        repository: provenance?.source?.repository ?? null,
        branch: provenance?.source?.branch ?? null,
        commit: provenance?.source?.commit ?? null,
        paths: provenance?.spec?.paths ?? null,
      },
      null,
      2,
    )} as const;`,
    '',
    `export const routes = ${JSON.stringify(Object.fromEntries(routes.map((r) => [r.id, r])), null, 2)} as const satisfies Record<string, RouteInfo>;`,
    '',
    'export type RouteId = keyof typeof routes;',
    '',
  ];
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.spec) importSpec(args.spec);
  if (!existsSync(SPEC_FILE)) throw new Error('Falta spec/funnelchat.json: corré `npm run generate -- --spec <archivo>`.');

  const spec = JSON.parse(readFileSync(SPEC_FILE, 'utf8'));
  const provenance = existsSync(PROVENANCE_FILE) ? JSON.parse(readFileSync(PROVENANCE_FILE, 'utf8')) : null;
  const actualHash = sha256(readFileSync(SPEC_FILE));
  if (provenance && provenance.sha256 !== actualHash) {
    throw new Error('spec/funnelchat.json no coincide con el sha256 de spec/procedencia.json: importala con --spec.');
  }
  const pending = existsSync(PENDING_FILE) ? JSON.parse(readFileSync(PENDING_FILE, 'utf8')) : {};
  const used = JSON.parse(readFileSync(USED_FILE, 'utf8')).routes;

  const { merged, report } = mergePending(spec, pending);
  console.log(`pendiente de la especificación: ${report.applied.length} rutas aplicadas (${report.applied.join(', ') || 'ninguna'}).`);
  if (report.superseded.length) {
    console.log('la instantánea ya trae estas rutas de spec/pending.json; se pueden borrar de ahí:');
    for (const label of report.superseded) console.log(`  - ${label}`);
  }

  const routes = used.map((u) => resolveRoute(merged, u, pending));
  const output = render(routes, provenance);

  if (args.check) {
    const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
    if (current !== output) {
      console.error('src/generated/routes.ts no está al día: corré `npm run generate`.');
      process.exit(1);
    }
    console.log('src/generated/routes.ts está al día.');
    return;
  }
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, output);
  console.log(`generado: src/generated/routes.ts (${routes.length} rutas, ${routes.filter((r) => r.pending).length} pendientes)`);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
