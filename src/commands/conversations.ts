/**
 * `funnelchat conversations export`: the message history of each conversation, in JSONL parts, plus
 * `conversations.jsonl` (one line per conversation) and the manifest.
 *
 * The API has no server-side export and no account-wide message listing, so the CLI walks it:
 *
 * 1. **List.** `GET /api/v1/conversations` (cursor), oldest activity first (`orderBy=asc`): a conversation
 *    that gets a new message while the listing runs moves to the end, so it is reached later instead of
 *    being skipped; repeats are dropped by `contact_id`. With `--contact`, one lookup per contact
 *    (`contactId`).
 * 2. **Messages.** For each conversation, `GET /api/v1/contacts/{contactId}/messages` (cursor, newest
 *    first, as the API orders them: id descending). Rows go to `messages-00001.jsonl`, `-00002`… of up to
 *    `--part-size` rows each (a part closes at a page boundary, so it can run over by up to a page).
 *
 * `--since` goes to both routes as `updated_since`: conversations and messages created or changed since
 * then (the API filters by update date). The API has no "until" filter.
 */
import { readFileSync, rmSync } from 'node:fs';
import { ApiError, CliError, ExitCode, InterruptedError, isRecord, usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import { mergeNext } from '../http/client.js';
import type { PageQuery } from '../http/pagination.js';
import type { Context } from '../context.js';
import { parseSince, timestampForName } from '../dates.js';
import { type FileEntry, PartFile, type PartPosition } from '../export/files.js';
import { baseManifest, type BaseState, ExportSession, type Manifest, quote } from '../export/session.js';
import { VERSION } from '../version.js';
import { idList, positiveInt } from './common.js';
import { countOf, finishExport, formatCount, withResumeHint } from './export-common.js';

export interface ConversationsExportFlags {
  outputDir?: string;
  contact?: string[];
  device?: string;
  since?: string;
  partSize?: string;
  resume?: boolean;
}

interface ConversationsOptions extends Record<string, unknown> {
  contact_ids: number[];
  device_id: number | null;
  since: string | null;
  part_size: number;
}

interface ConversationsState extends BaseState {
  kind: 'conversations';
  options: ConversationsOptions;
  phase: 'list' | 'messages';
  list: { next: PageQuery | null; done: boolean; contact_index: number; file: PartPosition };
  conversations_file: FileEntry | null;
  messages: {
    contact_index: number;
    next: PageQuery | null;
    part_index: number;
    part: PartPosition;
    parts: FileEntry[];
    total: number;
  };
  /** Contacts listed but deleted before their messages were read (404). */
  vanished_contacts: number[];
  observed: { first_message_time: string | null; last_message_time: string | null };
}

const OPTION_NAMES: Record<string, string> = {
  contact: 'contact_ids',
  device: 'device_id',
  since: 'since',
  partSize: 'part_size',
};
export const CONVERSATIONS_FLAG_NAMES = Object.keys(OPTION_NAMES);

const PER_PAGE = 100;
export const DEFAULT_PART_SIZE = 50_000;
const CONVERSATIONS_FILE = 'conversations.jsonl';

export function partName(index: number): string {
  return `messages-${String(index).padStart(5, '0')}.jsonl`;
}

function normalize(flags: ConversationsExportFlags): ConversationsOptions {
  const contactIds = idList(flags.contact, '--contact');
  const deviceId = flags.device ? positiveInt(flags.device, '--device') : null;
  const partSize = flags.partSize ? positiveInt(flags.partSize, '--part-size') : DEFAULT_PART_SIZE;
  return { contact_ids: contactIds, device_id: deviceId, since: flags.since ? parseSince(flags.since) : null, part_size: partSize };
}

export async function conversationsExport(ctx: Context, flags: ConversationsExportFlags, explicitFlags: Set<string>): Promise<void> {
  const resume = flags.resume === true;
  if (resume && !flags.outputDir) throw usageError('--resume needs the --output-dir of the export that was interrupted.');
  const options = normalize(flags);
  const { baseUrl } = ctx.credentials();
  const client = ctx.client();
  const dir = flags.outputDir ?? `funnelchat-conversations-export-${timestampForName(ctx.io.clock())}`;

  const opened = ExportSession.open<ConversationsState>({
    dir,
    cwd: ctx.io.cwd,
    kind: 'conversations',
    resume,
    baseUrl,
    options,
    explicit: new Set([...explicitFlags].map((flag) => OPTION_NAMES[flag]).filter((name): name is string => Boolean(name))),
    initial: () => ({
      state_version: 1,
      kind: 'conversations',
      cli_version: VERSION,
      base_url: baseUrl,
      options,
      started_at: new Date(ctx.io.clock()).toISOString(),
      runs: 1,
      api_calls: 0,
      phase: 'list',
      list: { next: null, done: false, contact_index: 0, file: { offset: 0, rows: 0 } },
      conversations_file: null,
      messages: { contact_index: 0, next: null, part_index: 1, part: { offset: 0, rows: 0 }, parts: [], total: 0 },
      vanished_contacts: [],
      observed: { first_message_time: null, last_message_time: null },
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
  const save = () => {
    state.api_calls = callsBefore + client.requests;
    session.save();
  };
  const checkAbort = () => {
    if (ctx.io.signal?.aborted) throw new InterruptedError();
  };
  const resumeCommand = `funnelchat conversations export --output-dir ${quote(dir)} --resume`;
  let file: PartFile | null = null;

  try {
    ctx.out.progress(resume ? `Resuming the conversations export in ${session.dir}` : `Exporting conversations to ${session.dir}`);

    // 1. The conversations to export.
    if (state.phase === 'list') {
      const resumed = state.list.file.offset === 0 ? PartFile.create(session.path(CONVERSATIONS_FILE)) : PartFile.resume(session.path(CONVERSATIONS_FILE), state.list.file);
      if (resumed instanceof PartFile) {
        file = resumed;
        const seen = new Set(readContactIds(file.partPath, state.list.file.offset));
        if (o.contact_ids.length) {
          for (let i = state.list.contact_index; i < o.contact_ids.length; i++) {
            checkAbort();
            const id = o.contact_ids[i] as number;
            const page = await client.page<Record<string, unknown>>(routes.conversationsList, { query: { contactId: id, perPage: 1 } });
            const conversation = page.items.find((item) => conversationContactId(item) === id);
            if (!conversation) {
              throw new CliError(`Contact ${id} does not exist in the account, or the key cannot see it.`, {
                exitCode: ExitCode.NOT_FOUND,
                code: 'contact_not_found',
                hint: 'Check the id: it is the `id` of GET /api/v1/contacts.',
              });
            }
            if (!seen.has(id)) {
              file.append(`${JSON.stringify(conversation)}\n`, 1);
              seen.add(id);
            }
            file.sync();
            state.list.file = file.position;
            state.list.contact_index = i + 1;
            save();
          }
          state.list.done = true;
          save();
        }
        const baseQuery: Record<string, unknown> = {
          perPage: PER_PAGE,
          orderBy: 'asc',
          ...(o.device_id !== null ? { deviceId: o.device_id } : {}),
          ...(o.since ? { updated_since: o.since } : {}),
        };
        while (!state.list.done) {
          checkAbort();
          const query = state.list.next ? mergeNext(baseQuery, state.list.next) : baseQuery;
          const page = await client.page<Record<string, unknown>>(routes.conversationsList, { query });
          let text = '';
          let rows = 0;
          for (const conversation of page.items) {
            const id = conversationContactId(conversation);
            if (!Number.isSafeInteger(id) || seen.has(id)) continue;
            seen.add(id);
            text += `${JSON.stringify(conversation)}\n`;
            rows++;
          }
          file.append(text, rows);
          file.sync();
          state.list.file = file.position;
          state.list.next = page.next;
          state.list.done = page.next === null;
          save();
          ctx.out.progress(`  conversations: ${formatCount(state.list.file.rows)}`);
        }
        state.conversations_file = file.finalize();
        file = null;
      } else {
        state.conversations_file = resumed;
      }
      state.phase = 'messages';
      save();
    }

    // 2. The messages of each conversation.
    const conversationsFile = state.conversations_file as FileEntry;
    const contactIds = readContactIds(session.path(conversationsFile.path));
    const m = state.messages;

    const rotate = () => {
      if (!file) return;
      m.parts.push(file.finalize());
      file = null;
      m.part_index++;
      m.part = { offset: 0, rows: 0 };
      save();
    };
    const currentPart = (): PartFile => {
      while (!file) {
        const name = session.path(partName(m.part_index));
        const reopened = m.part.offset === 0 ? PartFile.create(name) : PartFile.resume(name, m.part);
        if (reopened instanceof PartFile) {
          file = reopened;
        } else {
          // The run stopped right after publishing this part: record it and start the next one.
          m.parts.push(reopened);
          m.part_index++;
          m.part = { offset: 0, rows: 0 };
          save();
        }
      }
      return file;
    };
    if (m.part.offset > 0) currentPart();
    if (file && (file as PartFile).rows >= o.part_size) rotate();

    for (let i = m.contact_index; i < contactIds.length; i++) {
      const contactId = contactIds[i] as number;
      let messages = 0;
      for (;;) {
        checkAbort();
        const query: Record<string, unknown> = { perPage: PER_PAGE, ...(o.since ? { updated_since: o.since } : {}), ...(m.next ?? {}) };
        let page;
        try {
          page = await client.page<Record<string, unknown>>(routes.contactMessages, { path: { contactId }, query });
        } catch (error) {
          if (error instanceof ApiError && error.status === 404 && error.apiCode !== 'route_not_found') {
            state.vanished_contacts.push(contactId);
            m.next = null;
            break;
          }
          throw error;
        }
        const rows = o.device_id === null ? page.items : page.items.filter((message) => Number(message.device_id) === o.device_id);
        if (rows.length) {
          const part = currentPart();
          part.append(rows.map((message) => `${JSON.stringify(message)}\n`).join(''), rows.length);
          part.sync();
          m.part = part.position;
          for (const message of rows) observe(state, message.time);
        }
        m.total += rows.length;
        messages += rows.length;
        m.next = page.next;
        if (!page.next) m.contact_index = i + 1;
        save();
        if (file && (file as PartFile).rows >= o.part_size) rotate();
        if (!page.next) break;
      }
      m.contact_index = i + 1;
      m.next = null;
      save();
      ctx.out.progress(`  conversation ${formatCount(i + 1)} of ${formatCount(contactIds.length)} (contact ${contactId}): ${countOf(messages, 'message')} · total ${formatCount(m.total)}`);
    }
    if (file) {
      if ((file as PartFile).rows > 0) rotate();
      else {
        // An empty part opened on resume: nothing to publish.
        (file as PartFile).close();
        rmSync((file as PartFile).partPath, { force: true });
        file = null;
      }
    }

    const manifest: Manifest = {
      ...baseManifest(state, [routes.conversationsList, routes.contactMessages], new Date(ctx.io.clock()).toISOString()),
      range: {
        since: o.since,
        until: null,
        observed_first_message_time: state.observed.first_message_time,
        observed_last_message_time: state.observed.last_message_time,
      },
      counts: {
        conversations: contactIds.length,
        messages: m.total,
        message_parts: m.parts.length,
        vanished_contacts: state.vanished_contacts.length,
      },
      files: [conversationsFile, ...m.parts],
      notes: [
        'conversations.jsonl: one conversation per line, as GET /api/v1/conversations returns it (by contact_id, without repeats).',
        'messages-NNNNN.jsonl: one message per line, as GET /api/v1/contacts/{contactId}/messages returns it; conversations in the order of conversations.jsonl and, within each one, from the newest message to the oldest (descending id, the API\'s order).',
        ...(o.since ? ['since is sent as updated_since: conversations and messages created or changed since that date. The API has no "until" filter.'] : []),
        ...(o.device_id !== null
          ? ['device_id picks the conversations on the API side (deviceId) and the messages on the CLI side: the API does not filter messages by number.']
          : []),
        'observed_*_message_time: the time field of the messages, as the API returns it (YYYY-MM-DD HH:MM:SS, without a time zone).',
      ],
    };
    finishExport(
      ctx,
      session,
      manifest,
      `${countOf(contactIds.length, 'conversation')} and ${countOf(m.total, 'message')} in ${countOf(m.parts.length, 'part')}, in ${session.dir}`,
    );
  } catch (error) {
    throw withResumeHint(error, resumeCommand);
  } finally {
    (file as PartFile | null)?.close();
    session.release();
  }
}

/**
 * The contact of a conversation row. The API builds each row with `contact_id` (conversations origin/main
 * @ 3b0326e4f, ConversationController::index selects `contacts.id as contact_id`); the sandbox answers
 * with contact objects, which only have `id`.
 */
export function conversationContactId(row: Record<string, unknown>): number {
  return Number(row.contact_id ?? row.id);
}

/** `contact_id` of each line of a conversations file, up to `limit` bytes. */
function readContactIds(path: string, limit?: number): number[] {
  const content = readFileSync(path).subarray(0, limit).toString('utf8');
  const ids = new Set<number>();
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    const parsed: unknown = JSON.parse(line);
    const id = isRecord(parsed) ? conversationContactId(parsed) : NaN;
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  return [...ids];
}

function observe(state: ConversationsState, time: unknown): void {
  if (typeof time !== 'string' || time === '') return;
  const o = state.observed;
  if (o.first_message_time === null || time < o.first_message_time) o.first_message_time = time;
  if (o.last_message_time === null || time > o.last_message_time) o.last_message_time = time;
}
