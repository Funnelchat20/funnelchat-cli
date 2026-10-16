import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError, ExitCode } from '../src/errors.js';
import { PartFile, publish, writeNewFile } from '../src/export/files.js';
import { STATE_FILE } from '../src/export/session.js';
import { cli, FakeAccount, tempDir } from './helpers.js';

describe('an existing file is never overwritten', () => {
  it('refuses a folder that already has files, and leaves them untouched', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'out'));
    writeFileSync(join(cwd, 'out', 'contacts.csv'), 'mis datos\n');
    const before = statSync(join(cwd, 'out', 'contacts.csv')).mtimeMs;
    const account = new FakeAccount();
    const { fetch, calls } = account.fetch();

    for (const command of [['contacts', 'export', '-o', 'out'], ['conversations', 'export', '-o', 'out']]) {
      const result = await cli(command, { fetch, cwd });
      expect(result.code).toBe(ExitCode.EXISTS);
      expect(result.stderr).toContain('nunca pisa');
    }
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(cwd, 'out', 'contacts.csv'), 'utf8')).toBe('mis datos\n');
    expect(statSync(join(cwd, 'out', 'contacts.csv')).mtimeMs).toBe(before);
  });

  it('accepts an empty folder', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'out'));
    const result = await cli(['contacts', 'export', '-o', 'out'], { fetch: new FakeAccount().fetch().fetch, cwd });
    expect(result.code).toBe(0);
  });

  it('does not publish over a file that appeared while the export ran', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 150 }).hook((request) => {
      // Someone else creates contacts.jsonl in the export folder mid-run.
      if (request.path === '/api/v1/contacts' && request.query.get('page') === '2') writeFileSync(join(cwd, 'out', 'contacts.jsonl'), 'de otro programa\n');
      return undefined;
    });
    const result = await cli(['contacts', 'export', '-o', 'out', '--format', 'jsonl', '--no-tags', '--no-custom-fields'], { fetch: account.fetch().fetch, cwd });
    expect(result.code).toBe(ExitCode.EXISTS);
    expect(readFileSync(join(cwd, 'out', 'contacts.jsonl'), 'utf8')).toBe('de otro programa\n');
    expect(existsSync(join(cwd, 'out', 'contacts.jsonl.part'))).toBe(true);
    expect(existsSync(join(cwd, 'out', 'manifest.json'))).toBe(false);
    expect(existsSync(join(cwd, 'out', STATE_FILE))).toBe(true);
  });

  it('publish, writeNewFile and PartFile.create refuse an existing name', () => {
    const dir = tempDir();
    const final = join(dir, 'a.jsonl');
    writeFileSync(final, 'original');
    writeFileSync(`${final}.part`, 'nuevo');
    expect(() => publish(`${final}.part`, final)).toThrow(CliError);
    expect(() => writeNewFile(final, 'x')).toThrow(CliError);
    expect(() => PartFile.create(final)).toThrow(CliError);
    expect(readFileSync(final, 'utf8')).toBe('original');
  });

  it('publish moves the .part to its final name', () => {
    const dir = tempDir();
    const final = join(dir, 'b.jsonl');
    writeFileSync(`${final}.part`, 'contenido');
    publish(`${final}.part`, final);
    expect(readFileSync(final, 'utf8')).toBe('contenido');
    expect(existsSync(`${final}.part`)).toBe(false);
  });

  it('two runs cannot share a folder', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 150 });
    account.hook((request) => (request.query.get('page') === '2' ? { status: 500, body: {} } : undefined));
    expect((await cli(['contacts', 'export', '-o', 'out'], { fetch: account.fetch().fetch, cwd })).code).toBe(6);
    // A lock left by a live process (this one, under another pid number is not possible: use the parent).
    writeFileSync(join(cwd, 'out', '.funnelchat-export.lock'), String(process.ppid));
    account.hooks = [];
    const locked = await cli(['contacts', 'export', '-o', 'out', '--resume'], { fetch: account.fetch().fetch, cwd });
    expect(locked.code).toBe(ExitCode.EXISTS);
    expect(locked.stderr).toContain('está usando');
  });
});
