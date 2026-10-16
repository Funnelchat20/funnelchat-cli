/**
 * Test helpers: a fake Funnelchat account answered by a fake `fetch` (no network), and a way to run the
 * real CLI with fake streams, a fake clock and a temporary folder. The key below has the real shape but
 * is not a credential.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Io } from '../src/context.js';
import { run } from '../src/main.js';

export const TEST_KEY = '7|fc_live_TestOnlyNotARealKey0123456789abcdef01';
export const TEST_SECRET = TEST_KEY.slice(TEST_KEY.indexOf('|') + 1);

export interface FakeRequest {
  method: string;
  url: URL;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

export type FakeReply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;
export type Hook = (request: FakeRequest, index: number) => FakeReply | undefined | void;

/** A `fetch` that answers from `handler` and records every request. */
export function fakeFetch(handler: (request: FakeRequest) => FakeReply) {
  const calls: FakeRequest[] = [];
  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: FakeRequest = { method: init.method ?? 'GET', url, path: url.pathname, query: url.searchParams, headers };
    calls.push(request);
    const reply = handler(request);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const body = reply.body === undefined || status === 204 ? null : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...reply.headers } });
  };
  return { fetch: fetchFn as unknown as typeof fetch, calls };
}

// --- a fake account -----------------------------------------------------------------------------

export interface FakeContact {
  id: number;
  name: string;
  phone: string;
  created_at: string;
  tags: { id: number; name: string }[];
  fields: { id: number; name: string; value: string }[];
  messages: number;
  device_id: number;
}

export class FakeAccount {
  contacts: FakeContact[] = [];
  base = 'https://api.funnelchat.com';
  /** Runs before the default answer; return a reply to replace it. */
  hooks: Hook[] = [];
  requests = 0;

  constructor(options: { contacts?: number; messagesPerContact?: (id: number) => number } = {}) {
    const n = options.contacts ?? 5;
    for (let i = 1; i <= n; i++) {
      const id = 1000 + i;
      this.contacts.push({
        id,
        name: i === 2 ? '=HYPERLINK("http://malo")' : `Contacto ${i}`,
        phone: `54911000${String(i).padStart(5, '0')}`,
        created_at: `2026-10-${String(1 + (i % 9)).padStart(2, '0')}T12:00:00.000000Z`,
        tags: i % 2 === 0 ? [{ id: 1, name: 'Cliente' }] : [],
        fields: i % 3 === 0 ? [{ id: 11, name: 'ciudad', value: 'Rosario, "centro"' }] : [],
        messages: options.messagesPerContact ? options.messagesPerContact(id) : 3,
        device_id: i % 2 === 0 ? 3 : 4,
      });
    }
  }

  hook(fn: Hook): this {
    this.hooks.push(fn);
    return this;
  }

  fetch() {
    return fakeFetch((request) => this.answer(request));
  }

  messagesOf(contact: FakeContact): Record<string, unknown>[] {
    return Array.from({ length: contact.messages }, (_, k) => ({
      id: contact.id * 1000 + k + 1,
      contact_id: contact.id,
      device_id: k % 2 === 0 ? contact.device_id : 99,
      text: `mensaje ${k + 1} de ${contact.id}`,
      own: k % 2,
      time: `2026-10-${String(1 + (k % 28)).padStart(2, '0')} 10:00:00`,
    })).sort((a, b) => (b.id as number) - (a.id as number));
  }

