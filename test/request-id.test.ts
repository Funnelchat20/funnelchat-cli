import { describe, expect, it } from 'vitest';
import { cli, FakeAccount, requestIdOf, tempDir } from './helpers.js';

describe('X-Request-Id', () => {
  it('every API error carries the id of the answer, in human text and in --json', async () => {
    const account = new FakeAccount().hook((r) => (r.path === '/api/v1/me' ? { status: 403, body: { error: 'permission_denied', message: 'Sin permiso.' } } : undefined));
    const human = await cli(['whoami'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(human.code).toBe(3);
    expect(human.stderr).toContain(`Id del pedido (X-Request-Id): ${requestIdOf(1)}`);

    const json = await cli(['--json', 'whoami'], { fetch: new FakeAccount().hook(() => ({ status: 401, body: { error: 'unauthenticated' } })).fetch().fetch, cwd: tempDir() });
    expect(JSON.parse(json.stderr).error).toMatchObject({ code: 'unauthenticated', request_id: requestIdOf(1), exit_code: 3 });
  });

  it('a stop for a long Retry-After keeps the id', async () => {
    const account = new FakeAccount().hook(() => ({ status: 429, headers: { 'Retry-After': '40000' }, body: { error: 'daily_cap_exceeded' } }));
    const result = await cli(['--json', 'numbers', 'list'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'daily_cap_exceeded', request_id: requestIdOf(1) });
  });

  it('--verbose shows the id of each answer', async () => {
    const result = await cli(['-v', 'mac', 'status'], { fetch: new FakeAccount().fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`X-Request-Id ${requestIdOf(1)}`);
  });

  it('an error without the header says nothing about it', async () => {
    const account = new FakeAccount().hook(() => ({ status: 404, body: { message: 'No existe.' }, headers: { 'x-request-id': '' } }));
    const result = await cli(['--json', 'mac', 'status'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(JSON.parse(result.stderr).error.request_id).toBeUndefined();
  });
});

describe("the API entry's own errors", () => {
  it('500 edge_misconfigured stops at once: waiting does not fix it', async () => {
    const account = new FakeAccount().hook(() => ({ status: 500, body: { error: 'edge_misconfigured', message: 'La API no está disponible en este momento.' } }));
    const { fetch, calls } = account.fetch();
    const result = await cli(['mac', 'status'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(6);
    expect(calls).toHaveLength(1);
    expect(result.stderr).toContain('500 edge_misconfigured');
    expect(result.stderr).toContain('reportalo');
    expect(result.stderr).toContain(requestIdOf(1));
  });

  it('502 origin_unreachable is retried with backoff, like any 5xx of a read', async () => {
    let n = 0;
    const account = new FakeAccount().hook((r) =>
      r.path === '/api/v1/mac/status' && n++ < 2 ? { status: 502, body: { error: 'origin_unreachable', message: 'La API no está disponible en este momento.' } } : undefined,
    );
    const { fetch, calls } = account.fetch();
    const result = await cli(['mac', 'status'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('502 origin_unreachable after every retry says so, with the id of the last answer', async () => {
    const account = new FakeAccount().hook(() => ({ status: 502, body: { error: 'origin_unreachable', message: 'La API no está disponible en este momento.' } }));
    const { fetch, calls } = account.fetch();
    const result = await cli(['--json', 'mac', 'status'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(6);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'origin_unreachable', status: 502, request_id: requestIdOf(calls.length) });
  });

  it('404 route_not_found is not "missing in your account"', async () => {
    const account = new FakeAccount().hook(() => ({ status: 404, body: { error: 'route_not_found', message: 'La ruta no existe en la API.' } }));
    const result = await cli(['mac', 'status'], { fetch: account.fetch().fetch, cwd: tempDir() });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('La ruta no existe en la API');
    expect(result.stderr).not.toContain('No existe en tu cuenta');
  });
});
