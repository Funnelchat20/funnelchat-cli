import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBaseUrl, checkKeyShape, PRODUCTION_URL, resolveCredentials, STAGING_URL } from '../src/config/credentials.js';
import { configDir, saveConfig } from '../src/config/store.js';
import { CliError } from '../src/errors.js';
import { cli, FakeAccount, TEST_KEY, tempDir } from './helpers.js';

const OTHER_KEY = '8|fc_live_OtraClaveDePrueba000000000000000000';

describe('credentials', () => {
  const config = { version: 1 as const, current_profile: 'trabajo', profiles: { trabajo: { api_key: OTHER_KEY, base_url: STAGING_URL }, default: { api_key: TEST_KEY } } };

  it('takes FUNNELCHAT_API_KEY first, then the active profile; an explicit --profile wins', () => {
    expect(resolveCredentials({}, { FUNNELCHAT_API_KEY: TEST_KEY }, config)).toMatchObject({ apiKey: TEST_KEY, keySource: 'env', baseUrl: PRODUCTION_URL });
    expect(resolveCredentials({}, {}, config)).toMatchObject({ apiKey: OTHER_KEY, keySource: 'profile', profile: 'trabajo', baseUrl: STAGING_URL });
    expect(resolveCredentials({ profile: 'default' }, { FUNNELCHAT_API_KEY: OTHER_KEY }, config)).toMatchObject({ apiKey: TEST_KEY, profile: 'default' });
    expect(resolveCredentials({}, { FUNNELCHAT_PROFILE: 'default' }, config)).toMatchObject({ apiKey: TEST_KEY });
    expect(() => resolveCredentials({}, {}, { version: 1, profiles: {} })).toThrow(/No API key/);
    expect(() => resolveCredentials({ profile: 'nada' }, {}, config)).toThrow(/has no saved key/);
  });

  it('picks the base URL: --base-url, --staging, FUNNELCHAT_BASE_URL, profile, production', () => {
    expect(resolveCredentials({ baseUrl: 'http://127.0.0.1:4010/' }, { FUNNELCHAT_API_KEY: TEST_KEY }, config).baseUrl).toBe('http://127.0.0.1:4010');
    expect(resolveCredentials({ staging: true }, { FUNNELCHAT_API_KEY: TEST_KEY }, config).baseUrl).toBe(STAGING_URL);
    expect(resolveCredentials({}, { FUNNELCHAT_API_KEY: TEST_KEY, FUNNELCHAT_BASE_URL: 'https://otra.example.com' }, config).baseUrl).toBe('https://otra.example.com');
    expect(() => resolveCredentials({ staging: true, baseUrl: 'https://x.example.com' }, { FUNNELCHAT_API_KEY: TEST_KEY }, config)).toThrow(CliError);
  });

  it('accepts http only for this machine', () => {
    expect(checkBaseUrl('http://localhost:4010')).toBe('http://localhost:4010');
    expect(() => checkBaseUrl('http://api.funnelchat.com')).toThrow(/https/);
    expect(() => checkBaseUrl('ftp://x')).toThrow(CliError);
    expect(() => checkBaseUrl('https://api.funnelchat.com?x=1')).toThrow(CliError);
  });

  it('checks the shape of the key', () => {
    expect(checkKeyShape(`  ${TEST_KEY}\n`)).toBe(TEST_KEY);
    expect(checkKeyShape('1|fc_live_sandbox')).toBe('1|fc_live_sandbox');
    for (const bad of ['fc_live_abc', '1|abc', 'Bearer 1|fc_live_abc', '1|fc_live_con espacios']) expect(() => checkKeyShape(bad)).toThrow(CliError);
  });
});

describe('config file', () => {
  it('lives in FUNNELCHAT_CONFIG_DIR, XDG_CONFIG_HOME, or ~/.config', () => {
    expect(configDir({ FUNNELCHAT_CONFIG_DIR: '/x' })).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }, 'linux')).toBe(join('/xdg', 'funnelchat'));
    expect(configDir({ HOME: '/h' }, 'darwin')).toBe(join('/h', '.config', 'funnelchat'));
    expect(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'funnelchat'));
  });

  it('is written with permissions 0600 and keeps them on rewrite', () => {
    const dir = tempDir();
    const env = { FUNNELCHAT_CONFIG_DIR: join(dir, 'cfg') };
    const path = saveConfig(env, { version: 1, profiles: { a: { api_key: TEST_KEY } } });
    if (process.platform === 'win32') return;
    chmodSync(path, 0o644);
    saveConfig(env, { version: 1, profiles: {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('warns when others can read it', async () => {
    if (process.platform === 'win32') return;
    const cwd = tempDir();
    const cfg = join(cwd, '.config-funnelchat');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'config.json'), JSON.stringify({ version: 1, current_profile: 'default', profiles: { default: { api_key: TEST_KEY } } }));
    chmodSync(join(cfg, 'config.json'), 0o644);
    const result = await cli(['whoami'], { fetch: new FakeAccount().fetch().fetch, cwd, env: { FUNNELCHAT_API_KEY: undefined } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('chmod 600');
  });

  it('logout removes the key; profiles use switches the active profile', async () => {
    const cwd = tempDir();
    const account = new FakeAccount();
    const env = { FUNNELCHAT_API_KEY: undefined };
    expect((await cli(['login', '--profile', 'a'], { fetch: account.fetch().fetch, cwd, env, stdin: TEST_KEY })).code).toBe(0);
    expect((await cli(['login', '--profile', 'b', '--no-verify'], { fetch: account.fetch().fetch, cwd, env, stdin: TEST_KEY })).code).toBe(0);
    const listed = JSON.parse((await cli(['--json', 'profiles'], { fetch: account.fetch().fetch, cwd, env })).stdout);
    expect(listed.active_profile).toBe('b');
    expect(listed.profiles.map((p: { name: string }) => p.name).sort()).toEqual(['a', 'b']);
    expect(JSON.stringify(listed)).not.toContain('fc_live');

    expect((await cli(['profiles', 'use', 'a'], { fetch: account.fetch().fetch, cwd, env })).code).toBe(0);
    expect((await cli(['profiles', 'use', 'zeta'], { fetch: account.fetch().fetch, cwd, env })).code).toBe(2);
    expect((await cli(['logout'], { fetch: account.fetch().fetch, cwd, env })).code).toBe(0);
    const whoami = await cli(['whoami'], { fetch: account.fetch().fetch, cwd, env });
    expect(whoami.code).toBe(3);
    expect(whoami.stderr).toContain('No API key');
  });
});
