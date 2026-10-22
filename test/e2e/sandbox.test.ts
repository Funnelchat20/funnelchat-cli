/**
 * End to end against funnelchat-sandbox, the local imitation of the API (no real network, no real key).
 * Opt-in: it runs only with FUNNELCHAT_SANDBOX_DIR pointing at a built checkout of the sandbox.
 *
 *   FUNNELCHAT_SANDBOX_DIR=../funnelchat-sandbox npm run test:e2e
 *
 * The sandbox runs in this process, on a free port, from its own dist/: its repository is not touched.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cli, jsonl, readTree, tempDir } from '../helpers.js';

const SANDBOX_DIR = process.env.FUNNELCHAT_SANDBOX_DIR;
const SANDBOX_KEY = '1|fc_live_sandbox';
const CONTACTS = 12;
const MESSAGES_EACH = 3;

interface Sandbox {
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
}

describe.skipIf(!SANDBOX_DIR)('end to end against funnelchat-sandbox', () => {
  let sandbox: Sandbox;
  let url = '';
  const env = () => ({ FUNNELCHAT_API_KEY: SANDBOX_KEY, FUNNELCHAT_BASE_URL: url });
  const post = (path: string, body: unknown, auth = false) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${SANDBOX_KEY}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json() as Promise<Record<string, unknown>>;
    });

  beforeAll(async () => {
    const module = (await import(pathToFileURL(join(resolve(SANDBOX_DIR as string), 'dist/index.js')).href)) as {
      createSandbox(options: { config: Record<string, unknown> }): Sandbox;
    };
    sandbox = module.createSandbox({ config: { port: 0, log: false, statusDelays: { sent: 0.05, delivered: 0.05, read: 0.05 } } });
    ({ url } = await sandbox.listen());
    for (let i = 1; i <= CONTACTS; i++) {
      for (let k = 1; k <= MESSAGES_EACH; k++) {
        await post('/_sandbox/inbound/message', { phone: `5491177${String(i).padStart(6, '0')}`, device_id: i % 2 ? 3 : 4, text: `mensaje ${k}`, name: `Persona ${i}` });
      }
    }
    const field = await post('/api/v1/custom-fields', { name: 'ciudad', type: 0 }, true);
    await post('/api/v1/contacts/attach-custom-field', [{ contactId: 2002, customFieldId: field.id, value: 'Rosario' }], true);
    await post('/_sandbox/contacts/2002/tags', { tag_id: 4001 });
  }, 60_000);

  afterAll(async () => {
    await sandbox?.close();
  });

  it('whoami and numbers list', async () => {
    const cwd = tempDir();
    const whoami = await cli(['--json', 'whoami'], { fetch, cwd, env: env() });
    expect(whoami.code).toBe(0);
    expect(whoami.stdout).not.toContain('"token"');
    const numbers = JSON.parse((await cli(['--json', 'numbers', 'list'], { fetch, cwd, env: env() })).stdout).numbers;
    expect(numbers.map((n: { id: number; connection: string }) => [n.id, n.connection])).toEqual([
      [3, 'official'],
      [4, 'qr'],
    ]);
  });

  it('contacts export with tags and custom fields', async () => {
    const cwd = tempDir();
    const result = await cli(['contacts', 'export', '-o', 'out'], { fetch, cwd, env: env() });
    expect(result.code, result.stderr).toBe(0);
    const csv = readFileSync(join(cwd, 'out', 'contacts.csv'), 'utf8').replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    expect(csv[0]).toContain('custom_field:ciudad');
    expect(csv).toHaveLength(CONTACTS + 2); // header + the sandbox's example contact + ours
    expect(csv.find((line) => line.startsWith('2002,'))).toMatch(/,Cliente,4001,Rosario$/);
  });

  it('conversations export in parts, with a manifest whose sha256 match', async () => {
    const cwd = tempDir();
    const result = await cli(['conversations', 'export', '-o', 'out', '--part-size', '5'], { fetch, cwd, env: env() });
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
      return fetch(input, init);
    };
    const first = await cli(['conversations', 'export', '-o', 'out', '--part-size', '4'], { fetch: cutting, cwd, env: env(), signal: controller.signal });
    expect(first.code).toBe(130);
    const resumed = await cli(['conversations', 'export', '-o', 'out', '--resume'], { fetch, cwd, env: env() });
    expect(resumed.code, resumed.stderr).toBe(0);
    const files = readTree(join(cwd, 'out'));
    const messages = Object.entries(files)
      .filter(([name]) => name.startsWith('messages-'))
      .flatMap(([, content]) => jsonl(content));
    expect(messages).toHaveLength(CONTACTS * MESSAGES_EACH);
    expect(new Set(messages.map((m) => m.id)).size).toBe(CONTACTS * MESSAGES_EACH);
  });

  it('templates metrics: the sandbox does not have the route of the unmerged PR yet', async () => {
    const result = await cli(['templates', 'metrics', '45'], { fetch, cwd: tempDir(), env: env() });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('#2350');
  });

  it('an API error carries the X-Request-Id the sandbox sent', async () => {
    const seen: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      seen.push(response.headers.get('x-request-id') ?? '');
      return response;
    };
    const result = await cli(['--json', 'templates', 'metrics', '45'], { fetch: recording, cwd: tempDir(), env: env() });
    expect(result.code).toBe(4);
    // funnelchat-sandbox feat/inicial @ 7a1b3d8 (2026-10-22) does not send the header yet: then the CLI
    // must not make one up. Once it does, the CLI must carry exactly that one.
    const id = seen.at(-1);
    expect(JSON.parse(result.stderr).error.request_id).toBe(id === '' ? undefined : id);
  });

  it("numbers list keeps the API's capabilities apart from the CLI's", async () => {
    const numbers = JSON.parse((await cli(['--json', 'numbers', 'list'], { fetch, cwd: tempDir(), env: env() })).stdout).numbers;
    for (const number of numbers) expect(Array.isArray(number.cli_capabilities)).toBe(true);
    const withCapabilities = numbers.filter((n: { capabilities?: unknown }) => n.capabilities !== undefined);
    for (const number of withCapabilities) expect(Array.isArray(number.capabilities)).toBe(false);
  });
});
