#!/usr/bin/env node
/**
 * The single generation script of the CLI (`npm run generate`).
 *
 *   node scripts/generate.mjs                 regenerate src/generated/routes.ts from spec/funnelchat.json
 *   node scripts/generate.mjs --spec <file>   copy a new unified spec into spec/, record where it came
 *                                             from in spec/procedencia.json, then regenerate
 *   node scripts/generate.mjs --check         regenerate in memory and fail if src/generated/* differs
 *
 * With --spec, when the file is not inside a checkout of the repository it was built from (the spec the
 * portal publishes, downloaded from its URL), say where it came from: `--source key=value` (url, portal_version,
 * repository, path, branch, commit, commit_date, file_tracked_in_git), recorded in spec/procedencia.json as
 * declared, not read from git; `--domain <domain>=<sha>@<branch>@<snapshot_at>` for the snapshot of an area the spec does
 * not date itself (`x-fc-sources` without `sha`); and `--expect-sha256 <hex>` to refuse a file that is not
 * the one announced.
 *
 * Steps:
 *   1. (with --spec) copy the spec and write spec/procedencia.json (repository, branch, commit, sha256).
 *   2. Merge spec/pending.json (routes of unmerged branches) into the snapshot, only while the snapshot
 *      lacks them. The report lists the entries a new snapshot made obsolete.
 *   3. Resolve every route of spec/routes-used.json against the merged spec. A route, a query parameter or
 *      a body field the spec does not have fails the generation: the CLI never calls a route it made up.
 *   4. Write src/generated/routes.ts: method, path, domain, permission, pagination shape, perPage ceiling,
 *      the body fields it sends and, for a pending route, where it comes from.
 *   5. Write src/generated/operations.ts: every operation of spec/funnelchat.json (the snapshot alone, not
 *      spec/pending.json), the catalog `funnelchat api` lists and calls. Its name is the `operationId`; its
 *      group comes from `x-tagGroups`, and its category from the group's `x-fc-categoria`, titled as
 *      `x-fc-categorias` says (or from its `x-fc-bloque`, in a spec without them); its purpose from `x-fc-proposito`; its
 *      confirmation from `x-fc-destructive`; its parameters and top-level body fields, with their types,
 *      from the operation. Nothing is written per operation by hand: a new spec is a new catalog.
 *
 * The import step (1) is adapted from funnelchat-node, branch feat/inicial @ de14b86, scripts/generate.mjs,
 * and its --source, --domain and --expect-sha256 from feat/seguir-un-grupo @ f913feb.
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
const OPERATIONS_FILE = resolve(ROOT, 'src/generated/operations.ts');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];
/** The methods the CLI calls. A write is never retried (src/http/client.ts). */
const USED_METHODS = ['GET', 'POST'];

function parseArgs(argv) {
  const args = { spec: null, check: false, source: {}, domains: {}, expectSha256: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--spec') args.spec = argv[++i];
    else if (arg.startsWith('--spec=')) args.spec = arg.slice('--spec='.length);
    else if (arg === '--source') addSource(args.source, argv[++i]);
    else if (arg === '--domain') addDomain(args.domains, argv[++i]);
    else if (arg === '--expect-sha256') args.expectSha256 = argv[++i]?.toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.spec === undefined) throw new Error('--spec needs the path of the file');
  if ((Object.keys(args.source).length || Object.keys(args.domains).length || args.expectSha256) && !args.spec) {
    throw new Error('--source, --domain and --expect-sha256 go with --spec');
  }
  return args;
}

/**
 * `url` is where the portal publishes it: https://developers-portal.funnelchat.app/specs/funnelchat.json;
 * `portal_version`, the version of the portal that serves it (v0.6.15): the spec does not carry it.
 */
const DECLARABLE_SOURCE_KEYS = new Set(['url', 'portal_version', 'repository', 'path', 'branch', 'commit', 'commit_date', 'file_tracked_in_git']);

/** `--source commit=99928866…`: one field of where the spec came from, declared by whoever imports it. */
function addSource(source, pair) {
  const at = pair?.indexOf('=') ?? -1;
  const key = at > 0 ? pair.slice(0, at) : null;
  if (!key || !DECLARABLE_SOURCE_KEYS.has(key)) {
    throw new Error(`--source takes key=value, with key one of: ${[...DECLARABLE_SOURCE_KEYS].join(', ')}`);
  }
  const value = pair.slice(at + 1);
  source[key] = key === 'file_tracked_in_git' ? value === 'true' : value;
}

