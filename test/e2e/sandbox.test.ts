/**
 * End to end against funnelchat-sandbox (0.7.0 or later), the local imitation of the API (no real network,
 * no real key). Opt-in, in one of two ways:
 *
 *   FUNNELCHAT_SANDBOX_URL=http://127.0.0.1:4220 npm run test:e2e     a sandbox already running (it is reset first)
 *   FUNNELCHAT_SANDBOX_DIR=../funnelchat-sandbox npm run test:e2e     a built checkout, started in this process
 *
 * Every call goes through a fetch that refuses any host but this machine: a bug in the base URL can never
 * reach the real API. The Ctrl+C test runs the built CLI (dist/cli.js, `npm run build`) as a real process.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cli, jsonl, readTree, tempDir } from '../helpers.js';

const SANDBOX_URL = process.env.FUNNELCHAT_SANDBOX_URL;
const SANDBOX_DIR = process.env.FUNNELCHAT_SANDBOX_DIR;
const BUILT_CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const SANDBOX_KEY = '1|fc_live_sandbox';
const CONTACTS = 12;
const MESSAGES_EACH = 3;
/** An opaque id: `<prefix>_` and 23 base62 characters (the sandbox generates and accepts the same format). */
const OPAQUE_ID = /^[a-z]{3}_[A-Za-z0-9]{23}$/;

interface Sandbox {
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
}

/** `fetch` for this machine only: anything else fails before leaving it. */
const localFetch: typeof fetch = (input, init) => {
  const { hostname } = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return Promise.reject(new Error(`e2e: refused a call to ${hostname}`));
  return fetch(input, init);
};

