import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_FILE } from '../src/export/session.js';
import { cli, FakeAccount, jsonl, tempDir } from './helpers.js';

const failPage = (path: string, page: string) => (request: { path: string; query: URLSearchParams }) =>
  request.path === path && request.query.get('page') === page ? { status: 500, body: { message: 'Server Error' } } : undefined;

describe('contacts export --resume', () => {
  it('continues from the last saved page after the API fails, without repeating rows', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 250 });
    let failing = true;
    account.hook((request) => (failing ? failPage('/api/v1/contacts', '3')(request) : undefined));

    const first = await cli(['contacts', 'export', '-o', 'out', '--format', 'jsonl'], { fetch: account.fetch().fetch, cwd });
    expect(first.code).toBe(6);
    expect(first.stderr).toContain('funnelchat contacts export --output-dir out --resume');
    expect(existsSync(join(cwd, 'out', 'contacts.jsonl'))).toBe(false);
    expect(existsSync(join(cwd, 'out', 'manifest.json'))).toBe(false);
    const state = JSON.parse(readFileSync(join(cwd, 'out', STATE_FILE), 'utf8'));
    expect(state.next).toEqual({ page: 3 });
    expect(state.file.rows).toBe(200);

    failing = false;
    const second = account.fetch();
    const resumed = await cli(['contacts', 'export', '-o', 'out', '--resume'], { fetch: second.fetch, cwd });
    expect(resumed.code).toBe(0);
    expect(second.calls.filter((c) => c.path === '/api/v1/contacts').map((c) => c.query.get('page'))).toEqual(['3']);

    const rows = jsonl(readFileSync(join(cwd, 'out', 'contacts.jsonl'), 'utf8'));
    expect(rows.map((r) => r.id)).toEqual(account.contacts.map((c) => c.id));
    const manifest = JSON.parse(readFileSync(join(cwd, 'out', 'manifest.json'), 'utf8'));
    expect(manifest.runs).toBe(2);
    expect(manifest.counts.contacts).toBe(250);
    expect(existsSync(join(cwd, 'out', STATE_FILE))).toBe(false);
    expect(existsSync(join(cwd, 'out', 'contacts.jsonl.part'))).toBe(false);
  });

  it('drops whatever was written after the last checkpoint (a cut mid-write)', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 150 });
    let failing = true;
    account.hook((request) => (failing ? failPage('/api/v1/contacts', '2')(request) : undefined));
    expect((await cli(['contacts', 'export', '-o', 'out', '--format', 'jsonl'], { fetch: account.fetch().fetch, cwd })).code).toBe(6);

    // As if the process died after writing part of a page but before saving the state.
    appendFileSync(join(cwd, 'out', 'contacts.jsonl.part'), '{"id":1001,"name":"repetido"}\n{"id":1002');
    failing = false;
    expect((await cli(['contacts', 'export', '-o', 'out', '--resume'], { fetch: account.fetch().fetch, cwd })).code).toBe(0);

    const rows = jsonl(readFileSync(join(cwd, 'out', 'contacts.jsonl'), 'utf8'));
    expect(rows).toHaveLength(150);
    expect(new Set(rows.map((r) => r.id)).size).toBe(150);
  });

  it('keeps the CSV header once across a resume', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 150 });
    let failing = true;
    account.hook((request) => (failing ? failPage('/api/v1/contacts', '2')(request) : undefined));
    expect((await cli(['contacts', 'export', '-o', 'out'], { fetch: account.fetch().fetch, cwd })).code).toBe(6);
    failing = false;
    expect((await cli(['contacts', 'export', '-o', 'out', '--resume'], { fetch: account.fetch().fetch, cwd })).code).toBe(0);
    const lines = readFileSync(join(cwd, 'out', 'contacts.csv'), 'utf8').split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(151);
    expect(lines.filter((l) => l.replace('\uFEFF', '').startsWith('id,name,'))).toHaveLength(1);
  });

  it('refuses to resume with different options, and needs --output-dir', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 150 });
    account.hook(failPage('/api/v1/contacts', '2'));
    expect((await cli(['contacts', 'export', '-o', 'out', '--format', 'jsonl'], { fetch: account.fetch().fetch, cwd })).code).toBe(6);
    const before = readFileSync(join(cwd, 'out', STATE_FILE), 'utf8');

    const different = await cli(['contacts', 'export', '-o', 'out', '--resume', '--format', 'csv'], { fetch: account.fetch().fetch, cwd });
    expect(different.code).toBe(2);
    expect(different.stderr).toContain('do not match');
    expect(readFileSync(join(cwd, 'out', STATE_FILE), 'utf8')).toBe(before);

    expect((await cli(['contacts', 'export', '--resume'], { fetch: account.fetch().fetch, cwd })).code).toBe(2);
    expect((await cli(['conversations', 'export', '-o', 'out', '--resume'], { fetch: account.fetch().fetch, cwd })).code).toBe(2);
  });

  it('says so when the export is already complete', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 3 });
    expect((await cli(['contacts', 'export', '-o', 'out'], { fetch: account.fetch().fetch, cwd })).code).toBe(0);
    const again = await cli(['contacts', 'export', '-o', 'out', '--resume'], { fetch: account.fetch().fetch, cwd });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('was already complete');
  });
});

