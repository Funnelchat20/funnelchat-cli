import { describe, expect, it } from 'vitest';
import type { RouteInfo } from '../src/generated/routes.js';
import { routes } from '../src/generated/routes.js';
import { ApiClient, backoffMs } from '../src/http/client.js';
import { Pacer } from '../src/http/pacer.js';
import { ApiError, ExitCode } from '../src/errors.js';
import { cli, FakeAccount, fakeFetch, TEST_KEY, tempDir } from './helpers.js';

describe('429 and Retry-After', () => {
  it('waits exactly Retry-After and retries the read', async () => {
    let n = 0;
    const account = new FakeAccount().hook((request) =>
      request.path === '/api/v1/me' && n++ < 2 ? { status: 429, headers: { 'Retry-After': '7' }, body: { error: 'rate_limited', message: 'Esperá.' } } : undefined,
    );
    const { fetch, calls } = account.fetch();
    const result = await cli(['whoami'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(result.sleeps.filter((ms) => ms === 7000)).toHaveLength(2);
  });

  it('stops on the daily cap of accounts with a clear message, without waiting hours', async () => {
    const account = new FakeAccount().hook((request) =>
      request.path === '/api/v1/devices'
        ? { status: 429, headers: { 'Retry-After': '30600' }, body: { error: 'daily_cap_exceeded', message: 'Daily cap exceeded.' } }
        : undefined,
    );
    const { fetch, calls } = account.fetch();
    const result = await cli(['numbers', 'list'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(ExitCode.RATE_LIMITED);
    expect(calls).toHaveLength(1);
    expect(result.stderr).toContain('tope diario de llamadas de accounts');
    expect(result.stderr).toContain('8 h 30 min');
    expect(result.stderr).toContain('UTC');
    expect(Math.max(0, ...result.sleeps)).toBeLessThan(60_000);
  });

  it('reports the cap in --json with the time it resets', async () => {
    const account = new FakeAccount().hook(() => ({ status: 429, headers: { 'Retry-After': '120' }, body: { error: 'daily_cap_exceeded' } }));
    const result = await cli(['--json', 'mac', 'status'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(5);
    expect(result.stdout).toBe('');
    const error = JSON.parse(result.stderr).error;
    expect(error).toMatchObject({ code: 'daily_cap_exceeded', exit_code: 5, retry_after: 120, status: 429 });
    expect(error.resets_at).toBe('2026-10-16T12:02:00.000Z');
  });

  it('a daily cap during an export says how to resume', async () => {
    const account = new FakeAccount({ contacts: 150 }).hook((request) =>
      request.path === '/api/v1/contacts' && request.query.get('page') === '2'
        ? { status: 429, headers: { 'Retry-After': '40000' }, body: { error: 'daily_cap_exceeded' } }
        : undefined,
    );
    const result = await cli(['contacts', 'export', '-o', 'out'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('tope diario');
    expect(result.stderr).toContain('funnelchat contacts export --output-dir out --resume');
  });

  it('--max-wait 0 never waits for Retry-After', async () => {
    const account = new FakeAccount().hook(() => ({ status: 429, headers: { 'Retry-After': '1' }, body: { error: 'rate_limited' } }));
    const result = await cli(['--max-wait', '0', 'whoami'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(5);
    expect(result.sleeps.filter((ms) => ms >= 1000)).toHaveLength(0);
  });

  it('backs off exponentially on 5xx without Retry-After, then gives up', async () => {
    const account = new FakeAccount().hook(() => ({ status: 503, body: { error: 'gate_unavailable', message: 'No disponible.' } }));
    const { fetch, calls } = account.fetch();
    const result = await cli(['whoami'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(ExitCode.API);
    expect(calls).toHaveLength(5);
    const waits = result.sleeps.filter((ms) => ms >= 500);
    expect(waits).toHaveLength(4);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThan(waits[i - 1] as number);
  });

  it('retries a network error', async () => {
    let n = 0;
    const account = new FakeAccount().hook(() => (n++ === 0 ? new TypeError('fetch failed') : undefined));
    const result = await cli(['whoami'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(0);
  });

  it('backoff doubles up to 30 s', () => {
    expect(backoffMs(0, () => 0)).toBe(1000);
    expect(backoffMs(1, () => 0)).toBe(2000);
    expect(backoffMs(10, () => 0)).toBe(30_000);
    expect(backoffMs(0, () => 1)).toBe(750);
  });
});

describe('only reads are retried', () => {
  it('never retries a request that is not a GET', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 503, body: {} }));
    const sleep = async () => {};
    const client = new ApiClient({ apiKey: TEST_KEY, baseUrl: 'https://api.funnelchat.com', fetch, pacer: new Pacer(1000, Date.now, sleep), sleep, clock: Date.now });
    const write = { ...routes.me, method: 'POST' } as unknown as RouteInfo;
    await expect(client.get(write)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });
});

describe('pace', () => {
  it('spaces requests at --rate per second', async () => {
    const account = new FakeAccount({ contacts: 1 });
    const result = await cli(['--rate', '2', 'contacts', 'export', '-o', 'out', '--format', 'jsonl'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(0);
    // 3 requests (listing, tags, custom fields): two waits of 500 ms between them.
    expect(result.sleeps).toEqual([500, 500]);
  });

  it('rejects a rate out of range', async () => {
    const result = await cli(['--rate', '50', 'whoami'], { fetch: new FakeAccount().fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(2);
  });
});