describe.skipIf(!SANDBOX_URL && !SANDBOX_DIR)('end to end against funnelchat-sandbox', () => {
  let sandbox: Sandbox | undefined;
  let url = '';
  let officialId = '';
  let qrId = '';
  let markedContactId = '';
  let tagId = '';
  const env = () => ({ FUNNELCHAT_API_KEY: SANDBOX_KEY, FUNNELCHAT_BASE_URL: url });
  const get = (path: string) =>
    localFetch(`${url}${path}`, { headers: { Authorization: `Bearer ${SANDBOX_KEY}` } }).then(async (r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json() as Promise<unknown>;
    });
  const post = (path: string, body: unknown, auth = false) =>
    localFetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${SANDBOX_KEY}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json() as Promise<Record<string, unknown>>;
    });

  beforeAll(async () => {
    if (SANDBOX_URL) {
      url = SANDBOX_URL.replace(/\/+$/, '');
      await post('/_sandbox/reset', {});
    } else {
      const module = (await import(pathToFileURL(join(resolve(SANDBOX_DIR as string), 'dist/index.js')).href)) as {
        createSandbox(options: { config: Record<string, unknown> }): Sandbox;
      };
      sandbox = module.createSandbox({ config: { port: 0, log: false, statusDelays: { sent: 0.05, delivered: 0.05, read: 0.05 } } });
      ({ url } = await sandbox.listen());
    }
    // The ids are the sandbox's own, opaque: they are read from its answers (a paginated listing), never built here.
    const devices = ((await get('/api/v1/devices?perPage=100')) as { data: { id: string; connection: string | null }[] }).data;
    officialId = devices.find((d) => d.connection !== 'qr')?.id ?? '';
    qrId = devices.find((d) => d.connection === 'qr')?.id ?? '';
    for (let i = 1; i <= CONTACTS; i++) {
      for (let k = 1; k <= MESSAGES_EACH; k++) {
        await post('/_sandbox/inbound/message', { phone: `5491177${String(i).padStart(6, '0')}`, device_id: i % 2 ? officialId : qrId, text: `mensaje ${k}`, name: `Persona ${i}` });
      }
    }
    const contacts = (await get('/api/v1/contacts?perPage=100')) as { data: { id: string; phone: string }[] };
    markedContactId = contacts.data.find((c) => c.phone === `5491177${String(2).padStart(6, '0')}`)?.id ?? '';
    const tags = (await get('/api/v1/tags?perPage=100')) as { data: { id: string }[] };
    tagId = tags.data[0]?.id ?? '';
    const field = await post('/api/v1/custom-fields', { name: 'ciudad', type: 0 }, true);
    await post('/api/v1/contacts/attach-custom-field', [{ contactId: markedContactId, customFieldId: field.id, value: 'Rosario' }], true);
    await post(`/_sandbox/contacts/${markedContactId}/tags`, { tag_id: tagId });
  }, 60_000);

  afterAll(async () => {
    await sandbox?.close();
  });

  const contactsTotal = async () => ((await get('/api/v1/contacts?perPage=1')) as { meta: { total: number } }).meta.total;

  it('whoami and numbers list', async () => {
    const cwd = tempDir();
    const whoami = await cli(['--json', 'whoami'], { fetch: localFetch, cwd, env: env() });
    expect(whoami.code).toBe(0);
    expect(whoami.stdout).not.toContain('"token"');
    const numbers = JSON.parse((await cli(['--json', 'numbers', 'list'], { fetch: localFetch, cwd, env: env() })).stdout).numbers;
    expect(numbers.map((n: { id: string; connection: string }) => [n.id, n.connection])).toEqual([
      [officialId, 'official'],
      [qrId, 'qr'],
    ]);
    for (const number of numbers) expect(number.id).toMatch(OPAQUE_ID);
  });

  it('contacts export with tags and custom fields', async () => {
    const cwd = tempDir();
    const result = await cli(['contacts', 'export', '-o', 'out'], { fetch: localFetch, cwd, env: env() });
    expect(result.code, result.stderr).toBe(0);
    const csv = readFileSync(join(cwd, 'out', 'contacts.csv'), 'utf8').replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    expect(csv[0]).toContain('custom_field:ciudad');
    expect(csv).toHaveLength(CONTACTS + 2); // header + the sandbox's example contact + ours
    expect(csv.find((line) => line.startsWith(`${markedContactId},`))).toMatch(new RegExp(`,Cliente,${tagId},Rosario$`));
  });

  it('conversations export in parts, with a manifest whose sha256 match', async () => {
    const cwd = tempDir();
    const result = await cli(['conversations', 'export', '-o', 'out', '--part-size', '5'], { fetch: localFetch, cwd, env: env() });
    expect(result.code, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, 'out', 'manifest.json'), 'utf8'));
    expect(manifest.counts).toMatchObject({ conversations: CONTACTS, messages: CONTACTS * MESSAGES_EACH });
    for (const file of manifest.files) {
      expect(createHash('sha256').update(readFileSync(join(cwd, 'out', file.path))).digest('hex')).toBe(file.sha256);
    }
  });

  it('resumes after Ctrl+C without repeating messages', async () => {
    const cwd = tempDir();
    const controller = new AbortController();
    let requests = 0;
    const cutting: typeof fetch = (input, init) => {
      if (++requests === 6) controller.abort();
      return localFetch(input, init);
    };
    const first = await cli(['conversations', 'export', '-o', 'out', '--part-size', '4'], { fetch: cutting, cwd, env: env(), signal: controller.signal });
    expect(first.code).toBe(130);
    const resumed = await cli(['conversations', 'export', '-o', 'out', '--resume'], { fetch: localFetch, cwd, env: env() });
    expect(resumed.code, resumed.stderr).toBe(0);
    const files = readTree(join(cwd, 'out'));
    const messages = Object.entries(files)
      .filter(([name]) => name.startsWith('messages-'))
      .flatMap(([, content]) => jsonl(content));
    expect(messages).toHaveLength(CONTACTS * MESSAGES_EACH);
    expect(new Set(messages.map((m) => m.id)).size).toBe(CONTACTS * MESSAGES_EACH);
  });

  it('an API error carries the X-Request-Id the sandbox sent; 500 edge_misconfigured is not retried', async () => {
    // The sandbox sends one on every answer since feat/inicial @ 7e244b8, like api-edge v0.3.0, and can
    // force the edge's own errors for the next calls (POST /_sandbox/failures).
    await post('/_sandbox/failures', { mode: 'edge', code: 'edge_misconfigured', count: 1 });
    const seen: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const response = await localFetch(input, init);
      seen.push(response.headers.get('x-request-id') ?? '');
      return response;
    };
    const result = await cli(['--json', 'mac', 'status'], { fetch: recording, cwd: tempDir(), env: env() });
    expect(result.code).toBe(6);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'edge_misconfigured', status: 500, request_id: seen[0] });
  });

  it("numbers list keeps the API's capabilities apart from the CLI's", async () => {
    const numbers = JSON.parse((await cli(['--json', 'numbers', 'list'], { fetch: localFetch, cwd: tempDir(), env: env() })).stdout).numbers;
    for (const number of numbers) expect(Array.isArray(number.cli_capabilities)).toBe(true);
    const withCapabilities = numbers.filter((n: { capabilities?: unknown }) => n.capabilities !== undefined);
    for (const number of withCapabilities) expect(Array.isArray(number.capabilities)).toBe(false);
  });
  it('contact.destroy with all=true and no terminal is refused, and no contact is deleted', async () => {
    const before = await contactsTotal();
    expect(before).toBeGreaterThan(0);
    const refused = await cli(['--json', 'api', 'contact.destroy', '--field', 'all=true'], { fetch: localFetch, cwd: tempDir(), env: env(), stdin: '' });
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr).error).toMatchObject({ code: 'confirmation_required', exit_code: 2 });
    for (const name of ['tag.destroy', 'customField.destroy']) {
      const listed = JSON.parse((await cli(['--json', 'api', 'list', name], { fetch: localFetch, cwd: tempDir(), env: env() })).stdout);
      expect(listed.functions.find((f: { name: string }) => f.name === name)).toMatchObject({ asks_confirmation: true });
    }
    expect(await contactsTotal()).toBe(before);
  });

  it('send without --device lists both numbers and sends nothing; with --device it is read', async () => {
    const cwd = tempDir();
    const phone = '5491100000000';
    const refused = await cli(['--json', 'send', phone, '¡Hola!'], { fetch: localFetch, cwd, env: env() });
    expect(refused.code).toBe(2);
    const error = JSON.parse(refused.stderr).error;
    expect(error.code).toBe('device_required');
    expect(error.numbers.map((n: { id: string }) => n.id).sort()).toEqual([officialId, qrId].sort());

    const sent = await cli(['--json', 'send', phone, '¡Hola!', '--device', qrId, '--timeout', '30'], { fetch: localFetch, cwd, env: env() });
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({ device_id: qrId, phone, outcome: 'read' });
  });

  it('connect offers no link through Meta, and makes a QR link', async () => {
    const cwd = tempDir();
    const us = await cli(['--json', 'connect', '--us-number', '--no-wait'], { fetch: localFetch, cwd, env: env() });
    expect(us.code).toBe(2);
    expect(JSON.parse(us.stderr).error).toMatchObject({ code: 'meta_connect_unavailable' });
    const qr = await cli(['--json', 'connect', '--no-wait'], { fetch: localFetch, cwd, env: env() });
    expect(qr.code, qr.stderr).toBe(0);
    expect(JSON.parse(qr.stdout).link.url).toMatch(/^http/);
  });

  it('a key in FUNNELCHAT_API_KEY keeps the base URL of the profile', async () => {
    const cwd = tempDir();
    const login = await cli(['login', '--base-url', url], { fetch: localFetch, cwd, env: { FUNNELCHAT_API_KEY: undefined }, stdin: SANDBOX_KEY });
    expect(login.code, login.stderr).toBe(0);
    const whoami = await cli(['--json', 'whoami'], { fetch: localFetch, cwd, env: { FUNNELCHAT_API_KEY: SANDBOX_KEY } });
    expect(whoami.code, whoami.stderr).toBe(0);
    expect(JSON.parse(whoami.stdout)).toMatchObject({ key_source: 'env', base_url: url });
  });

  it.skipIf(!existsSync(BUILT_CLI))('the built CLI exits with 130 on Ctrl+C in the middle of an export, and it resumes', async () => {
    const cwd = tempDir();
    const run = (args: string[], interruptAfterMs?: number) =>
      new Promise<{ code: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [BUILT_CLI, ...args], {
          cwd,
          env: { PATH: process.env.PATH ?? '', HOME: cwd, FUNNELCHAT_CONFIG_DIR: join(cwd, '.config'), ...env() },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        if (interruptAfterMs !== undefined) setTimeout(() => child.kill('SIGINT'), interruptAfterMs);
        child.on('close', (code) => done({ code, stderr }));
      });
    // At 1 call per second, the export of the contacts with their tags and fields takes well over 3 s.
    const first = await run(['contacts', 'export', '-o', 'out'], 3_000);
    expect(first.code, first.stderr).toBe(130);
    expect(first.stderr).not.toContain('Unexpected error');
    expect(first.stderr).toContain('--resume');
    const resumed = await run(['--rate', '10', 'contacts', 'export', '-o', 'out', '--resume']);
    expect(resumed.code, resumed.stderr).toBe(0);
  }, 60_000);
});
