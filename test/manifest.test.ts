import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_SOURCE } from '../src/generated/routes.js';
import { VERSION } from '../src/version.js';
import { cli, FakeAccount, tempDir } from './helpers.js';

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length;

describe('manifest', () => {
  it('records the sha256, size and rows of every part, which match the files', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 5, messagesPerContact: () => 7 });
    const result = await cli(['--json', 'conversations', 'export', '-o', 'out', '--part-size', '10', '--since', '2026-10-01'], { fetch: account.fetch().fetch, cwd });
    expect(result.code).toBe(0);
    const dir = join(cwd, 'out');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

    expect(manifest.files.length).toBeGreaterThan(2);
    for (const file of manifest.files) {
      const path = join(dir, file.path);
      expect(file.sha256).toBe(sha256(path));
      expect(file.bytes).toBe(statSync(path).size);
      expect(file.rows).toBe(lines(path));
    }
    expect(manifest.counts).toEqual({ conversations: 5, messages: 35, message_parts: manifest.files.length - 1, vanished_contacts: 0 });
    expect(manifest.generator).toEqual({ name: '@funnelchat-hq/cli', version: VERSION });
    expect(manifest.api.spec.sha256).toBe(SPEC_SOURCE.sha256);
    expect(manifest.range.since).toBe('2026-10-01T00:00:00+00:00');
    expect(manifest.range.observed_first_message_time).toBe('2026-10-01 10:00:00');
    expect(Date.parse(manifest.started_at)).not.toBeNaN();
    expect(Date.parse(manifest.finished_at)).not.toBeNaN();

    // Only the deliverables are left: no state, lock or .part.
    expect(readdirSync(dir).sort()).toEqual(['conversations.jsonl', 'manifest.json', ...manifest.files.slice(1).map((f: { path: string }) => f.path)].sort());

    // --json prints the same manifest, plus the manifest file's own sha256.
    const printed = JSON.parse(result.stdout);
    expect(printed.manifest).toEqual(manifest);
    expect(printed.manifest_file.sha256).toBe(sha256(join(dir, 'manifest.json')));
  });

  it('sends --since as updated_since in the format the API validates', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 1 });
    const { fetch, calls } = account.fetch();
    await cli(['conversations', 'export', '-o', 'out', '--since', '2026-10-01T09:30:00-03:00'], { fetch, cwd });
    for (const call of calls) expect(call.query.get('updated_since')).toBe('2026-10-01T12:30:00+00:00');
    const bad = await cli(['conversations', 'export', '-o', 'out2', '--since', 'ayer'], { fetch, cwd });
    expect(bad.code).toBe(2);
  });

  it('the contacts manifest matches the CSV, with tags and custom fields', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 6 });
    expect((await cli(['contacts', 'export', '-o', 'out'], { fetch: account.fetch().fetch, cwd })).code).toBe(0);
    const dir = join(cwd, 'out');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const [file] = manifest.files;
    expect(file.sha256).toBe(sha256(join(dir, 'contacts.csv')));
    expect(manifest.counts.contacts).toBe(6);

    const csv = readFileSync(join(dir, 'contacts.csv'), 'utf8').replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    expect(csv[0]).toContain('tags,tag_ids,custom_field:ciudad,custom_field:plan');
    expect(csv).toHaveLength(7);
    // The formula in contact 2's name is neutralized; the comma and quotes in the field are quoted.
    expect(csv[2]).toContain(`"'=HYPERLINK(""http://malo"")"`);
    expect(csv[2]).toContain(',Cliente,1,');
    expect(csv[3]).toContain('"Rosario, ""centro"""');
  });
});
