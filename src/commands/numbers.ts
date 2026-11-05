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
import { ApiError, CliError, ExitCode, isRecord, usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { table } from '../output.js';
import { idList, positiveInt } from './common.js';

/** `provider` of a number (WhatsAppProviderEnum in accounts): 2 is the official WhatsApp Cloud API, the rest connect by QR. */
const OFFICIAL_PROVIDER = 2;

export type Capability = 'contacts' | 'conversations' | 'templates' | 'health';

const CAPABILITY_LABELS: Record<Capability, string> = {
  contacts: 'contacts',
  conversations: 'conversations',
  templates: 'templates',
  health: 'health and limit',
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

export async function listDevices(ctx: Context): Promise<Record<string, unknown>[]> {
  const devices: Record<string, unknown>[] = [];
  for await (const device of ctx.client().all<Record<string, unknown>>(routes.devicesList, { query: { perPage: 100 } })) devices.push(device);
  return devices;
}

/** `connected` is `1`/`0` in DeviceResource (accounts v1.5.97); a boolean is read the same way. */
export function isConnected(device: Record<string, unknown>): boolean {
  return device.connected === true || Number(device.connected) === 1;
}

/** `Sales (5491100000001)`, or what there is of it. */
export function deviceLabel(device: Record<string, unknown>): string {
  const alias = typeof device.alias === 'string' && device.alias !== '' ? device.alias : null;
  const number = typeof device.number === 'string' && device.number !== '' ? device.number : null;
  if (alias && number) return `${alias} (${number})`;
  return alias ?? number ?? `number ${String(device.id)}`;
}

export interface PickedDevice {
  id: number;
  /** The number as `GET /api/v1/devices` lists it; `null` when it came from `--device` (no listing needed). */
  device: Record<string, unknown> | null;
}

/**
 * The number a command acts from: `--device`, or else the only connected number of the account (with
 * `qrOnly`, the only one connected by QR). Several: asks for `--device`. None: says how to connect one.
 */
export async function pickDevice(ctx: Context, flag: string | undefined, options: { qrOnly: boolean }): Promise<PickedDevice> {
  if (flag !== undefined) return { id: positiveInt(flag, '--device'), device: null };
  let devices: Record<string, unknown>[];
  try {
    devices = await listDevices(ctx);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      error.hint = [error.hint, 'Or choose the number with --device <id>: without it the CLI lists your numbers, which needs accounts:read.'].filter(Boolean).join('\n');
    }
    throw error;
  }
  const kind = options.qrOnly ? 'connected by QR' : 'connected';
  const candidates = devices.filter((d) => isConnected(d) && (!options.qrOnly || connectionOf(d) === 'qr'));
  const [only] = candidates;
  if (candidates.length === 1 && only) return { id: Number(only.id), device: only };
  if (candidates.length === 0) {
    throw new CliError(`The account has no number ${kind}.`, {
      exitCode: ExitCode.NOT_FOUND,
      code: 'no_connected_number',
      hint: `Connect one with \`funnelchat connect\`, or choose one with --device <id> (\`funnelchat numbers list\` shows them).`,
    });
  }
  throw usageError(
    `The account has ${candidates.length} numbers ${kind}: choose one with --device <id>.`,
    candidates.map((d) => `${String(d.id)}  ${deviceLabel(d)}`).join('\n'),
  );
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
      ? 'The account has no numbers.'
      : table(
          ['id', 'alias', 'number', 'connection', 'connected', 'health', 'what the CLI reads'],
          rows.map((d) => [
            d.id as number,
            d.alias as string,
            d.number as string,
            d.connection === 'official' ? 'official' : 'QR',
            Number(d.connected) === 1 ? 'yes' : 'no',
            isRecord(d.health) ? String(d.health.state ?? '-') : null,
            d.cli_capabilities.map((c) => CAPABILITY_LABELS[c]).join(', '),
          ]),
        ),
  );
}

export async function numbersHealth(ctx: Context, ids: string[]): Promise<void> {
  let targets: { id: number; label: string }[];
  const wanted = idList(ids, 'number');
  if (wanted.length) {
    targets = wanted.map((id) => ({ id, label: String(id) }));
  } else {
    const devices = (await listDevices(ctx)).filter((d) => connectionOf(d) === 'official');
    targets = devices.map((d) => ({ id: Number(d.id), label: String(d.alias || d.number || d.id) }));
    if (targets.length === 0) {
      ctx.out.result({ numbers: [] }, () => 'The account has no official numbers: health and limit exist only for the official WhatsApp API.');
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
      ['id', 'state', 'quality', 'limit', 'per day', 'throughput', 'updated', 'stale'],
      results.map((r) => {
        if (r.error === 'device_not_meta') return [r.device_id as number, 'not an official number', null, null, null, null, null, null];
        const h = isRecord(r.health) ? r.health : {};
        return [
          r.device_id as number,
          str(h.state),
          str(h.quality_level),
          str(h.messaging_limit_tier),
          h.messaging_limit_per_day === null || h.messaging_limit_per_day === undefined ? 'no limit reported' : Number(h.messaging_limit_per_day).toLocaleString('en-US'),
          str(r.throughput_level),
          str(h.last_fetched_at),
          h.stale === true ? 'yes' : h.stale === false ? 'no' : null,
        ];
      }),
    ),
  );
}

function str(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}
