/**
 * `numbers list` and `numbers health` (accounts: these calls count toward its daily cap per key).
 *
 * - `GET /api/v1/devices`: the numbers, with their provider, whether they are connected and, since accounts
 *   v1.4.24, `capabilities`: what the public API can do with each one (DeviceCapabilities::forDevice). The
 *   CLI passes that object through untouched and adds `cli_capabilities`: what the CLI itself exports or
 *   reads for the number.
 * - `GET /api/v1/devices/{device}/health`: health, quality, messaging limit and throughput of an
 *   official number, from the last snapshot Funnelchat stored (it never calls Meta). The spec types
 *   `health` as a string; its real shape comes from accounts origin/main @ 1d0e191ea,
 *   DeviceHealthSummaryBuilder::build (state, quality_level, messaging_limit_tier,
 *   messaging_limit_per_day, last_fetched_at, stale…).
 */
import { ApiError, isRecord } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { table } from '../output.js';
import { idList } from './common.js';

/** `provider` of a number (WhatsAppProviderEnum in accounts): 2 is the official WhatsApp Cloud API, the rest connect by QR. */
const OFFICIAL_PROVIDER = 2;

export type Capability = 'contacts' | 'conversations' | 'templates' | 'health';

const CAPABILITY_LABELS: Record<Capability, string> = {
  contacts: 'contactos',
  conversations: 'conversaciones',
  templates: 'plantillas',
  health: 'salud y límite',
};

/**
 * What the CLI can export or read for a number, derived from `provider`. Not the API's `capabilities` (what
 * a number can send), which says nothing about reads.
 */
export function capabilitiesOf(device: Record<string, unknown>): Capability[] {
  const official = Number(device.provider) === OFFICIAL_PROVIDER;
  return ['contacts', 'conversations', ...(official ? (['templates', 'health'] as const) : [])];
}

export function connectionOf(device: Record<string, unknown>): 'official' | 'qr' {
  return Number(device.provider) === OFFICIAL_PROVIDER ? 'official' : 'qr';
}

async function listDevices(ctx: Context): Promise<Record<string, unknown>[]> {
  const devices: Record<string, unknown>[] = [];
  for await (const device of ctx.client().all<Record<string, unknown>>(routes.devicesList, { query: { perPage: 100 } })) devices.push(device);
  return devices;
}

export async function numbersList(ctx: Context): Promise<void> {
  const devices = await listDevices(ctx);
  const rows: (Record<string, unknown> & { connection: 'official' | 'qr'; cli_capabilities: Capability[] })[] = devices.map((device) => ({
    ...device,
    connection: connectionOf(device),
    cli_capabilities: capabilitiesOf(device),
  }));
  ctx.out.result({ numbers: rows }, () =>
    rows.length === 0
      ? 'La cuenta no tiene números.'
      : table(
          ['id', 'alias', 'número', 'conexión', 'conectado', 'salud', 'qué lee la CLI'],
          rows.map((d) => [
            d.id as number,
            d.alias as string,
            d.number as string,
            d.connection === 'official' ? 'oficial' : 'QR',
            Number(d.connected) === 1 ? 'sí' : 'no',
            isRecord(d.health) ? String(d.health.state ?? '-') : null,
            d.cli_capabilities.map((c) => CAPABILITY_LABELS[c]).join(', '),
          ]),
        ),
  );
}

export async function numbersHealth(ctx: Context, ids: string[]): Promise<void> {
  let targets: { id: number; label: string }[];
  const wanted = idList(ids, 'número');
  if (wanted.length) {
    targets = wanted.map((id) => ({ id, label: String(id) }));
  } else {
    const devices = (await listDevices(ctx)).filter((d) => connectionOf(d) === 'official');
    targets = devices.map((d) => ({ id: Number(d.id), label: String(d.alias || d.number || d.id) }));
    if (targets.length === 0) {
      ctx.out.result({ numbers: [] }, () => 'La cuenta no tiene números oficiales: la salud y el límite son solo de la API oficial de WhatsApp.');
      return;
    }
  }

  const results: Record<string, unknown>[] = [];
  for (const target of targets) {
    try {
      const health = await ctx.client().get(routes.deviceHealth, { path: { device: target.id } });
      results.push({ device_id: target.id, ...(isRecord(health) ? health : { health }) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 422 && error.apiCode === 'device_not_meta') {
        results.push({ device_id: target.id, error: 'device_not_meta' });
        continue;
      }
      throw error;
    }
  }

  ctx.out.result({ numbers: results }, () =>
    table(
      ['id', 'estado', 'calidad', 'límite', 'por día', 'throughput', 'actualizado', 'viejo'],
      results.map((r) => {
        if (r.error === 'device_not_meta') return [r.device_id as number, 'no es un número oficial', null, null, null, null, null, null];
        const h = isRecord(r.health) ? r.health : {};
        return [
          r.device_id as number,
          str(h.state),
          str(h.quality_level),
          str(h.messaging_limit_tier),
          h.messaging_limit_per_day === null || h.messaging_limit_per_day === undefined ? 'sin límite informado' : Number(h.messaging_limit_per_day).toLocaleString('es-AR'),
          str(r.throughput_level),
          str(h.last_fetched_at),
          h.stale === true ? 'sí' : h.stale === false ? 'no' : null,
        ];
      }),
    ),
  );
}

function str(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}
