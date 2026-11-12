/**
 * `funnelchat api list` and `funnelchat api <function>`: every operation of the spec the CLI carries, from
 * the catalog `npm run generate` writes from spec/funnelchat.json (src/generated/operations.ts). Nothing here
 * is written for one operation: a function the spec adds is one `api` lists and calls, and one it drops is gone.
 *
 * The rules are the rest of the CLI's: the key as always; anything but a `GET` is a write, sent once and never
 * retried; an error carries its `X-Request-Id`; a listing pages with `--page`/`--cursor`, or `--all`.
 * What cannot be undone (`x-fc-destructive: true`), and a `DELETE` the spec does not mark either way, asks
 * for confirmation first, unless `--yes`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Command, Option } from 'commander';
import type { Context, Stdin } from '../context.js';
import { CliError, ExitCode, InterruptedError, isRecord, usageError } from '../errors.js';
import { categories, operations, OPERATIONS_SOURCE, type CategoryInfo, type OperationInfo, type ParamInfo } from '../generated/operations.js';
import { mergeNext } from '../http/client.js';
import { interpolatePath } from '../http/url.js';
import { readAll } from './account.js';
import { collect } from './common.js';

type Action = (ctx: Context, command: Command, ...args: unknown[]) => Promise<void> | void;
type Wrap = (fn: Action) => (...args: unknown[]) => Promise<void>;

/** A type as the catalog gives it: `integer`, `string|integer`, `array` of `items`, `any`. */
interface Typed {
  readonly type: string;
  readonly items?: string;
  readonly nullable?: true;
}

const API_HELP = `
Find a function, then call it:
  funnelchat api list                          every function, by group
  funnelchat api list difusiones               only those that mention a text (name, path, group, summary)
  funnelchat api broadcast.index --help        what one takes: its options and its body fields
  funnelchat api broadcast.index --perPage 50 --all
  funnelchat api message.sendMessage --field device_id=3 --field phone=5491122334455 --field text="Hola"

Path and query parameters are options (--broadcast 12); the JSON body goes as --field key=value (repeatable)
and/or --body @file.json. The answer is printed as JSON. A function that is not a GET is a write: it is sent
once and never retried. One that cannot be undone asks for confirmation; --yes skips it.`;

/** Adds `api`, `api list` and one hidden command per operation of the catalog. */
export function addApiCommands(program: Command, action: Wrap): Command {
  const api = program
    .command('api')
    .usage('list [text...] | <function> [options]')
    .description(`Every function of the Funnelchat API (${operations.length}, from the spec this CLI carries): list them, and call any of them.`)
    .argument('[function]', 'The function to call, as `funnelchat api list` names it.')
    .allowUnknownOption()
    .addHelpText('after', API_HELP)
    .action(action((ctx, command, name) => unknownFunction(ctx, command, name as string | undefined)));

  api
    .command('list')
    .argument('[text...]', 'Only the functions that mention every word (in the name, method, path, group or what it does).')
    .description('Lists the functions, by group, with their method, path and what they do.')
    .action(action((ctx, _command, words) => apiList(ctx, (words as string[] | undefined) ?? [])));

  for (const op of operations) addOperation(api, op, action);
  return api;
}

