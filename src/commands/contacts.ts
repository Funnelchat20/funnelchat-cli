/**
 * `funnelchat contacts export`: every contact of the account, with its tags and custom fields, in CSV
 * or JSONL.
 *
 * Routes (all conversations, no daily cap): `GET /api/v1/contacts` (page numbers, ordered by id
 * ascending so a resume never repeats a row), and, per contact, `GET /api/v1/contacts/{contact}/tags`
 * and `GET /api/v1/contacts/{contact}/custom-fields`: the listing brings neither (conversations
 * origin/main @ 3b0326e4f, ContactController::index only eager-loads whatsappIdentity and leadScore).
 * For CSV, `GET /api/v1/custom-fields` gives one column per custom field of the account.
 */
import { ApiError, InterruptedError, isRecord, usageError } from '../errors.js';
import { routes, type RouteInfo } from '../generated/routes.js';
import type { ApiClient } from '../http/client.js';
import { mergeNext } from '../http/client.js';
import { totalOf, type PageQuery } from '../http/pagination.js';
import type { Context } from '../context.js';
import { parseContactBound, timestampForName } from '../dates.js';
import { CSV_BOM, csvRow } from '../export/csv.js';
import { type FileEntry, PartFile, type PartPosition } from '../export/files.js';
import { baseManifest, type BaseState, ExportSession, type Manifest, quote } from '../export/session.js';
import { VERSION } from '../version.js';
import { idList } from './common.js';
import { countOf, finishExport, formatCount, withResumeHint } from './export-common.js';

export interface ContactsExportFlags {
  outputDir?: string;
  format?: string;
  tag?: string[];
  tagMode?: string;
  createdFrom?: string;
  createdTo?: string;
  onlyWithPhone?: boolean;
  tags?: boolean;
  customFields?: boolean;
  resume?: boolean;
}

interface ContactsOptions extends Record<string, unknown> {
  format: 'csv' | 'jsonl';
  tag_ids: number[];
  tag_mode: 'any' | 'all' | 'exclude' | null;
  created_from: string | null;
  created_to: string | null;
  only_with_phone: boolean;
  with_tags: boolean;
  with_custom_fields: boolean;
}

interface ContactsState extends BaseState {
  kind: 'contacts';
  options: ContactsOptions;
  /** CSV columns of custom fields; `null` until listed. */
  columns: { id: number; name: string }[] | null;
  /** Query of the next page; `null` before the first one. */
  next: PageQuery | null;
  done: boolean;
  last_id: number | null;
  file: PartPosition;
  header_written: boolean;
  api_total_at_start: number | null;
  vanished: number;
  observed: { first_created_at: string | null; last_created_at: string | null };
}

/** Flag name (commander) -> option name in the state. */
const OPTION_NAMES: Record<string, string> = {
  format: 'format',
  tag: 'tag_ids',
  tagMode: 'tag_mode',
  createdFrom: 'created_from',
  createdTo: 'created_to',
  onlyWithPhone: 'only_with_phone',
  tags: 'with_tags',
  customFields: 'with_custom_fields',
};
export const CONTACTS_FLAG_NAMES = Object.keys(OPTION_NAMES);

const BASE_COLUMNS = [
  'id',
  'name',
  'phone',
  'email',
  'whatsapp_id',
  'whatsapp_username',
  'country_code',
  'status',
  'created_at',
  'device_id',
  'adviser_id',
  'active_conversation',
  'unread_messages',
  'favorite',
  'lead_score',
  'lead_score_category',
] as const;

const PER_PAGE = 100;

function normalize(flags: ContactsExportFlags): ContactsOptions {
  const format = (flags.format ?? 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'jsonl') throw usageError(`--format must be csv or jsonl: ${flags.format}`);
  const tagMode = flags.tagMode?.toLowerCase() ?? null;
  if (tagMode !== null && !['any', 'all', 'exclude'].includes(tagMode)) throw usageError(`--tag-mode must be any, all or exclude: ${flags.tagMode}`);
  const tagIds = idList(flags.tag, '--tag');
  if (tagMode !== null && tagIds.length === 0) throw usageError('--tag-mode needs at least one --tag.');
  if (Boolean(flags.createdFrom) !== Boolean(flags.createdTo)) {
    throw usageError('--created-from and --created-to go together: the API needs both.', 'For "from a date until today", put today in --created-to.');
  }
  return {
    format,
    tag_ids: tagIds,
    tag_mode: tagMode as ContactsOptions['tag_mode'],
    created_from: flags.createdFrom ? parseContactBound(flags.createdFrom, '--created-from') : null,
    created_to: flags.createdTo ? parseContactBound(flags.createdTo, '--created-to') : null,
    only_with_phone: flags.onlyWithPhone === true,
    with_tags: flags.tags !== false,
    with_custom_fields: flags.customFields !== false,
  };
}