/** `--domain accounts=558332bcf@snapshot/v1.5.97@2026-11-04T16:58:11-03:00`. */
function addDomain(domains, pair) {
  const match = /^([a-z-]+)=([0-9a-f]{7,40})@([^@]+)@([^@]+)$/.exec(pair ?? '');
  if (!match) throw new Error('--domain takes <domain>=<sha>@<branch>@<snapshot_at>');
  const [, domain, sha, branch, snapshotAt] = match;
  domains[domain] = { sha, branch, snapshot_at: snapshotAt };
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
function importSpec(source, declared = {}, declaredDomains = {}, expectSha256 = null) {
  const sourcePath = resolve(source);
  const bytes = readFileSync(sourcePath);
  if (expectSha256 && sha256(bytes) !== expectSha256) {
    throw new Error(`${source}: its sha256 is ${sha256(bytes)}, not the expected ${expectSha256}.`);
  }
  const spec = JSON.parse(bytes.toString('utf8'));
  const dir = dirname(sourcePath);
  const top = git(dir, 'rev-parse', '--show-toplevel');
  const relPath = top ? relative(top, sourcePath) : null;
  const tracked = top ? git(top, 'ls-files', '--error-unmatch', relPath) !== null : null;
  const dirty = top ? git(top, 'status', '--porcelain', '--untracked-files=no') : null;

  const provenance = {
    description:
      'Where spec/funnelchat.json came from. Written by `npm run generate -- --spec <file>`; do not edit it by hand.',
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
      domains: (spec['x-fc-sources'] ?? []).map((s) => {
        const given = s.sha ? null : declaredDomains[s.domain];
        return {
          domain: s.domain,
          sha: s.sha ?? given?.sha ?? null,
          branch: s.branch ?? given?.branch ?? null,
          snapshot_at: s.snapshot_at ?? given?.snapshot_at ?? null,
          ...(given ? { declared: true } : {}),
        };
      }),
    },
  };

  const declaredKeys = Object.keys(declared);
  if (declaredKeys.length) {
    Object.assign(provenance.source, declared);
    // What git did not say, it did not check either: only the fields read from a checkout are git's.
    if (!top) provenance.source.tracked_files_clean = null;
    provenance.source.declared = declaredKeys;
    provenance.source.declared_note =
      'The fields in `declared` were given on the command line (`--source`), not read from git: the file was imported from outside a checkout of its repository.';
  }

  mkdirSync(dirname(SPEC_FILE), { recursive: true });
  writeFileSync(SPEC_FILE, bytes);
  writeFileSync(PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`spec: copied from ${relPath ?? sourcePath} (${provenance.source.branch ?? '?'} @ ${provenance.source.commit?.slice(0, 7) ?? '?'})`);
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
      throw new Error(`spec/pending.json: the schema ${name} already exists in the snapshot; rename it.`);
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

/** The top-level fields of a JSON request body schema (through `$ref`, `allOf`, `anyOf` and `oneOf`). */
function bodyFields(spec, schema, out = new Set(), depth = 0) {
  const node = resolveRef(spec, schema);
  if (!node || typeof node !== 'object' || depth > 8) return out;
  for (const key of Object.keys(node.properties ?? {})) out.add(key);
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(node[key])) for (const child of node[key]) bodyFields(spec, child, out, depth + 1);
  return out;
}

