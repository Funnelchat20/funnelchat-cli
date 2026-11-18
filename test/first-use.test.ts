import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/commands/send.js';
import { cli, FakeAccount, fakeFetch, oid, tempDir } from './helpers.js';

const LINK = 'https://app.funnelchat.com/connect/TestOnlyLinkToken';

describe('first use', () => {
  it('connect prints the link at once, then waits until the new number is connected', async () => {
    let listings = 0;
    const account = new FakeAccount().hook((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/connect-links') {
        return { status: 201, body: { data: { id: oid('lnk', 12), type: 'qr', status: 'pending', url: LINK, expires_at: '2026-10-16T12:30:00+00:00' } } };
      }
      // The third listing (the second poll) has the number the link connected.
      if (request.path === '/api/v1/devices' && ++listings === 3) {
        return { body: [{ id: oid('dev', 3), alias: 'Oficial', number: '5491100000001', provider: 2, connected: 1 }, { id: oid('dev', 4), alias: 'QR', number: '5491100000002', provider: 1, connected: 1 }, { id: oid('dev', 5), alias: '', number: '5491100000003', provider: 1, connected: 1 }] };
      }
      return undefined;
    });
    const { fetch, calls } = account.fetch();
    const result = await cli(['connect'], { fetch, cwd: tempDir() });

    expect(result.code, result.stderr).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/devices', 'POST /api/v1/connect-links', 'GET /api/v1/devices', 'GET /api/v1/devices']);
    expect(calls[1]?.body).toEqual({ type: 'qr' });
    expect(result.stdout.indexOf(LINK)).toBeLessThan(result.stdout.indexOf(`Connected: 5491100000003, id ${oid('dev', 5)}.`));
    expect(result.stdout).toContain(`funnelchat send <phone> "Hello from Funnelchat" --device ${oid('dev', 5)}`);
    expect(result.sleeps.filter((ms) => ms >= 1000)).toEqual([5000, 5000]);
  });

  it('connect offers no link through Meta: --us-number says it is not available and sends nothing', async () => {
    const { fetch, calls } = new FakeAccount().fetch();
    const help = await cli(['connect', '--help'], { fetch, cwd: tempDir() });
    expect(help.code).toBe(0);
    expect(help.stdout).not.toMatch(/us-number|Meta|official/i);

    const result = await cli(['--json', 'connect', '--us-number', '--no-wait'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'meta_connect_unavailable', exit_code: 2 });
    expect(calls).toEqual([]);
  });

  it('connect --device reconnects a number by QR and waits for it; never one that is connected, and never an official one', async () => {
    let listings = 0;
    const account = new FakeAccount().hook((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/connect-links') {
        return { status: 201, body: { data: { id: oid('lnk', 14), type: 'qr', status: 'pending', url: LINK, expires_at: '2026-11-08T12:30:00+00:00', device_id: oid('dev', 4) } } };
      }
      // Number 4 (QR) is disconnected until the second listing (the first poll); number 3 (official) never connects.
      if (request.path === '/api/v1/devices') {
        listings++;
        return { body: [{ id: oid('dev', 3), alias: 'Oficial', number: '5491100000001', provider: 2, connection: 'dedicated', connected: 0 }, { id: oid('dev', 4), alias: 'QR', number: '5491100000002', provider: 1, connection: 'qr', connected: listings >= 2 ? 1 : 0 }] };
      }
      return undefined;
    });

    const { fetch, calls } = account.fetch();
    const result = await cli(['connect', '--device', oid('dev', 4)], { fetch, cwd: tempDir() });
    expect(result.code, result.stderr).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/devices', 'POST /api/v1/connect-links', 'GET /api/v1/devices']);
    expect(calls[1]?.body).toEqual({ type: 'qr', device_id: oid('dev', 4) });
    expect(result.stdout).toContain('scan the QR code with WhatsApp on the phone of QR (5491100000002)');
    expect(result.stdout).toContain(`It reconnects number ${oid('dev', 4)}: it does not add a new one.`);
    expect(result.stdout).toContain(`Reconnected: QR (5491100000002), id ${oid('dev', 4)}.`);

    const connected = account.fetch();
    const already = await cli(['connect', '--device', oid('dev', 4)], { fetch: connected.fetch, cwd: tempDir() });
    expect(already.code, already.stderr).toBe(0);
    expect(connected.calls.map((c) => c.method)).toEqual(['GET']);
    expect(already.stdout).toContain(`QR (5491100000002), id ${oid('dev', 4)}, is already connected: there is nothing to reconnect and no link was created.`);

    const official = account.fetch();
    const refused = await cli(['connect', '--device', oid('dev', 3)], { fetch: official.fetch, cwd: tempDir() });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(`Oficial (5491100000001), id ${oid('dev', 3)}, is an official number: it reconnects through Meta, and that is not available by link yet.`);
    expect(official.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a 503 meta_connect_disabled of the API (funnelchat api) says nothing was created, without contradicting itself', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 503, body: { error: 'meta_connect_disabled', message: 'No disponible.' } }));
    const result = await cli(['api', 'connectLink.store', '--field', 'type=meta'], { fetch, cwd: tempDir() });
    expect(result.code).toBe(6);
    expect(calls).toHaveLength(1);
    expect(result.stderr).toContain('No link was created.');
    expect(result.stderr).not.toContain('may have received it');
  });

  it('send picks the only connected number, sends by phone and shows the status until read; a known rejection reads plainly', async () => {
    const statuses = ['sent', 'delivered', 'delivered', 'read'];
    const hooks = (rejection?: { status: number; body: unknown }) =>
      new FakeAccount().hook((request) => {
        if (request.path === '/api/v1/devices') return { body: [{ id: oid('dev', 3), alias: 'Oficial', number: '5491100000001', provider: 2, connected: 0 }, { id: oid('dev', 4), alias: 'QR', number: '5491100000002', provider: 1, connected: 1 }] };
        if (request.method === 'POST' && request.path === '/api/v1/message/send-message') {
          return rejection ?? { body: { message: { id: oid('msg', 9001), contact_id: oid('ctc', 2001), device_id: oid('dev', 4), direction: 'outbound', type: 'text', status: 'queued', error: null } } };
        }
        if (request.path === `/api/v1/contacts/${oid('ctc', 2001)}/messages/${oid('msg', 9001)}`) return { body: { id: oid('msg', 9001), contact_id: oid('ctc', 2001), status: statuses.shift() ?? 'read', error: null } };
        return undefined;
      });

    const { fetch, calls } = hooks().fetch();
    const result = await cli(['send', '+54 9 11 2233-4455', 'Hello', 'from', 'Funnelchat'], { fetch, cwd: tempDir() });
    expect(result.code, result.stderr).toBe(0);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ device_id: oid('dev', 4), phone: '5491122334455', text: 'Hello from Funnelchat' });
    expect(result.stderr).toMatch(/queued[\s\S]*sent\s+after 1 s[\s\S]*delivered\s+after 2 s[\s\S]*read\s+after 5 s/);
    expect(result.stdout).toContain(`Message ${oid('msg', 9001)} to 5491122334455: read 5 s after sending.`);
    // Backoff: 1 s after each change, doubling while nothing changes.
    expect(result.sleeps.filter((ms) => ms >= 1000)).toEqual([1000, 1000, 1000, 2000]);

    const windowClosed = hooks({ status: 422, body: { error: 'window_closed', message: 'Ventana cerrada.' } }).fetch();
    const rejected = await cli(['--json', 'send', '5491122334455', 'Hi'], { fetch: windowClosed.fetch, cwd: tempDir() });
    expect(rejected.code).toBe(6);
    expect(windowClosed.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const error = JSON.parse(rejected.stderr).error;
    expect(error).toMatchObject({ code: 'window_closed', status: 422, exit_code: 6 });
    expect(error.message).toContain('within 24 hours');
    expect(error.hint).toContain('Nothing was sent.');
  });

  it('send without --device and several numbers connected sends nothing, and lists their ids', async () => {
    const { fetch, calls } = new FakeAccount().fetch();
    const human = await cli(['send', '5491122334455', "¡Hola, it's me!"], { fetch, cwd: tempDir(), tty: true });
    expect(human.code).toBe(2);
    expect(human.stderr).toContain('The account has 2 numbers connected: choose one with --device <id>. Their ids:');
    expect(human.stderr).toMatch(new RegExp(`${oid('dev', 3)} +Oficial \\(5491100000001\\) +official`));
    expect(human.stderr).toMatch(new RegExp(`${oid('dev', 4)} +QR \\(5491100000002\\) +QR`));
    expect(human.stderr).toContain(`For example: funnelchat send 5491122334455 '¡Hola, it'\\''s me!' --device ${oid('dev', 3)}`);

    const json = await cli(['--json', 'send', '5491122334455', 'Hola'], { fetch, cwd: tempDir() });
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stderr).error).toMatchObject({
      code: 'device_required',
      exit_code: 2,
      numbers: [
        { id: oid('dev', 3), connection: 'official' },
        { id: oid('dev', 4), connection: 'qr' },
      ],
    });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('every send example of the README gives the CLI a phone it accepts', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const examples = readme.split('\n').filter((line) => line.startsWith('funnelchat send '));
    expect(examples.length).toBeGreaterThan(0);
    for (const line of examples) {
      // The words the shell passes to the CLI: quotes keep a phone with spaces in one argument.
      const words = [...line.replace(/\s+#.*$/, '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
      expect(() => normalizePhone(words[2] ?? ''), line).not.toThrow();
    }
  });
});