function addOperation(api: Command, op: OperationInfo, action: Wrap): void {
  const command = api.command(op.name, { hidden: true }).description([op.summary ?? op.name, op.purpose].filter(Boolean).join('\n\n'));
  const options = new Map<ParamInfo, Option>();
  for (const param of op.params) {
    const option = new Option(`--${param.option} <${placeholder(param)}>`, paramHelp(param));
    if (isArray(param)) option.argParser(collect);
    if (param.in === 'path') option.makeOptionMandatory();
    command.addOption(option);
    options.set(param, option);
  }
  if (op.body) {
    command.option('--field <key=value>', 'A field of the JSON body (repeatable); typed as the spec says: 3 is a number, true a boolean, [..] or {..} JSON.', collect);
    command.option('--body <json>', 'The whole JSON body: inline, @file.json, or @- for standard input. --field adds to it.');
  }
  if (op.pagination !== 'none') command.option('--all', 'Every page, from the first: the items of all of them, in one JSON array.');
  command.option('-y, --yes', 'Does not ask for confirmation before what cannot be undone.');
  command.addHelpText('after', () => operationHelp(op));
  command.action(
    action((ctx, cmd) => {
      const opts = cmd.opts();
      const path: Record<string, string> = {};
      const query: Record<string, unknown> = {};
      for (const [param, option] of options) {
        const raw: unknown = opts[option.attributeName()];
        if (raw === undefined) continue;
        if (param.in === 'path') path[param.name] = String(raw);
        else query[param.name] = queryValue(param, raw as string | string[]);
      }
      return apiCall(ctx, op, {
        path,
        query,
        fields: (opts.field as string[] | undefined) ?? [],
        body: opts.body as string | undefined,
        all: opts.all === true,
        yes: opts.yes === true,
      });
    }),
  );
}

// --- api list ------------------------------------------------------------------------------------

const categoryById = new Map<string, CategoryInfo>(categories.map((c) => [c.id, c]));

/** The category of an operation, with its title and link (`x-fc-categorias`). */
function categoryOf(op: OperationInfo): CategoryInfo | null {
  return op.category === null ? null : (categoryById.get(op.category) ?? null);
}

export function apiList(ctx: Context, words: string[]): void {
  const terms = fold(words.join(' ')).split(/\s+/).filter(Boolean);
  const found = operations.filter((op) => {
    const haystack = fold([op.name, op.method, op.path, op.summary, op.purpose, op.category, categoryOf(op)?.title, op.group, op.tag].filter(Boolean).join(' '));
    return terms.every((term) => haystack.includes(term));
  });
  const data = {
    spec: OPERATIONS_SOURCE,
    filter: words.length ? words.join(' ') : null,
    count: found.length,
    categories: categories
      .map((c) => ({ ...c, count: found.filter((op) => op.category === c.id).length }))
      .filter((c) => c.count > 0),
    functions: found.map((op) => ({
      name: op.name,
      method: op.method,
      path: op.path,
      summary: op.summary,
      purpose: op.purpose,
      category: op.category,
      category_title: categoryOf(op)?.title ?? null,
      group: op.group,
      domain: op.domain,
      permission: op.permission,
      destructive: op.destructive,
      asks_confirmation: asksConfirmation(op),
      pagination: op.pagination,
    })),
  };
  ctx.out.result(data, () => {
    if (found.length === 0) return `No function mentions "${words.join(' ')}". \`funnelchat api list\` shows them all.`;
    const nameWidth = Math.max(...found.map((op) => op.name.length));
    const pathWidth = Math.max(...found.map((op) => op.path.length));
    const lines = [
      `${found.length} of ${operations.length} functions${words.length ? ` mention "${words.join(' ')}"` : ''}. What one takes: \`funnelchat api <function> --help\`.`,
    ];
    let section: string | null | undefined;
    let group: string | null | undefined;
    for (const op of found) {
      if (op.category !== section) {
        const category = categoryOf(op);
        lines.push('', category ? `${category.title}${category.url ? ` · ${category.url}` : ''}` : 'Other');
        section = op.category;
        group = undefined;
      }
      if (op.group !== group) {
        lines.push(`  ${op.group ?? 'Other'}`);
        group = op.group;
      }
      const note = asksConfirmation(op) ? '  (asks to confirm)' : '';
      lines.push(`    ${op.name.padEnd(nameWidth)}  ${op.method.padEnd(6)}  ${op.path.padEnd(pathWidth)}  ${op.summary ?? ''}${note}`);
    }
    return lines;
  });
}

// --- api <function> ------------------------------------------------------------------------------