/** Step 3: resolve one used route against the merged spec. */
function resolveRoute(spec, used, pending) {
  const label = `${used.method} ${used.path}`;
  if (!USED_METHODS.includes(used.method)) throw new Error(`${label}: the CLI calls only ${USED_METHODS.join(' and ')}.`);
  const operation = spec.paths?.[used.path]?.[used.method.toLowerCase()];
  if (!operation) throw new Error(`${label}: the route is neither in the spec nor in spec/pending.json.`);

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
    if (!queryParams.has(name)) throw new Error(`${label}: the spec has no query parameter "${name}".`);
  }
  const body = used.body ?? [];
  if (body.length && used.method === 'GET') throw new Error(`${label}: a GET sends no body.`);
  const fields = bodyFields(spec, operation.requestBody?.content?.['application/json']?.schema);
  for (const name of body) {
    if (!fields.has(name)) throw new Error(`${label}: the request body in the spec has no field "${name}".`);
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
    body,
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
    '  /** A `POST` is a write: the client never retries it. */',
    "  readonly method: 'GET' | 'POST';",
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
    '  /** The fields of the JSON body the CLI sends (checked against the spec). */',
    '  readonly body: readonly string[];',
    '  /** Set when the route comes from an unmerged branch (spec/pending.json), not from the snapshot. */',
    '  readonly pending: { readonly key: string; readonly source: string | null } | null;',
    '}',
    '',
    '/** Where spec/funnelchat.json came from (spec/procedencia.json). */',
    `export const SPEC_SOURCE = ${JSON.stringify(
      {
        sha256: provenance?.sha256 ?? null,
        url: provenance?.source?.url ?? null,
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

// --- Step 5: the catalog of `funnelchat api` -----------------------------------------------------

/** Names `funnelchat api` keeps for itself: an operation with one of them could not be called. */
const RESERVED_NAMES = new Set(['list', 'help']);
/**
 * Option names the CLI already uses, as commander names their values (`--max-wait` is `maxWait`): global
 * options and those of `funnelchat api <function>`. A parameter called like one of them gets its place as a
 * prefix (`--query-page`), and so does one whose option two parameters of the same operation would share.
 */
const RESERVED_OPTIONS = new Set(['profile', 'baseUrl', 'staging', 'json', 'verbose', 'quiet', 'rate', 'maxWait', 'version', 'help', 'field', 'body', 'yes', 'all']);
/** Query parameters that set the size of a page, in the order the catalog prefers them. */
const PAGE_SIZE_PARAMS = ['perPage', 'per_page', 'pageSize', 'limit'];

/** The option of a parameter: `status[]` is `status`, `filters[0][mode]` is `filters-0-mode`. */
function optionName(name) {
  return name.replace(/\[\]$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** What commander calls the value of `--<option>`: `max-wait` is `maxWait`. */
function attributeName(option) {
  return option.split('-').reduce((name, word) => name + word[0].toUpperCase() + word.slice(1));
}

/** The type of a schema in a few words: `integer`, `string|integer`, `array` of `items`; `any` when it does not say. */
function describeType(spec, schema) {
  const node = resolveRef(spec, schema) ?? {};
  const raw = [];
  const add = (n) => {
    const resolved = resolveRef(spec, n) ?? {};
    if (resolved.type) raw.push(...[resolved.type].flat());
    else if (resolved.const === null) raw.push('null');
  };
  add(node);
  if (!raw.length) for (const key of ['anyOf', 'oneOf']) for (const child of node[key] ?? []) add(child);
  const types = [...new Set(raw.filter((t) => t !== 'null'))];
  const out = { type: types.join('|') || 'any' };
  if (raw.includes('null')) out.nullable = true;
  const itemsNode = types.includes('array') ? resolveRef(spec, node.items) : undefined;
  if (itemsNode) out.items = describeType(spec, itemsNode).type;
  const values = (node.enum ?? itemsNode?.enum ?? []).filter((v) => v !== null).map(String);
  if (values.length) out.enum = [...new Set(values)];
  return out;
}

function described(entry, description) {
  const text = typeof description === 'string' ? description.trim() : '';
  return text ? { ...entry, description: text } : entry;
}

/** The parameters of an operation, each with the option it takes in `funnelchat api <function>`. */
function operationParams(spec, pathItem, operation, pagination, listing) {
  const params = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((p) => resolveRef(spec, p))
    .filter((p) => p && (p.in === 'path' || p.in === 'query'))
    .map((p) => described({ name: p.name, in: p.in, ...describeType(spec, p.schema), ...(p.in === 'path' || p.required ? { required: true } : {}) }, p.description));
  const declared = new Set(params.filter((p) => p.in === 'query').map((p) => p.name));
  const synthetic = (name, type, description) => {
    if (!declared.has(name)) params.push({ name, in: 'query', type, synthetic: true, description });
    declared.add(name);
  };
  // What the listing note (`x-fc-listing`) and the shape of the answer say, when the parameters do not.
  for (const name of listing?.size_params ?? []) synthetic(name, 'integer', `Items per page${listing.per_page_max ? `, up to ${listing.per_page_max}` : ''}.`);
  if (pagination === 'page') synthetic('page', 'integer', 'Page number.');
  if (pagination === 'cursor') synthetic('cursor', 'string', 'The cursor of the page, from the `next_cursor` of the previous one.');

  const taken = new Map();
  for (const p of params) {
    const option = optionName(p.name);
    const attribute = option ? attributeName(option) : '';
    taken.set(attribute, (taken.get(attribute) ?? 0) + 1);
    p.option = option;
  }
  for (const p of params) {
    const attribute = p.option ? attributeName(p.option) : '';
    if (!p.option || RESERVED_OPTIONS.has(attribute) || taken.get(attribute) > 1 || p.option.startsWith('no-')) p.option = `${p.in}-${p.option || 'value'}`;
  }
  const seen = new Set();
  for (const p of params) {
    const attribute = attributeName(p.option);
    if (seen.has(attribute)) throw new Error(`${operation.operationId ?? operation.summary}: two parameters would take the option --${p.option}.`);
    seen.add(attribute);
  }
  return params.map(({ option, ...rest }) => ({ name: rest.name, in: rest.in, option, ...rest }));
}

/** The JSON body of an operation: its type and top-level fields (through `$ref`, `allOf`, `anyOf`, `oneOf`). */
function operationBody(spec, operation) {
  const requestBody = resolveRef(spec, operation.requestBody);
  if (!requestBody) return null;
  const schema = requestBody.content?.['application/json']?.schema;
  const node = resolveRef(spec, schema) ?? {};
  const fields = new Map();
  const required = new Set(node.required ?? []);
  for (const key of ['allOf']) for (const child of node[key] ?? []) for (const name of resolveRef(spec, child)?.required ?? []) required.add(name);
  const walk = (n, depth = 0) => {
    const resolved = resolveRef(spec, n);
    if (!resolved || typeof resolved !== 'object' || depth > 8) return;
    for (const [name, property] of Object.entries(resolved.properties ?? {})) {
      if (!fields.has(name)) fields.set(name, described({ name, ...describeType(spec, property) }, resolveRef(spec, property)?.description));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) for (const child of resolved[key] ?? []) walk(child, depth + 1);
  };
  walk(node);
  return {
    required: requestBody.required === true,
    type: describeType(spec, node).type,
    ...(requestBody.content?.['application/json'] ? {} : { contentTypes: Object.keys(requestBody.content ?? {}) }),
    fields: [...fields.values()].map((f) => (required.has(f.name) ? { ...f, required: true } : f)),
  };
}

/**
 * A name for an operation without `operationId`, from its path and method alone (not from the tag, whose text
 * the portal rewrites): the first fixed segment, then the method and the other fixed segments. `GET /api/v1/me`
 * is `me.get`; `GET /api/v1/devices/{device}/health` would be `devices.getHealth`.
 */
function derivedName(method, path) {
  const words = (segment) => segment.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = (list) => list.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  const [first, ...rest] = path.replace(/^\/api\/v\d+\//, '').split('/').filter((s) => s && !s.startsWith('{'));
  return `${camel(words(first ?? 'api')) || 'api'}.${camel([method, ...rest.flatMap(words)])}`;
}

/**
 * The categories of the portal: `x-fc-categorias` (id, title and link of each, in their order), which each group
 * of `x-tagGroups` names with `x-fc-categoria`. A spec without them has, at most, the `x-fc-bloque` of each group:
 * it is then its own id and title, in the order the groups first name it.
 */
function buildCategories(spec) {
  const categories = (spec['x-fc-categorias'] ?? [])
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => ({ id: c.id, title: typeof c.title === 'string' ? c.title : c.id, url: typeof c.url === 'string' ? c.url : null }));
  const known = new Set(categories.map((c) => c.id));
  for (const group of spec['x-tagGroups'] ?? []) {
    const id = group['x-fc-categoria'] ?? group['x-fc-bloque'];
    if (typeof id === 'string' && !known.has(id)) {
      // A group that names a category `x-fc-categorias` lacks still gets it, titled with its id.
      categories.push({ id, title: id, url: null });
      known.add(id);
    }
  }
  return categories;
}

/** Step 5: every operation of the snapshot, by category and then in the order of the portal's groups. */
function buildOperations(spec, categories) {
  const tagInfo = new Map((spec.tags ?? []).map((t) => [t.name, t]));
  const categoryIndex = new Map(categories.map((c, i) => [c.id, i]));
  const groupOf = new Map();
  (spec['x-tagGroups'] ?? []).forEach((group, groupIndex) => {
    const id = group['x-fc-categoria'] ?? group['x-fc-bloque'] ?? null;
    const category = id === null ? null : categories[categoryIndex.get(id)];
    (group.tags ?? []).forEach((tag, tagIndex) => {
      if (!groupOf.has(tag)) {
        groupOf.set(tag, { group: group.name ?? null, category: category ?? null, order: [category ? categoryIndex.get(id) : Infinity, groupIndex, tagIndex] });
      }
    });
  });

  const operations = [];
  let index = 0;
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const tag = operation.tags?.[0] ?? null;
      const place = tag !== null ? groupOf.get(tag) : undefined;
      const listing = operation['x-fc-listing'];
      let pagination = 'none';
      if (method === 'get') {
        const metaKeys = collectMetaKeys(spec, operation.responses?.['200']?.content?.['application/json']?.schema);
        pagination = metaKeys.has('next_cursor') ? 'cursor' : metaKeys.has('current_page') ? 'page' : 'none';
      }
      const params = operationParams(spec, pathItem, operation, pagination, listing);
      const sizeParam = pagination === 'none' ? undefined : PAGE_SIZE_PARAMS.map((name) => params.find((p) => p.in === 'query' && p.name === name)).find(Boolean);
      const max = sizeParam ? (resolveRef(spec, (operation.parameters ?? []).find((p) => resolveRef(spec, p)?.name === sizeParam.name))?.schema?.maximum ?? listing?.per_page_max ?? null) : null;
      const destructive = operation['x-fc-destructive'];
      operations.push({
        order: [...(place?.order ?? [Infinity, Infinity, Infinity]), index++],
        info: {
          name: operation.operationId ?? derivedName(method, path),
          method: method.toUpperCase(),
          path,
          summary: operation.summary ?? null,
          purpose: operation['x-fc-proposito'] ?? null,
          category: place?.category?.id ?? null,
          group: place?.group ?? null,
          tag: tag === null ? null : (tagInfo.get(tag)?.['x-displayName'] ?? tag),
          domain: operation['x-fc-domain'] ?? null,
          permission: operation['x-fc-permission'] ?? null,
          destructive: typeof destructive === 'boolean' ? destructive : null,
          pagination,
          pageSize: sizeParam ? { param: sizeParam.name, max } : null,
          params,
          body: operationBody(spec, operation),
        },
      });
    }
  }
  const byOrder = (a, b) => a.order.reduce((diff, value, i) => diff || (value === b.order[i] ? 0 : value < b.order[i] ? -1 : 1), 0);
  operations.sort(byOrder);

  const names = new Map();
  for (const { info } of operations) {
    if (RESERVED_NAMES.has(info.name)) throw new Error(`${info.method} ${info.path}: the operation is called "${info.name}", a name \`funnelchat api\` keeps for itself.`);
    if (names.has(info.name)) throw new Error(`${info.method} ${info.path} and ${names.get(info.name)} have the same name, "${info.name}".`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(info.name)) throw new Error(`${info.method} ${info.path}: "${info.name}" is not a name a command can take.`);
    names.set(info.name, `${info.method} ${info.path}`);
  }
  return operations.map((o) => o.info);
}