function listQuery(options: ContactsOptions): Record<string, unknown> {
  return {
    perPage: PER_PAGE,
    orderBy: 'id',
    orderByMethod: 'asc',
    ...(options.tag_ids.length ? { 'tag_ids[]': options.tag_ids } : {}),
    ...(options.tag_mode ? { tag_mode: options.tag_mode } : {}),
    ...(options.created_from ? { created_from: options.created_from, created_to: options.created_to } : {}),
    ...(options.only_with_phone ? { only_with_phone: true } : {}),
  };
}

export async function contactsExport(ctx: Context, flags: ContactsExportFlags, explicitFlags: Set<string>): Promise<void> {
  const resume = flags.resume === true;
  if (resume && !flags.outputDir) throw usageError('--resume needs the --output-dir of the export that was interrupted.');
  const options = normalize(flags);
  const { baseUrl } = ctx.credentials();
  const client = ctx.client();
  const dir = flags.outputDir ?? `funnelchat-contacts-export-${timestampForName(ctx.io.clock())}`;

  const opened = ExportSession.open<ContactsState>({
    dir,
    cwd: ctx.io.cwd,
    kind: 'contacts',
    resume,
    baseUrl,
    options,
    explicit: new Set([...explicitFlags].map((flag) => OPTION_NAMES[flag]).filter((name): name is string => Boolean(name))),
    initial: () => ({
      state_version: 1,
      kind: 'contacts',
      cli_version: VERSION,
      base_url: baseUrl,
      options,
      started_at: new Date(ctx.io.clock()).toISOString(),
      runs: 1,
      api_calls: 0,
      columns: null,
      next: null,
      done: false,
      last_id: null,
      file: { offset: 0, rows: 0 },
      header_written: false,
      api_total_at_start: null,
      vanished: 0,
      observed: { first_created_at: null, last_created_at: null },
    }),
  });
  if ('alreadyComplete' in opened) {
    ctx.out.result({ status: 'already_complete', manifest: opened.alreadyComplete }, () => `The export was already complete: ${opened.alreadyComplete}`);
    return;
  }

  const session = opened.session;
  const state = session.state;
  const o = state.options;
  const callsBefore = state.api_calls;
  const countCalls = () => {
    state.api_calls = callsBefore + client.requests;
  };
  const resumeCommand = `funnelchat contacts export --output-dir ${quote(dir)} --resume`;
  const fileName = o.format === 'csv' ? 'contacts.csv' : 'contacts.jsonl';
  let file: PartFile | null = null;

  try {
    ctx.out.progress(resume ? `Resuming the contacts export in ${session.dir}` : `Exporting contacts to ${session.dir}`);

    if (o.format === 'csv' && o.with_custom_fields && state.columns === null) {
      const columns: { id: number; name: string }[] = [];
      for await (const field of client.all<Record<string, unknown>>(routes.customFieldsList, { query: { perPage: PER_PAGE, orderBy: 'created_at', orderByMethod: 'asc' } })) {
        if (typeof field.id === 'number') columns.push({ id: field.id, name: typeof field.name === 'string' ? field.name : String(field.id) });
      }
      state.columns = columns;
      countCalls();
      session.save();
    }

    const opened = state.file.offset === 0 && !state.header_written ? PartFile.create(session.path(fileName)) : PartFile.resume(session.path(fileName), state.file);
    let entry: FileEntry;
    if (opened instanceof PartFile) {
      file = opened;
      if (o.format === 'csv' && !state.header_written) {
        file.append(CSV_BOM + csvRow(csvHeader(o, state.columns ?? [])), 0);
        file.sync();
        state.header_written = true;
        state.file = file.position;
        session.save();
      }
      const baseQuery = listQuery(o);
      while (!state.done) {
        if (ctx.io.signal?.aborted) throw new InterruptedError();
        const query = mergeNext(baseQuery, state.next ?? { page: 1 });
        const page = await client.page<Record<string, unknown>>(routes.contactsList, { query });
        if (state.api_total_at_start === null) state.api_total_at_start = totalOf(page.body);

        let text = '';
        let rows = 0;
        for (const contact of page.items) {
          const id = typeof contact.id === 'number' ? contact.id : Number(contact.id);
          if (state.last_id !== null && id <= state.last_id) continue;
          const enriched = await enrich(client, contact, id, o);
          if (enriched === null) {
            state.vanished++;
          } else {
            text += o.format === 'csv' ? csvRow(csvValues(enriched, o, state.columns ?? [])) : `${JSON.stringify(enriched)}\n`;
            rows++;
            observe(state, contact.created_at);
          }
          state.last_id = state.last_id === null ? id : Math.max(state.last_id, id);
        }
        file.append(text, rows);
        file.sync();
        state.file = file.position;
        state.next = page.next;
        state.done = page.next === null;
        countCalls();
        session.save();
        ctx.out.progress(`  contacts: ${formatCount(state.file.rows)}${state.api_total_at_start !== null ? ` of ${formatCount(state.api_total_at_start)}` : ''}`);
      }
      entry = file.finalize();
      file = null;
    } else {
      entry = opened;
    }

    const manifest: Manifest = {
      ...baseManifest(state, usedRoutes(o), new Date(ctx.io.clock()).toISOString()),
      range: {
        created_from: o.created_from,
        created_to: o.created_to,
        observed_first_created_at: state.observed.first_created_at,
        observed_last_created_at: state.observed.last_created_at,
      },
      counts: {
        contacts: entry.rows,
        ...(state.api_total_at_start !== null ? { api_total_at_start: state.api_total_at_start } : {}),
        vanished_during_export: state.vanished,
      },
      files: [entry],
      notes: [
        'Contacts ordered by ascending id, as GET /api/v1/contacts pages them (by page number).',
        'If contacts are deleted during the export, paging by page number can skip some: compare counts.contacts with counts.api_total_at_start.',
        ...(o.with_tags ? ['Tags: GET /api/v1/contacts/{contact}/tags, one request per contact (the listing does not include them).'] : []),
        ...(o.with_custom_fields
          ? ['Custom fields: GET /api/v1/contacts/{contact}/custom-fields, one request per contact (the listing does not include them).']
          : []),
        ...(o.format === 'csv'
          ? ["CSV with a UTF-8 BOM and CRLF line endings. A cell that starts with =, +, - or @ (and is not a number) gets a ' in front so the spreadsheet does not run it as a formula."]
          : []),
      ],
    };
    finishExport(ctx, session, manifest, `${countOf(entry.rows, 'contact')} in ${session.path(entry.path)}`);
  } catch (error) {
    throw withResumeHint(error, resumeCommand);
  } finally {
    file?.close();
    session.release();
  }
}

