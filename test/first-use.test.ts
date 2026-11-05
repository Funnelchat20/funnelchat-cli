import { describe, expect, it } from 'vitest';
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
});
