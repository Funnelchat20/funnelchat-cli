import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, fakeFetch, requestIdOf, tempDir } from './helpers.js';

const spec = JSON.parse(readFileSync(new URL('../spec/funnelchat.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
const specOperations = Object.values(spec.paths).flatMap((item) => ['get', 'put', 'post', 'delete', 'patch'].filter((method) => item[method]));

describe('funnelchat api', () => {
  it('api list shows every operation of the spec, by group, and filters by text', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 500 }));
    const all = await cli(['--json', 'api', 'list'], { fetch, cwd: tempDir() });
    expect(all.code, all.stderr).toBe(0);
    const listed = JSON.parse(all.stdout) as { count: number; functions: Record<string, unknown>[] };
    expect(listed.count).toBe(specOperations.length);
    expect(listed.functions.find((f) => f.name === 'broadcast.index')).toMatchObject({
      method: 'GET',
      path: '/api/v1/broadcasts',
      summary: 'Ver tus difusiones',
      category: 'funnelchat',
      category_title: 'Funciones de Funnelchat',
      group: 'Difusiones',
      pagination: 'page',
    });

    const found = await cli(['api', 'list', 'borrar', 'numero'], { fetch, cwd: tempDir() });
    expect(found.code, found.stderr).toBe(0);
    expect(found.stdout).toContain('Funciones de WhatsApp · https://developers-portal.funnelchat.app/docs/mas-funciones/whatsapp/\n  Números\n');
    expect(found.stdout).toMatch(/device\.destroy +DELETE +\/api\/v1\/devices\/\{device\} +Borrar un número {2}\(asks to confirm\)/);
    expect(found.stdout).not.toContain('broadcast.index');
    expect(calls).toEqual([]);
  });

  it('calls a read with its query parameters as options, and --all follows every page', async () => {
    const { fetch, calls } = fakeFetch((request) => {
      const page = Number(request.query.get('page') ?? 1);
      return { body: { data: [{ id: page }], meta: { current_page: page, last_page: 2 } } };
    });
    const one = await cli(['api', 'broadcast.index', '--status', '1', '--status', '2', '--device_id', '3'], { fetch, cwd: tempDir() });
    expect(one.code, one.stderr).toBe(0);
    expect(JSON.parse(one.stdout)).toEqual({ data: [{ id: 1 }], meta: { current_page: 1, last_page: 2 } });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/broadcasts' });
    expect(calls[0]?.query.getAll('status[]')).toEqual(['1', '2']);
    expect(calls[0]?.query.get('device_id')).toBe('3');

    const every = await cli(['api', 'broadcast.index', '--all'], { fetch, cwd: tempDir() });
    expect(every.code, every.stderr).toBe(0);
    expect(JSON.parse(every.stdout)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls.slice(1).map((c) => c.url.search)).toEqual(['?perPage=100', '?perPage=100&page=2']);
  });

  it('sends a write with a body typed as the spec says, only once, and its error carries the X-Request-Id', async () => {
    let fail = false;
    const { fetch, calls } = fakeFetch(() => (fail ? { status: 500, body: { message: 'Error interno' } } : { status: 201, body: { data: { id: 99 } } }));
    const cwd = tempDir();
    const fields = ['--field', 'device_id=3', '--field', 'phone=5491122334455', '--field', 'text=Hola', '--field', 'mentions=7', '--field', 'mentions=8'];
    const sent = await cli(['api', 'message.sendMessage', ...fields], { fetch, cwd });
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout)).toEqual({ data: { id: 99 } });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/message/send-message', body: { device_id: 3, phone: '5491122334455', text: 'Hola', mentions: [7, 8] } });

    writeFileSync(join(cwd, 'body.json'), JSON.stringify({ device_id: 3, phone: '5491122334455', text: 'Hola' }));
    const fromFile = await cli(['api', 'message.sendMessage', '--body', '@body.json', '--field', 'text=Chau'], { fetch, cwd });
    expect(fromFile.code, fromFile.stderr).toBe(0);
    expect(calls[1]?.body).toEqual({ device_id: 3, phone: '5491122334455', text: 'Chau' });

    fail = true;
    const failed = await cli(['api', 'message.sendMessage', ...fields], { fetch, cwd });
    expect(failed.code).toBe(6);
    expect(calls).toHaveLength(3);
    expect(failed.stderr).toContain('Funnelchat may have received it');
    expect(failed.stderr).toContain(requestIdOf(3));
  });

  it('asks for confirmation before what cannot be undone; without a terminal it needs --yes', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 204 }));
    const cwd = tempDir();
    const args = ['api', 'device.destroy', '--device', '12'];

    const refused = await cli(args, { fetch, cwd });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('device.destroy (Borrar un número) cannot be undone');
    expect(refused.stderr).toContain('run it again with --yes (DELETE /api/v1/devices/12)');
    const declined = await cli(args, { fetch, cwd, tty: true, stdin: 'no\n' });
    expect(declined.code).toBe(2);
    expect(calls).toEqual([]);

    const confirmed = await cli(args, { fetch, cwd, tty: true, stdin: 'yes\n' });
    expect(confirmed.code, confirmed.stderr).toBe(0);
    expect(confirmed.stderr).toContain('DELETE /api/v1/devices/12\nIt cannot be undone. Type "yes" to go ahead:');
    const yes = await cli([...args, '--yes'], { fetch, cwd });
    expect(yes.code, yes.stderr).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/v1/devices/12', 'DELETE /api/v1/devices/12']);
  });
});