  answer(request: FakeRequest): FakeReply {
    const index = this.requests++;
    for (const hook of this.hooks) {
      const reply = hook(request, index);
      if (reply) return reply;
    }
    if (request.headers.authorization !== `Bearer ${TEST_KEY}`) return { status: 401, body: { error: 'unauthenticated', message: 'Falta la API key o no es válida.' } };
    const q = request.query;
    const p = request.path;
    let m: RegExpExecArray | null;

    if (p === '/api/v1/me') {
      return { body: { id: '42', name: 'Cuenta de prueba', email: 'dueno@example.com', role: 'owner', timezone: 'America/Argentina/Buenos_Aires', locale: 'es', token: 'session-token-must-never-show', plan: [] } };
    }
    if (p === '/api/v1/devices') {
      return this.paged(
        [
          { id: 3, alias: 'Oficial', number: '5491100000001', provider: 2, connected: 1, active: 1, health: { state: 'AVAILABLE', quality_level: 'GREEN' } },
          { id: 4, alias: 'QR', number: '5491100000002', provider: 1, connected: 1, active: 1, health: null },
        ],
        q,
      );
    }
    if ((m = /^\/api\/v1\/devices\/(\d+)\/health$/.exec(p))) {
      if (m[1] === '4') return { status: 422, body: { error: 'device_not_meta', message: 'Este dispositivo no usa la API de WhatsApp Cloud de Meta.' } };
      return {
        body: {
          health: { state: 'AVAILABLE', quality_level: 'GREEN', messaging_limit_tier: 'TIER_1K', messaging_limit_per_day: 1000, last_fetched_at: '2026-10-16T10:00:00+00:00', stale: false },
          identity: {},
          entities: [],
          throughput_level: 'STANDARD',
          history: [],
        },
      };
    }
    if (p === '/api/v1/custom-fields') return this.paged([{ id: 11, name: 'ciudad' }, { id: 12, name: 'plan' }], q);
    if (p === '/api/v1/contacts') {
      let list = [...this.contacts].sort((a, b) => a.id - b.id);
      const tagIds = q.getAll('tag_ids[]').map(Number);
      if (tagIds.length) list = list.filter((c) => c.tags.some((t) => tagIds.includes(t.id)));
      return this.paged(list.map((c) => this.contactResource(c)), q);
    }
    if ((m = /^\/api\/v1\/contacts\/(\d+)\/(tags|custom-fields)$/.exec(p))) {
      const contact = this.contacts.find((c) => c.id === Number(m![1]));
      if (!contact) return { status: 404, body: { message: 'No query results.' } };
      return this.paged(m[2] === 'tags' ? contact.tags : contact.fields, q);
    }
    if (p === '/api/v1/conversations') {
      let list = this.contacts.filter((c) => c.messages > 0);
      if (q.get('contactId')) list = list.filter((c) => c.id === Number(q.get('contactId')));
      if (q.get('deviceId')) list = list.filter((c) => c.device_id === Number(q.get('deviceId')));
      if (q.get('orderBy') !== 'asc') list = [...list].reverse();
      return this.cursored(list.map((c) => ({ contact_id: c.id, contact_name: c.name, contact_phone: Number(c.phone), id: c.id * 1000 + c.messages, text: 'último' })), q);
    }
    if ((m = /^\/api\/v1\/contacts\/(\d+)\/messages$/.exec(p))) {
      const contact = this.contacts.find((c) => c.id === Number(m![1]));
      if (!contact) return { status: 404, body: { message: 'No existe el contacto.' } };
      return this.cursored(this.messagesOf(contact), q);
    }
    if (p === '/api/v1/templates') return this.paged([{ id: 45, name: 'bienvenida', language_code: 'es', category: 'UTILITY', status: 'APPROVED', device_id: 3 }], q);
    if ((m = /^\/api\/v1\/templates\/(\d+)\/metrics$/.exec(p))) {
      if (m[1] !== '45') return { status: 404, body: { message: 'No query results.' } };
      return {
        body: {
          data: {
            template_id: 45,
            from: q.get('from') ?? '2026-10-10',
            to: q.get('to') ?? '2026-10-16',
            timezone: 'UTC',
            granularity: 'day',
            fetched_at: '2026-10-16T12:00:00Z',
            totals: { sent: 10, delivered: 9, read: 7, clicks: [{ type: 'url_button', button_content: 'Ver', count: 2 }], cost: { amount_spent: 0.5 } },
            days: [{ date: '2026-10-16', sent: 10, delivered: 9, read: 7, clicks: [], cost: null }],
          },
        },
      };
    }
    if (p === '/api/v1/mac/status') return { body: { enforcement_enabled: true, current_count: 120, limit: 1000, remaining: 880, usage_percentage: 12, state: 'normal', grace: null, period_start: null } };
    return { status: 404, body: { error: 'route_not_found', message: 'La ruta no existe.' } };
  }

  contactResource(c: FakeContact): Record<string, unknown> {
    return { id: c.id, name: c.name, phone: c.phone, email: null, whatsapp_id: null, country_code: 'AR', status: 0, created_at: c.created_at, device_id: c.device_id, adviser_id: null, lead_score: { score: 10, category: 'cold' } };
  }

  /** Laravel's LengthAwarePaginator. */
  paged(items: unknown[], q: URLSearchParams): FakeReply {
    const perPage = Number(q.get('perPage') ?? 25);
    const page = Number(q.get('page') ?? 1);
    const last = Math.max(1, Math.ceil(items.length / perPage));
    const link = (n: number) => `${this.base}/x?page=${n}`;
    return {
      body: {
        data: items.slice((page - 1) * perPage, page * perPage),
        links: { first: link(1), last: link(last), prev: page > 1 ? link(page - 1) : null, next: page < last ? link(page + 1) : null },
        meta: { current_page: page, last_page: last, per_page: perPage, total: items.length },
      },
    };
  }

  /** Laravel's CursorPaginator (the cursor is the position, base64). */
  cursored(items: unknown[], q: URLSearchParams): FakeReply {
    const perPage = Number(q.get('perPage') ?? 25);
    const start = q.get('cursor') ? Number(Buffer.from(q.get('cursor') as string, 'base64url').toString()) : 0;
    const next = start + perPage < items.length ? Buffer.from(String(start + perPage)).toString('base64url') : null;
    return { body: { data: items.slice(start, start + perPage), links: { next: null }, meta: { per_page: perPage, next_cursor: next, prev_cursor: null } } };
  }
}

// --- running the CLI ----------------------------------------------------------------------------

export function tempDir(prefix = 'funnelchat-cli-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export class FakeStdin extends EventEmitter {
  isTTY = false;
  constructor(private readonly content: string) {
    super();
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    queueMicrotask(() => {
      this.emit('data', this.content);
      this.emit('end');
    });
    return this;
  }
  pause(): this {
    return this;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  sleeps: number[];
}

export interface RunOptions {
  fetch: typeof fetch;
  cwd: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  signal?: AbortSignal;
  /** Called on every sleep, with the milliseconds. */
  onSleep?: (ms: number) => void;
}

/** Runs the real CLI with fake streams, a clock that advances only when it sleeps, and no network. */
export async function cli(args: string[], options: RunOptions): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const sleeps: number[] = [];
  let now = Date.parse('2026-10-16T12:00:00Z');
  const io: Io = {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    stdin: new FakeStdin(options.stdin ?? '') as unknown as Io['stdin'],
    env: {
      HOME: options.cwd,
      FUNNELCHAT_CONFIG_DIR: join(options.cwd, '.config-funnelchat'),
      FUNNELCHAT_API_KEY: TEST_KEY,
      ...options.env,
    },
    cwd: options.cwd,
    fetch: options.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      options.onSleep?.(ms);
    },
    clock: () => now,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const code = await run(['--rate', '10', ...args], io);
  return { code, stdout, stderr, sleeps };
}

/** Every file under `dir`, recursively, with its content. */
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

export function jsonl(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