export interface CallInput {
  path: Record<string, string>;
  query: Record<string, unknown>;
  /** `--field key=value`, in order. */
  fields: string[];
  /** `--body`: inline JSON, `@file` or `@-`. */
  body: string | undefined;
  all: boolean;
  yes: boolean;
}

export async function apiCall(ctx: Context, op: OperationInfo, input: CallInput): Promise<void> {
  const body = op.body ? await requestBody(ctx, op, input) : undefined;
  if (input.all && (input.query.page !== undefined || input.query.cursor !== undefined)) {
    throw usageError('--all starts from the first page: it does not go with --page or --cursor.');
  }
  const client = ctx.client();
  if (asksConfirmation(op) && !input.yes) await confirm(ctx, op, input.path);

  if (!input.all) {
    const result = await client.request(op, { path: input.path, query: input.query, ...(body !== undefined ? { body } : {}) });
    if (result === null || result === undefined) ctx.out.note('Done: the API answered with no body.');
    else ctx.out.result(result, () => JSON.stringify(result, null, 2));
    return;
  }

  let query = { ...input.query };
  if (op.pageSize?.max && query[op.pageSize.param] === undefined) query[op.pageSize.param] = op.pageSize.max;
  const items: unknown[] = [];
  for (let pages = 1; ; pages++) {
    const page = await client.page(op, { path: input.path, query });
    items.push(...page.items);
    ctx.out.progress(`page ${pages}: ${items.length} items`);
    if (!page.next) break;
    query = mergeNext(query, page.next);
  }
  ctx.out.result(items, () => JSON.stringify(items, null, 2));
}

/** What asks before it is sent: what the spec marks as not undoable, and a `DELETE` it does not mark either way. */
export function asksConfirmation(op: OperationInfo): boolean {
  return op.destructive === true || (op.destructive === null && op.method === 'DELETE');
}

async function confirm(ctx: Context, op: OperationInfo, path: Record<string, string>): Promise<void> {
  const target = `${op.method} ${interpolatePath(op.path, path)}`;
  const why = op.destructive === true ? 'cannot be undone' : 'deletes, and the spec does not say it can be undone';
  if (!ctx.io.stdin.isTTY) {
    throw new CliError(`${op.name} (${op.summary ?? target}) ${why}: it needs a confirmation, and there is no terminal to give it.`, {
      exitCode: ExitCode.USAGE,
      code: 'confirmation_required',
      hint: `Nothing was sent. If you are sure, run it again with --yes (${target}).`,
    });
  }
  const answer = await promptLine(ctx.io.stdin, ctx.io.stderr, `${op.summary ?? op.name}: ${target}\nIt ${why}. Type "yes" to go ahead: `);
  if (!['yes', 'y'].includes(answer.trim().toLowerCase())) {
    throw new CliError('Not confirmed: nothing was sent.', { exitCode: ExitCode.USAGE, code: 'not_confirmed' });
  }
}

/** Reads one line from the terminal (it shows what is typed). */
function promptLine(stdin: Stdin, stderr: { write(chunk: string): unknown }, question: string): Promise<string> {
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.pause();
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('end');
      if (error) reject(error);
      else resolve(value);
    };
    stdin.setEncoding?.('utf8');
    stdin.on('data', (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\n' || ch === '\r') return finish();
        if (ch === '\u0003') return finish(new InterruptedError());
        value += ch;
      }
    });
    stdin.on('end', () => finish());
    stdin.resume();
  });
}

// --- the body ------------------------------------------------------------------------------------