describe('conversations export --resume', () => {
  it('continues from the saved cursor after a long Retry-After, across part rotation', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 4, messagesPerContact: () => 150 });
    let failing = true;
    let messageCalls = 0;
    account.hook((request) => {
      if (!request.path.endsWith('/messages')) return undefined;
      messageCalls++;
      // The 5th messages page (contact 3, page 1) is refused for an hour.
      if (failing && messageCalls === 5) return { status: 429, headers: { 'Retry-After': '3600' }, body: { error: 'rate_limited', message: 'Demasiadas solicitudes.' } };
      return undefined;
    });

    const first = await cli(['conversations', 'export', '-o', 'out', '--part-size', '200'], { fetch: account.fetch().fetch, cwd });
    expect(first.code).toBe(5);
    expect(first.stderr).toContain('1 h');
    expect(first.stderr).toContain('funnelchat conversations export --output-dir out --resume');
    expect(first.sleeps.some((ms) => ms >= 3_600_000)).toBe(false);
    const state = JSON.parse(readFileSync(join(cwd, 'out', STATE_FILE), 'utf8'));
    expect(state.messages.contact_index).toBe(2);
    expect(state.messages.total).toBe(300);
    expect(existsSync(join(cwd, 'out', 'messages-00001.jsonl'))).toBe(true);

    failing = false;
    const resumed = await cli(['conversations', 'export', '-o', 'out', '--resume'], { fetch: account.fetch().fetch, cwd });
    expect(resumed.code).toBe(0);

    const manifest = JSON.parse(readFileSync(join(cwd, 'out', 'manifest.json'), 'utf8'));
    expect(manifest.counts).toMatchObject({ conversations: 4, messages: 600 });
    const parts = manifest.files.filter((f: { path: string }) => f.path.startsWith('messages-'));
    const all = parts.flatMap((f: { path: string }) => jsonl(readFileSync(join(cwd, 'out', f.path), 'utf8')));
    expect(all).toHaveLength(600);
    expect(new Set(all.map((m: Record<string, unknown>) => m.id)).size).toBe(600);
    // Every part but the last one reaches --part-size (a part closes at a page boundary).
    for (const part of parts.slice(0, -1)) expect(part.rows).toBeGreaterThanOrEqual(200);
    expect(parts.length).toBeGreaterThan(1);
  });

  it('stops cleanly on Ctrl+C and resumes', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 3, messagesPerContact: () => 120 });
    const controller = new AbortController();
    account.hook((request) => {
      if (request.path === '/api/v1/contacts/1002/messages') controller.abort();
      return undefined;
    });
    const first = await cli(['conversations', 'export', '-o', 'out'], { fetch: account.fetch().fetch, cwd, signal: controller.signal });
    expect(first.code).toBe(130);
    expect(first.stderr).toContain('--resume');

    account.hooks = [];
    expect((await cli(['conversations', 'export', '-o', 'out', '--resume'], { fetch: account.fetch().fetch, cwd })).code).toBe(0);
    const messages = jsonl(readFileSync(join(cwd, 'out', 'messages-00001.jsonl'), 'utf8'));
    expect(messages).toHaveLength(360);
    expect(new Set(messages.map((m) => m.id)).size).toBe(360);
  });
});
