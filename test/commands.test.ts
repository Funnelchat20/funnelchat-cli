import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { cli, FakeAccount, jsonl, tempDir } from './helpers.js';

const run = (args: string[], account = new FakeAccount()) => {
  const { fetch, calls } = account.fetch();
  return cli(args, { fetch, cwd: tempDir() }).then((result) => ({ ...result, calls }));
};

describe('whoami', () => {
  it('shows the account from a whitelist of fields, never the session token of /me', async () => {
    const human = await run(['whoami']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Cuenta de prueba (dueno@example.com)');
    expect(human.stdout).toContain('de la variable FUNNELCHAT_API_KEY');
    const json = JSON.parse((await run(['--json', 'whoami'])).stdout);
    expect(Object.keys(json.account).sort()).toEqual(['email', 'id', 'locale', 'name', 'role', 'timezone']);
    expect(json.key_source).toBe('env');
  });
});

describe('numbers', () => {
  it('lists what each number allows', async () => {
    const json = JSON.parse((await run(['--json', 'numbers', 'list'])).stdout);
    const [official, qr] = json.numbers;
    expect(official).toMatchObject({ id: 3, connection: 'official', cli_capabilities: ['contacts', 'conversations', 'templates', 'health'] });
    expect(qr).toMatchObject({ id: 4, connection: 'qr', cli_capabilities: ['contacts', 'conversations'] });
    // The API's own `capabilities` (accounts v1.4.24) goes through untouched.
    expect(official.capabilities).toEqual({ messages: { text: true, templates: true }, groups: { send: false }, statuses: ['sent', 'delivered', 'read', 'failed'] });
    const human = await run(['numbers', 'list']);
    expect(human.stdout).toContain('plantillas, salud y límite');
  });

  it('health reads only official numbers by default, and says when one is not official', async () => {
    const all = await run(['--json', 'numbers', 'health']);
    expect(all.calls.map((c) => c.path)).toEqual(['/api/v1/devices', '/api/v1/devices/3/health']);
    expect(JSON.parse(all.stdout).numbers[0]).toMatchObject({ device_id: 3, health: { messaging_limit_tier: 'TIER_1K', messaging_limit_per_day: 1000 }, throughput_level: 'STANDARD' });
    const some = await run(['numbers', 'health', '3', '4']);
    expect(some.code).toBe(0);
    expect(some.stdout).toContain('TIER_1K');
    expect(some.stdout).toContain('no es un número oficial');
  });
});

describe('templates', () => {
  it('lists templates with filters', async () => {
    const result = await run(['templates', 'list', '--device', '3', '--status', 'approved']);
    expect(result.code).toBe(0);
    expect(result.calls[0]?.query.get('deviceId')).toBe('3');
    expect(result.calls[0]?.query.get('status')).toBe('APPROVED');
    expect(result.stdout).toContain('bienvenida');
  });
});

describe('mac status', () => {
  it('shows the consumption against the limit', async () => {
    const result = await run(['mac', 'status']);
    expect(result.stdout).toContain('MACs del período: 120 de 1.000 (12 %) · quedan 880');
  });

  it('reads the shape of an account inside the MAC rollout too', async () => {
    const enrolled = new FakeAccount().hook((r) =>
      r.path === '/api/v1/mac/status'
        ? {
            body: {
              mac_count: 950,
              mac_limit: 1000,
              cycle_capacity: 1200,
              accumulated_available: 250,
              total_available: 250,
              usage_percentage: 79.17,
              enforcement_enabled: true,
              alert_level: null,
              expiring_buckets: [],
              buckets: [],
              state: 'enforcing',
              grace: null,
              inactive_contacts_count: 12,
            },
          }
        : undefined,
    );
    const result = await run(['mac', 'status'], enrolled);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('MACs del período: 950 de 1.200 (79,17 %) · quedan 250');
    expect(result.stdout).toContain('estado enforcing');
    expect(result.stdout).toContain('contactos inactivos por MAC: 12');
  });
});

describe('exports, details', () => {
  it('conversations --contact: one lookup per contact; an unknown contact is a 404', async () => {
    const result = await run(['conversations', 'export', '-o', 'out', '--contact', '1002,1003']);
    expect(result.code).toBe(0);
    expect(result.calls.filter((c) => c.path === '/api/v1/conversations').map((c) => c.query.get('contactId'))).toEqual(['1002', '1003']);
    expect((await run(['conversations', 'export', '-o', 'out', '--contact', '5'])).code).toBe(4);
  });

  it('conversations --device keeps that number only', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 4 });
    const { fetch, calls } = account.fetch();
    expect((await cli(['conversations', 'export', '-o', 'out', '--device', '3'], { fetch, cwd })).code).toBe(0);
    expect(calls.find((c) => c.path === '/api/v1/conversations')?.query.get('deviceId')).toBe('3');
    const messages = jsonl(readFileSync(join(cwd, 'out', 'messages-00001.jsonl'), 'utf8'));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.device_id === 3)).toBe(true);
  });

  it('a contact deleted mid-export is counted, not fatal', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 3 }).hook((r) => (r.path === '/api/v1/contacts/1002/tags' ? { status: 404, body: {} } : undefined));
    expect((await cli(['contacts', 'export', '-o', 'out', '--format', 'jsonl'], { fetch: account.fetch().fetch, cwd })).code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, 'out', 'manifest.json'), 'utf8'));
    expect(manifest.counts).toMatchObject({ contacts: 2, vanished_during_export: 1 });
  });

  it('a route that does not exist is an error, not a deleted contact', async () => {
    const account = new FakeAccount({ contacts: 3 }).hook((r) => (r.path.endsWith('/tags') ? { status: 404, body: { error: 'route_not_found' } } : undefined));
    expect((await run(['contacts', 'export', '-o', 'out'], account)).code).toBe(4);
  });

  it('contacts filters reach the API as it expects them', async () => {
    const result = await run(['contacts', 'export', '-o', 'out', '--tag', '1', '--tag', '2,3', '--tag-mode', 'all', '--created-from', '2026-10-01', '--created-to', '2026-10-15', '--only-with-phone']);
    expect(result.code).toBe(0);
    const query = result.calls.find((c) => c.path === '/api/v1/contacts')?.query;
    expect(query?.getAll('tag_ids[]')).toEqual(['1', '2', '3']);
    expect(query?.get('tag_mode')).toBe('all');
    expect(query?.get('created_from')).toBe('2026-10-01');
    expect(query?.get('created_to')).toBe('2026-10-15');
    expect(query?.get('only_with_phone')).toBe('1');
    expect((await run(['contacts', 'export', '-o', 'x', '--created-from', '2026-10-01'])).code).toBe(2);
    expect((await run(['contacts', 'export', '-o', 'x', '--format', 'xlsx'])).code).toBe(2);
  });
});

describe('usage', () => {
  it('help and version exit 0; an unknown command or option exits 2', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Códigos de salida');
    expect(help.stdout).toContain('no manda mensajes ni modifica nada');
    const version = await run(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);
    expect((await run(['borrar-todo'])).code).toBe(2);
    expect((await run(['contacts', 'export', '--sin-esto'])).code).toBe(2);
  });

  it('without a key: exit 3 and how to get one', async () => {
    const result = await cli(['whoami'], { fetch: new FakeAccount().fetch().fetch, cwd: tempDir(), env: { FUNNELCHAT_API_KEY: undefined } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('funnelchat login');
  });

  it('403 says which permission the route needs', async () => {
    const result = await run(['numbers', 'list'], new FakeAccount().hook(() => ({ status: 403, body: { error: 'permission_denied', message: 'Falta accounts:read.' } })));
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('accounts:read');
  });
});