async function requestBody(ctx: Context, op: OperationInfo, input: CallInput): Promise<unknown> {
  const spec = op.body!;
  let body: unknown = input.body === undefined ? undefined : parseJson(await bodySource(ctx, input.body), '--body');
  if (input.fields.length) {
    if (spec.type === 'array') throw usageError(`The body of ${op.name} is a JSON array: give it whole with --body.`);
    if (body !== undefined && !isRecord(body)) throw usageError('--field adds to a JSON object, and the --body given is not one.');
    const out: Record<string, unknown> = isRecord(body) ? { ...body } : {};
    const accumulated = new Set<string>();
    for (const raw of input.fields) {
      const at = raw.indexOf('=');
      if (at <= 0) throw usageError(`--field takes key=value: ${raw}`);
      const key = raw.slice(0, at);
      const value = raw.slice(at + 1);
      const field = spec.fields.find((f) => f.name === key);
      if (!field && spec.fields.length) {
        throw usageError(`The body of ${op.name} has no field "${key}".`, `Its fields: ${spec.fields.map((f) => f.name).join(', ')}.`);
      }
      const typed: Typed = field ?? { type: 'any' };
      if (typed.type === 'array' && !value.trimStart().startsWith('[') && value !== 'null') {
        // `--field ids=1 --field ids=2` is `[1, 2]`.
        const before = accumulated.has(key) && Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
        out[key] = [...before, typedValue({ type: typed.items ?? 'any' }, value, key)];
        accumulated.add(key);
      } else {
        out[key] = typedValue(typed, value, key);
      }
    }
    body = out;
  }
  // A body the spec requires goes out even when empty, so the API says which fields are missing.
  if (body === undefined && spec.required) body = spec.type === 'array' ? [] : {};
  return body;
}