function renderOperations(operations, categories, provenance) {
  return [
    '// Generated by scripts/generate.mjs from spec/funnelchat.json: the catalog of `funnelchat api`.',
    '// Do not edit by hand: run `npm run generate`.',
    '',
    "export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';",
    '',
    '/** The type of a parameter or a field, as the spec gives it: `integer`, `string|integer`, `array`… `any` when it does not say. */',
    'interface Typed {',
    '  readonly type: string;',
    '  /** The type of the items of an `array`. */',
    '  readonly items?: string;',
    '  readonly nullable?: true;',
    '  readonly enum?: readonly string[];',
    '  readonly required?: true;',
    '  readonly description?: string;',
    '}',
    '',
    'export interface ParamInfo extends Typed {',
    '  readonly name: string;',
    "  readonly in: 'path' | 'query';",
    '  /** The option that takes it: the name without `[]`, or with its place in front if the CLI already uses that name. */',
    '  readonly option: string;',
    '  /** Not among the parameters of the operation: it comes from its pagination or its `x-fc-listing`. */',
    '  readonly synthetic?: true;',
    '}',
    '',
    'export interface FieldInfo extends Typed {',
    '  readonly name: string;',
    '}',
    '',
    '/** A category of the portal (`x-fc-categorias`): «Funciones de WhatsApp», «Funciones de Funnelchat»… */',
    'export interface CategoryInfo {',
    '  readonly id: string;',
    '  readonly title: string;',
    '  /** Its page in the portal. */',
    '  readonly url: string | null;',
    '}',
    '',
    'export interface OperationInfo {',
    '  /** The `operationId` of the spec (derived from the tag, method and path when there is none). */',
    '  readonly name: string;',
    '  readonly method: HttpMethod;',
    '  readonly path: string;',
    '  readonly summary: string | null;',
    '  /** What it is for (`x-fc-proposito`). */',
    '  readonly purpose: string | null;',
    '  /** The id of its category (`x-fc-categoria` of its group): one of {@link categories}. */',
    '  readonly category: string | null;',
    '  /** Its group in the portal (`x-tagGroups`). */',
    '  readonly group: string | null;',
    '  readonly tag: string | null;',
    '  readonly domain: string | null;',
    '  readonly permission: string | null;',
    '  /** `x-fc-destructive`: `true` cannot be undone, `null` when the spec does not say. */',
    '  readonly destructive: boolean | null;',
    "  readonly pagination: 'page' | 'cursor' | 'none';",
    '  /** The query parameter that sets the size of a page, and its ceiling. */',
    '  readonly pageSize: { readonly param: string; readonly max: number | null } | null;',
    '  readonly params: readonly ParamInfo[];',
    '  readonly body: { readonly required: boolean; readonly type: string; readonly contentTypes?: readonly string[]; readonly fields: readonly FieldInfo[] } | null;',
    '}',
    '',
    '/** The spec the catalog was generated from (spec/procedencia.json). */',
    `export const OPERATIONS_SOURCE = ${JSON.stringify(
      { sha256: provenance?.sha256 ?? null, url: provenance?.source?.url ?? null, commit: provenance?.source?.commit ?? null, operations: operations.length },
      null,
      2,
    )} as const;`,
    '',
    '/** The categories, in the portal\'s order. */',
    `export const categories: readonly CategoryInfo[] = ${JSON.stringify(categories, null, 2)};`,
    '',
    '/** Every operation of the spec, by category and then in the order of the portal\'s groups. One per line. */',
    'export const operations: readonly OperationInfo[] = [',
    ...operations.map((o) => `  ${JSON.stringify(o)},`),
    '];',
    '',
  ].join('\n');
}