/** The contact with its tags and custom fields; `null` when it was deleted after being listed. */
async function enrich(client: ApiClient, contact: Record<string, unknown>, id: number, o: ContactsOptions): Promise<Record<string, unknown> | null> {
  try {
    const tags = o.with_tags ? await all(client, routes.contactTags, id) : undefined;
    const customFields = o.with_custom_fields ? await all(client, routes.contactCustomFields, id) : undefined;
    return { ...contact, ...(tags ? { tags } : {}), ...(customFields ? { custom_fields: customFields } : {}) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.apiCode !== 'route_not_found') return null;
    throw error;
  }
}

async function all(client: ApiClient, route: RouteInfo, contact: number): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for await (const item of client.all<Record<string, unknown>>(route, { path: { contact }, query: { perPage: PER_PAGE } })) items.push(item);
  return items;
}

function observe(state: ContactsState, createdAt: unknown): void {
  if (typeof createdAt !== 'string' || createdAt === '') return;
  const o = state.observed;
  if (o.first_created_at === null || createdAt < o.first_created_at) o.first_created_at = createdAt;
  if (o.last_created_at === null || createdAt > o.last_created_at) o.last_created_at = createdAt;
}

function csvHeader(o: ContactsOptions, columns: { id: number; name: string }[]): string[] {
  return [...BASE_COLUMNS, ...(o.with_tags ? ['tags', 'tag_ids'] : []), ...columns.map((c) => `custom_field:${c.name}`)];
}

function csvValues(contact: Record<string, unknown>, o: ContactsOptions, columns: { id: number; name: string }[]): unknown[] {
  const leadScore = isRecord(contact.lead_score) ? contact.lead_score : undefined;
  const base = BASE_COLUMNS.map((column) => {
    if (column === 'lead_score') return leadScore?.score;
    if (column === 'lead_score_category') return leadScore?.category;
    return contact[column];
  });
  const tags = Array.isArray(contact.tags) ? (contact.tags as Record<string, unknown>[]) : [];
  const tagCells = o.with_tags ? [tags.map((t) => t.name).join('; '), tags.map((t) => t.id).join(';')] : [];
  const fields = Array.isArray(contact.custom_fields) ? (contact.custom_fields as Record<string, unknown>[]) : [];
  const fieldCells = columns.map((column) => {
    const field = fields.find((f) => f.id === column.id) ?? fields.find((f) => f.name === column.name);
    return field?.value;
  });
  return [...base, ...tagCells, ...fieldCells];
}

function usedRoutes(o: ContactsOptions): RouteInfo[] {
  return [
    routes.contactsList,
    ...(o.with_tags ? [routes.contactTags] : []),
    ...(o.with_custom_fields ? [routes.contactCustomFields] : []),
    ...(o.with_custom_fields && o.format === 'csv' ? [routes.customFieldsList] : []),
  ];
}