async function bodySource(ctx: Context, value: string): Promise<string> {
  if (value === '@-') return readAll(ctx.io.stdin);
  if (!value.startsWith('@')) return value;
  const file = resolve(ctx.io.cwd, value.slice(1));
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw usageError(`Could not read the body from ${value.slice(1)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usageError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A `--field` value with the type the spec gives the field: `3` is a number only where it says integer or number. */
function typedValue(typed: Typed, value: string, key: string): unknown {
  const types = typed.type.split('|');
  if (value === 'null' && (typed.nullable || typed.type === 'any')) return null;
  if (typed.type === 'any') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (types.includes('array') || types.includes('object')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) ? types.includes('array') : isRecord(parsed) && types.includes('object')) return parsed;
    } catch {
      // not JSON: another of its types may take it
    }
  }
  if ((types.includes('integer') || types.includes('number')) && /^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (types.includes('number') || Number.isInteger(n)) return n;
  }
  if (types.includes('boolean') && /^(true|false|1|0)$/i.test(value)) return /^(true|1)$/i.test(value);
  if (types.includes('string')) return value;
  throw usageError(`--field ${key} takes ${typeText(typed)}: ${value}`);
}

// --- parameters ----------------------------------------------------------------------------------

function isArray(param: ParamInfo): boolean {
  return param.type === 'array' || param.name.endsWith('[]');
}

/** A query value: `true`/`false` become booleans where the spec says boolean (the query sends them as 1/0). */
function queryValue(param: ParamInfo, raw: string | string[]): unknown {
  const one = (value: string, typed: Typed): unknown => {
    if (typed.type === 'boolean') {
      if (!/^(true|false|1|0)$/i.test(value)) throw usageError(`--${param.option} takes true or false: ${value}`);
      return /^(true|1)$/i.test(value);
    }
    return value;
  };
  if (Array.isArray(raw)) return raw.map((value) => one(value, { type: param.items ?? 'any' }));
  return one(raw, param);
}

/** `<integer>`, `<string>`…: what an option or a field takes, in one word. */
function placeholder(typed: Typed & { readonly name: string }): string {
  const type = typed.type === 'array' || typed.name.endsWith('[]') ? (typed.items ?? 'value') : typed.type;
  return ['integer', 'number', 'boolean', 'string'].includes(type) ? type : 'value';
}

function typeText(typed: Typed): string {
  const base = typed.type === 'array' ? `an array of ${typed.items ?? 'any'}` : typed.type.split('|').join(' or ');
  return typed.nullable ? `${base} or null` : base;
}

function paramHelp(param: ParamInfo): string {
  const parts = [`${param.in === 'path' ? 'In the path' : 'Query'}, ${typeText(param)}`];
  if (param.required) parts.push('required');
  if (isArray(param)) parts.push('repeat it for several');
  if (param.enum?.length) parts.push(`one of: ${param.enum.join(', ')}`);
  return `${parts.join('; ')}.${param.description ? ` ${param.description}` : ''}`;
}

/** What `funnelchat api <function> --help` says after the options. */
function operationHelp(op: OperationInfo): string {
  const lines = ['', `${op.method} ${op.path}`];
  const place = [categoryOf(op)?.title, op.group].filter(Boolean).join(' › ');
  if (place) lines.push(`Group: ${place}`);
  if (op.permission) lines.push(`Permission: ${op.permission}${op.domain ? ` (served by ${op.domain})` : ''}`);
  if (op.method !== 'GET') lines.push('A write: it is sent once and never retried on its own.');
  if (asksConfirmation(op)) {
    lines.push(
      op.destructive === true
        ? 'It cannot be undone: it asks for confirmation first, and without a terminal it needs --yes.'
        : 'It deletes, and the spec does not say it can be undone: it asks for confirmation first, and without a terminal it needs --yes.',
    );
  }
  if (op.pagination !== 'none') {
    const one = op.pagination === 'page' ? '--page <n>' : '--cursor <next_cursor>';
    const size = op.pageSize?.max ? ` (asking for ${op.pageSize.max} per page)` : '';
    lines.push(`It pages${op.pagination === 'cursor' ? ' by cursor' : ''}: ${one} for one page, --all for every page${size}.`);
  }
  if (op.body) {
    const body = op.body;
    lines.push('', `Body (JSON${body.type === 'array' ? ' array' : ''}${body.required ? ', required' : ''}): ${body.type === 'array' ? 'give it with --body.' : 'each field with --field key=value, or all of it with --body @file.json.'}`);
    if (body.fields.length) {
      const width = Math.max(...body.fields.map((f) => f.name.length));
      for (const field of body.fields) {
        const parts = [typeText(field), ...(field.required ? ['required'] : []), ...(field.enum?.length ? [`one of: ${field.enum.join(', ')}`] : [])];
        lines.push(`  ${field.name.padEnd(width)}  ${parts.join('; ')}`);
        if (field.description) lines.push(`  ${' '.repeat(width)}  ${field.description}`);
      }
    }
  }
  const example = [
    `funnelchat api ${op.name}`,
    ...op.params.filter((p) => p.required).map((p) => `--${p.option} <${placeholder(p)}>`),
    ...(op.body?.type === 'array' ? ['--body @body.json'] : (op.body?.fields ?? []).filter((f) => f.required).map((f) => `--field ${f.name}=<${placeholder(f)}>`)),
  ];
  lines.push('', 'Example:', `  ${example.join(' ')}`);
  return lines.join('\n');
}

// --- an unknown function -------------------------------------------------------------------------

function unknownFunction(_ctx: Context, command: Command, name: string | undefined): void {
  if (name === undefined) {
    command.outputHelp();
    return;
  }
  const near = similar(name);
  throw usageError(
    `There is no function "${name}" in the spec this CLI carries.`,
    `${near.length ? `Did you mean ${near.join(', ')}? ` : ''}Find it with \`funnelchat api list <text>\`.`,
  );
}

/** Up to three names close to `name`: the same but for case, a few letters away, or containing it. */
function similar(name: string): string[] {
  const wanted = name.toLowerCase();
  const scored = operations
    .map((op) => {
      const candidate = op.name.toLowerCase();
      const distance = candidate === wanted ? 0 : candidate.includes(wanted) ? 1 : editDistance(candidate, wanted);
      return { name: op.name, distance };
    })
    .filter((c) => c.distance <= Math.max(2, Math.floor(wanted.length / 4)))
    .sort((a, b) => a.distance - b.distance);
  return scored.slice(0, 3).map((c) => c.name);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Lower case and without accents, so `difusion` finds «difusión». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}