/** Writes `file`, or with --check fails if it differs. */
function writeOrCheck(file, content, check) {
  const label = relative(ROOT, file);
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current !== content) {
      console.error(`${label} is out of date: run \`npm run generate\`.`);
      return false;
    }
    console.log(`${label} is up to date.`);
    return true;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.spec) importSpec(args.spec, args.source, args.domains, args.expectSha256);
  if (!existsSync(SPEC_FILE)) throw new Error('spec/funnelchat.json is missing: run `npm run generate -- --spec <file>`.');

  const spec = JSON.parse(readFileSync(SPEC_FILE, 'utf8'));
  const provenance = existsSync(PROVENANCE_FILE) ? JSON.parse(readFileSync(PROVENANCE_FILE, 'utf8')) : null;
  const actualHash = sha256(readFileSync(SPEC_FILE));
  if (provenance && provenance.sha256 !== actualHash) {
    throw new Error('spec/funnelchat.json does not match the sha256 in spec/procedencia.json: import it with --spec.');
  }
  const pending = existsSync(PENDING_FILE) ? JSON.parse(readFileSync(PENDING_FILE, 'utf8')) : {};
  const used = JSON.parse(readFileSync(USED_FILE, 'utf8')).routes;

  const { merged, report } = mergePending(spec, pending);
  console.log(`pending spec layer: ${report.applied.length} routes applied (${report.applied.join(', ') || 'none'}).`);
  if (report.superseded.length) {
    console.log('the snapshot already has these routes of spec/pending.json; they can be deleted from there:');
    for (const label of report.superseded) console.log(`  - ${label}`);
  }

  const routes = used.map((u) => resolveRoute(merged, u, pending));
  const output = render(routes, provenance);
  // The catalog of `funnelchat api` comes from the snapshot alone: a pending route is not published yet.
  const categories = buildCategories(spec);
  const operations = buildOperations(spec, categories);
  const catalog = renderOperations(operations, categories, provenance);

  const fresh = [writeOrCheck(OUT_FILE, output, args.check), writeOrCheck(OPERATIONS_FILE, catalog, args.check)];
  if (args.check) {
    if (fresh.includes(false)) process.exit(1);
    return;
  }
  console.log(`generated: src/generated/routes.ts (${routes.length} routes, ${routes.filter((r) => r.pending).length} pending)`);
  console.log(`generated: src/generated/operations.ts (${operations.length} operations for \`funnelchat api\`)`);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
