import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/commands/send.js';
import { cli, FakeAccount, tempDir } from './helpers.js';

const LINK = 'https://app.funnelchat.com/connect/TestOnlyLinkToken';

describe('first use', () => {
  it('connect prints the link at once, then waits until the new number is connected', async () => {
    let listings = 0;
    const account = new FakeAccount().hook((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/connect-links') {
        return { status: 201, body: { data: { id: 12, type: 'qr', status: 'pending', url: LINK, expires_at: '2026-10-16T12:30:00+00:00' } } };
      }
      // The third listing (the second poll) has the number the link connected.
      if (request.path === '/api/v1/devices' && ++listings === 3) {
        return { body: [{ id: 3, alias: 'Oficial', number: '5491100000001', provider: 2, connected: 1 }, { id: 4, alias: 'QR', number: '5491100000002', provider: 1, connected: 1 }, { id: 5, alias: '', number: '5491100000003', provider: 1, connected: 1 }] };
      }
      return undefined;
    });
    const { fetch, calls } = account.fetch();
    const result = await cli(['connect'], { fetch, cwd: tempDir() });

    expect(result.code, result.stderr).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/devices', 'POST /api/v1/connect-links', 'GET /api/v1/devices', 'GET /api/v1/devices']);
    expect(calls[1]?.body).toEqual({ type: 'qr' });
    expect(result.stdout.indexOf(LINK)).toBeLessThan(result.stdout.indexOf('Connected: 5491100000003, id 5.'));
    expect(result.stdout).toContain('funnelchat send <phone> "Hello from Funnelchat" --device 5');
    expect(result.sleeps.filter((ms) => ms >= 1000)).toEqual([5000, 5000]);
  });

  it('connect --us-number asks for a dedicated US number of Funnelchat and says what the page will ask', async () => {
    const account = new FakeAccount().hook((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/connect-links') {
        return { status: 201, body: { data: { id: 13, type: 'meta', status: 'pending', url: LINK, expires_at: '2026-11-08T12:30:00+00:00', allowed_connection_types: ['dedicated'], provision_us_number: true } } };
      }
      return undefined;
    });

    const { fetch, calls } = account.fetch();
    const result = await cli(['connect', '--us-number', '--no-wait'], { fetch, cwd: tempDir() });
    expect(result.code, result.stderr).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/v1/connect-links']);
    expect(calls[0]?.body).toEqual({ type: 'meta', allowed_connection_types: ['dedicated'], provision_us_number: true });
    expect(result.stdout).toContain('tap the button to use a Funnelchat US number and log in with Facebook:');
    expect(result.stdout).toContain(LINK);
    expect(result.stdout).toContain('the WhatsApp Business account needs a payment method in Meta.');
  });

  it('connect --device reconnects that number with a link of its own type and waits for it; never when it is connected or with --us-number', async () => {
    let listings = 0;
    const account = new FakeAccount().hook((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/connect-links') {
        return { status: 201, body: { data: { id: 14, type: 'meta', status: 'pending', url: LINK, expires_at: '2026-11-08T12:30:00+00:00', device_id: 3 } } };
      }
      // Number 3 (official, dedicated) is disconnected until the second listing (the first poll).
      if (request.path === '/api/v1/devices') {
        return { body: [{ id: 3, alias: 'Oficial', number: '5491100000001', provider: 2, connection: 'dedicated', connected: ++listings >= 2 ? 1 : 0 }, { id: 4, alias: 'QR', number: '5491100000002', provider: 1, connection: 'qr', connected: 1 }] };
      }
      return undefined;
    });

    const { fetch, calls } = account.fetch();
    const result = await cli(['connect', '--device', '3'], { fetch, cwd: tempDir() });
    expect(result.code, result.stderr).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/devices', 'POST /api/v1/connect-links', 'GET /api/v1/devices']);
    expect(calls[1]?.body).toEqual({ type: 'meta', allowed_connection_types: ['dedicated'], device_id: 3 });
    expect(result.stdout).toContain('log in with Facebook to reconnect Oficial (5491100000001) to the official WhatsApp API:');
    expect(result.stdout).toContain('It reconnects number 3: it does not add a new one.');
    expect(result.stdout).toContain('Reconnected: Oficial (5491100000001), id 3.');

    const connected = account.fetch();
    const already = await cli(['connect', '--device', '4'], { fetch: connected.fetch, cwd: tempDir() });
    expect(already.code, already.stderr).toBe(0);
    expect(connected.calls.map((c) => c.method)).toEqual(['GET']);
    expect(already.stdout).toContain('QR (5491100000002), id 4, is already connected: there is nothing to reconnect and no link was created.');

    const both = account.fetch();
    const usage = await cli(['connect', '--device', '3', '--us-number'], { fetch: both.fetch, cwd: tempDir() });
    expect(usage.code).toBe(2);
    expect(both.calls).toEqual([]);
  });

  it('send picks the only connected number, sends by phone and shows the status until read; a known rejection reads plainly', async () => {
    const statuses = ['sent', 'delivered', 'delivered', 'read'];
    const hooks = (rejection?: { status: number; body: unknown }) =>
      new FakeAccount().hook((request) => {
        if (request.path === '/api/v1/devices') return { body: [{ id: 3, alias: 'Oficial', number: '5491100000001', provider: 2, connected: 0 }, { id: 4, alias: 'QR', number: '5491100000002', provider: 1, connected: 1 }] };
        if (request.method === 'POST' && request.path === '/api/v1/message/send-message') {
          return rejection ?? { body: { message: { id: 9001, contact_id: 2001, device_id: 4, direction: 'outbound', type: 'text', status: 'queued', error: null } } };
        }
        if (request.path === '/api/v1/contacts/2001/messages/9001') return { body: { id: 9001, contact_id: 2001, status: statuses.shift() ?? 'read', error: null } };
        return undefined;
      });

    const { fetch, calls } = hooks().fetch();
    const result = await cli(['send', '+54 9 11 2233-4455', 'Hello', 'from', 'Funnelchat'], { fetch, cwd: tempDir() });
    expect(result.code, result.stderr).toBe(0);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ device_id: 4, phone: '5491122334455', text: 'Hello from Funnelchat' });
    expect(result.stderr).toMatch(/queued[\s\S]*sent\s+after 1 s[\s\S]*delivered\s+after 2 s[\s\S]*read\s+after 5 s/);
    expect(result.stdout).toContain('Message 9001 to 5491122334455: read 5 s after sending.');
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
