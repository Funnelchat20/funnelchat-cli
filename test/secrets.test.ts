import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/http/redact.js';
import { cli, FakeAccount, readTree, TEST_KEY, TEST_SECRET, tempDir } from './helpers.js';

const SESSION_TOKEN = 'session-token-must-never-show';

function expectNoSecret(text: string, where: string): void {
  expect(text.includes(TEST_KEY), `${where} tiene la clave`).toBe(false);
  expect(text.includes(TEST_SECRET), `${where} tiene la parte secreta de la clave`).toBe(false);
  expect(/fc_live_[A-Za-z0-9]{4,}/.test(text), `${where} tiene algo con forma de clave`).toBe(false);
  expect(text.includes(SESSION_TOKEN), `${where} tiene el token de sesión de /me`).toBe(false);
}

const COMMANDS: string[][] = [
  ['whoami'],
  ['numbers', 'list'],
  ['numbers', 'health'],
  ['numbers', 'health', '3', '4'],
  ['templates', 'list'],
  ['templates', 'metrics', '45', '--from', '2026-10-01', '--to', '2026-10-16'],
  ['mac', 'status'],
  ['profiles'],
  ['contacts', 'export', '-o', 'csv'],
  ['contacts', 'export', '-o', 'jsonl', '--format', 'jsonl'],
  ['conversations', 'export', '-o', 'conv', '--part-size', '2'],
  ['conversations', 'export', '-o', 'one', '--contact', '1002'],
];

describe('the key never shows up', () => {
  it('in any command, in human, --json and --verbose output, or in any file it writes', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 6 });
    const { fetch, calls } = account.fetch();
    let output = '';
    for (const [i, command] of COMMANDS.entries()) {
      for (const flags of [[], ['--json'], ['--verbose']]) {
        const args = command.includes('-o') ? command.map((a, k) => (command[k - 1] === '-o' ? `${a}-${i}-${flags.join('')}` : a)) : command;
        const result = await cli([...flags, ...args], { fetch, cwd });
        expect(result.code, `${args.join(' ')} ${flags.join(' ')}: ${result.stderr}`).toBe(0);
        output += result.stdout + result.stderr;
      }
    }
    expectNoSecret(output, 'la salida');
    for (const [path, content] of Object.entries(readTree(cwd))) expectNoSecret(content, path);
    // It does travel where it must: in the Authorization header, and nowhere else in the request.
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
      expect(call.url.toString().includes(TEST_SECRET)).toBe(false);
    }
  });

  it('in errors, even when the API or the network echoes it back', async () => {
    const cwd = tempDir();
    const echo = `clave inválida: ${TEST_KEY} (${TEST_SECRET})`;
    const cases: [FakeAccount, string[]][] = [
      [new FakeAccount().hook(() => ({ status: 401, body: { error: 'unauthenticated', message: echo } })), ['whoami']],
      [new FakeAccount().hook(() => ({ status: 403, body: { error: 'permission_denied', message: echo } })), ['--json', 'numbers', 'list']],
      [new FakeAccount().hook(() => ({ status: 422, body: { message: echo, errors: { perPage: [echo] } } })), ['-v', 'templates', 'list']],
      [new FakeAccount().hook(() => ({ status: 500, body: echo, headers: { 'content-type': 'text/plain' } })), ['-v', 'mac', 'status']],
      [new FakeAccount().hook(() => new Error(echo)), ['-v', 'whoami']],
      [new FakeAccount().hook(() => ({ status: 429, headers: { 'Retry-After': '9999' }, body: { error: 'daily_cap_exceeded', message: echo } })), ['contacts', 'export', '-o', 'cut']],
    ];
    for (const [account, args] of cases) {
      const result = await cli(args, { fetch: account.fetch().fetch, cwd });
      expect(result.code).not.toBe(0);
      expectNoSecret(result.stdout + result.stderr, args.join(' '));
    }
    // The state of the export that was cut, too.
    for (const [path, content] of Object.entries(readTree(cwd))) expectNoSecret(content, path);
  });

  it('login reads it from stdin, keeps it only in the 0600 config file and never prints it', async () => {
    const cwd = tempDir();
    const account = new FakeAccount();
    const result = await cli(['login'], { fetch: account.fetch().fetch, cwd, stdin: `${TEST_KEY}\n`, env: { FUNNELCHAT_API_KEY: undefined } });
    expect(result.code).toBe(0);
    expectNoSecret(result.stdout + result.stderr, 'login');
    const configFile = join(cwd, '.config-funnelchat', 'config.json');
    if (process.platform !== 'win32') {
      expect(statSync(configFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(cwd, '.config-funnelchat')).mode & 0o777).toBe(0o700);
    }
    const files = readTree(cwd);
    for (const [path, content] of Object.entries(files)) {
      if (path === '.config-funnelchat/config.json') expect(content).toContain(TEST_KEY);
      else expectNoSecret(content, path);
    }

    // Later commands use the saved profile and still never print it.
    const whoami = await cli(['-v', 'whoami'], { fetch: account.fetch().fetch, cwd, env: { FUNNELCHAT_API_KEY: undefined } });
    expect(whoami.code).toBe(0);
    expect(whoami.stdout).toContain('del perfil "default"');
    expectNoSecret(whoami.stdout + whoami.stderr, 'whoami');
  });

  it('login refuses a malformed key without echoing it, and a rejected key is not saved', async () => {
    const cwd = tempDir();
    const bad = await cli(['login'], { fetch: new FakeAccount().fetch().fetch, cwd, stdin: 'fc_live_SinIdNiBarra123456\n', env: { FUNNELCHAT_API_KEY: undefined } });
    expect(bad.code).toBe(3);
    expect(bad.stderr).not.toContain('SinIdNiBarra');

    const rejected = await cli(['login'], {
      fetch: new FakeAccount().hook(() => ({ status: 401, body: { error: 'unauthenticated' } })).fetch().fetch,
      cwd,
      stdin: `${TEST_KEY}\n`,
      env: { FUNNELCHAT_API_KEY: undefined },
    });
    expect(rejected.code).toBe(3);
    expect(Object.keys(readTree(cwd))).not.toContain('.config-funnelchat/config.json');
  });

  it('the redactor blanks the whole key, its secret part and anything with its shape', () => {
    const redactor = new Redactor();
    redactor.add(TEST_KEY);
    const out = redactor.redact(`a ${TEST_KEY} b ${TEST_SECRET} c 9|fc_live_OtraClave99 d`);
    expect(out).not.toContain('fc_live_');
    expect(out).toContain('[clave oculta]');
  });
});
