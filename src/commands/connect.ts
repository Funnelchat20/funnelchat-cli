/**
 * `funnelchat connect`: a link to connect a WhatsApp number by QR code, and the wait until it connects.
 *
 * - `POST /api/v1/connect-links` with `{type: "qr"}` (accounts v1.5.97; needs accounts:operate): a page
 *   on Funnelchat's domain that works once. Opening it does not use it; tapping its button creates the
 *   number and shows the QR, renewed every 5 seconds, for 10 minutes. `url` comes only in this answer.
 *   The CLI sends it once: a write is never retried.
 * - `GET /api/v1/devices` before creating the link and then every 5 seconds (accounts:read; each call
 *   counts toward the accounts daily cap of 10,000 per key: about 180 in the 15 minutes it waits by
 *   default). The wait ends when a number that was not connected before the link was created is
 *   connected: a new one first, else one that was already listed (the link can take a free place the
 *   account already had).
 *
 * No QR code in the terminal: the CLI has no dependency that draws one, and the page shows the QR
 * WhatsApp scans.
 */
import { CliError, ExitCode, InterruptedError, isRecord } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { toCliError } from '../output.js';
import { pause, seconds } from './common.js';
import { deviceLabel, isConnected, listDevices } from './numbers.js';

export interface ConnectFlags {
  /** `--no-wait` sets it to false. */
  wait?: boolean;
  timeout?: string;
}

export const CONNECT_TIMEOUT_SECONDS = 15 * 60;
const POLL_MS = 5_000;

interface LinkInfo {
  id: unknown;
  url: string;
  status: unknown;
  expires_at: unknown;
}

export async function connect(ctx: Context, flags: ConnectFlags): Promise<void> {
  const wait = flags.wait !== false;
  const timeout = flags.timeout === undefined ? CONNECT_TIMEOUT_SECONDS : seconds(flags.timeout, '--timeout');
  const client = ctx.client();

  // What was connected before, so the wait recognises the number this link connects.
  const before = wait ? await listDevices(ctx) : [];
  const known = new Set(before.map((d) => Number(d.id)));
  const connectedBefore = new Set(before.filter(isConnected).map((d) => Number(d.id)));

  const body = await client.post(routes.connectLinkCreate, { body: { type: 'qr' } });
  const data = isRecord(body) && isRecord(body.data) ? body.data : isRecord(body) ? body : {};
  if (typeof data.url !== 'string' || data.url === '') {
    throw new CliError('The API created the connect link but did not return its URL.', {
      exitCode: ExitCode.API,
      code: 'connect_link_without_url',
      hint: 'Please report it. The link ends on its own when it expires.',
      details: { connect_link_id: data.id ?? null },
    });
  }
  const link: LinkInfo = { id: data.id ?? null, url: data.url, status: data.status ?? null, expires_at: data.expires_at ?? null };
  const instructions = [
    'Open this link, tap the button and scan the QR code with WhatsApp on the phone you are connecting (Linked devices → Link a device):',
    '',
    `  ${link.url}`,
    '',
    `It works once${typeof link.expires_at === 'string' ? ` and expires at ${link.expires_at}` : ''}; after tapping the button there are 10 minutes to scan the QR.`,
    'Whoever has the link can connect a number to your account: do not share it.',
  ];

  if (!wait) {
    ctx.out.result({ link }, () => [...instructions, '', 'Once it is connected, `funnelchat numbers list` shows it.']);
    return;
  }

  ctx.out.prompt(instructions);
  ctx.out.progress('\nWaiting for the number to connect… (Ctrl+C to stop)');
  const deadline = ctx.io.clock() + timeout * 1000;
  try {
    for (;;) {
      const left = deadline - ctx.io.clock();
      if (left <= 0) {
        throw new CliError(`No number connected within ${timeout} s.`, {
          exitCode: ExitCode.TIMEOUT,
          code: 'connect_timeout',
          hint: 'If the QR was not scanned within 10 minutes of tapping the button, the link failed: run `funnelchat connect` again.',
        });
      }
      await pause(ctx, Math.min(POLL_MS, left));
      const devices = await listDevices(ctx);
      const connected = devices.filter((d) => isConnected(d) && !connectedBefore.has(Number(d.id)));
      const device = connected.find((d) => !known.has(Number(d.id))) ?? connected[0];
      if (device) {
        const several = devices.filter(isConnected).length > 1;
        ctx.out.result({ link, device }, () => [
          `Connected: ${deviceLabel(device)}, id ${String(device.id)}.`,
          `Send a first message: funnelchat send <phone> "Hello from Funnelchat"${several ? ` --device ${String(device.id)}` : ''}`,
        ]);
        return;
      }
    }
  } catch (error) {
    throw stillOpen(error, link);
  }
}

/** An interrupted or failed wait: the link may still be used, and how to see the result. */
function stillOpen(error: unknown, link: LinkInfo): CliError {
  const cliError = error instanceof InterruptedError ? new CliError('Stopped waiting for the number (Ctrl+C).', { exitCode: ExitCode.INTERRUPTED, code: 'interrupted' }) : toCliError(error);
  const open = `${typeof link.expires_at === 'string' ? `The link stays usable until ${link.expires_at}` : 'The link stays usable until it expires'}: once the number connects, \`funnelchat numbers list\` shows it.`;
  cliError.hint = [cliError.hint, open].filter(Boolean).join('\n');
  cliError.details.connect_link_id = link.id;
  return cliError;
}
