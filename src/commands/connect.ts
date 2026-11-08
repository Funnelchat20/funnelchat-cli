/**
 * `funnelchat connect`: a link to connect a WhatsApp number, and the wait until it connects.
 *
 * - `POST /api/v1/connect-links` (accounts v1.5.97; needs accounts:operate): a page on Funnelchat's domain
 *   that works once. Opening it does not use it; tapping its button does. `url` comes only in this answer.
 *   The CLI sends it once: a write is never retried. Three kinds of link:
 *   - by default, `{type: "qr"}`: tapping the button creates the number and shows the QR, renewed every
 *     5 seconds, for 10 minutes.
 *   - `--us-number`, `{type: "meta", allowed_connection_types: ["dedicated"], provision_us_number: true}`:
 *     the page offers a new US number of Funnelchat's pool on the official WhatsApp API, after a Facebook
 *     login (Meta's Embedded Signup). It is always a dedicated number and a new one, so it never goes with
 *     `device_id`. Meta charges its messages to the payment method of the WhatsApp Business account.
 *   - `--device <id>`, `{type, device_id}` with the number's own `type` (the API answers
 *     `connection_type_mismatch` otherwise): reconnects that number, it adds none. An official number
 *     also needs `allowed_connection_types`, taken from its `connection`.
 *   (StoreConnectLinkRequest and the description of the route in spec/funnelchat.json.)
 * - `GET /api/v1/devices` before creating the link and then every 5 seconds (accounts:read; each call
 *   counts toward the accounts daily cap of 10,000 per key: about 180 in the 15 minutes it waits by
 *   default). A new number: the wait ends when a number that was not connected before the link was
 *   created is connected, a new one first, else one that was already listed (the link can take a free
 *   place the account already had). A reconnection: when that number is connected. With `--device` the
 *   CLI lists the numbers even with `--no-wait`, to know how the number connects and whether it already is.
 *
 * No QR code in the terminal: the CLI has no dependency that draws one, and the page shows the QR
 * WhatsApp scans.
 */
import { CliError, ExitCode, InterruptedError, isRecord, usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { toCliError } from '../output.js';
import { pause, positiveInt, seconds } from './common.js';
import { connectionOf, deviceLabel, isConnected, listDevices } from './numbers.js';

export interface ConnectFlags {
  /** `--no-wait` sets it to false. */
  wait?: boolean;
  timeout?: string;
  /** `--us-number`: a new US number of Funnelchat, official. */
  usNumber?: boolean;
  /** `--device <id>`: reconnect this number of the account. */
  device?: string;
}

export const CONNECT_TIMEOUT_SECONDS = 15 * 60;
const POLL_MS = 5_000;

interface LinkInfo {
  id: unknown;
  url: string;
  status: unknown;
  expires_at: unknown;
}

/** What changes between the three kinds of link: what is sent, what the person is told and what ends the wait. */
interface LinkPlan {
  body: Record<string, unknown>;
  /** The lines printed with the link, before waiting. */
  instructions: (link: LinkInfo) => string[];
  /** The hint of a wait that ran out. */
  timeoutHint: string;
  /** A reconnection: the number whose connection ends the wait. */
  target: Record<string, unknown> | null;
  /** The number will be official: free text to a new contact needs the contact to write first. */
  official: boolean;
}

const SECRET = 'Whoever has the link can connect a number to your account: do not share it.';

function expiry(link: LinkInfo): string {
  return typeof link.expires_at === 'string' ? ` and expires at ${link.expires_at}` : '';
}

const QR_PLAN: LinkPlan = {
  body: { type: 'qr' },
  instructions: (link) => [
    'Open this link, tap the button and scan the QR code with WhatsApp on the phone you are connecting (Linked devices → Link a device):',
    '',
    `  ${link.url}`,
    '',
    `It works once${expiry(link)}; after tapping the button there are 10 minutes to scan the QR.`,
    SECRET,
  ],
  timeoutHint: 'If the QR was not scanned within 10 minutes of tapping the button, the link failed: run `funnelchat connect` again.',
  target: null,
  official: false,
};

const US_NUMBER_PLAN: LinkPlan = {
  body: { type: 'meta', allowed_connection_types: ['dedicated'], provision_us_number: true },
  instructions: (link) => [
    'Open this link, tap the button to use a Funnelchat US number and log in with Facebook:',
    '',
    `  ${link.url}`,
    '',
    'It is a new number on the official WhatsApp API. Meta charges its messages, so the WhatsApp Business account needs a payment method in Meta.',
    `It works once${expiry(link)}.`,
    SECRET,
  ],
  timeoutHint: 'If the Facebook login or Meta failed, the same link can be tried again (up to 5 failed attempts).',
  target: null,
  official: true,
};

/** A link that reconnects `device`, of its own type. */
function reconnectPlan(device: Record<string, unknown>): LinkPlan {
  const id = String(device.id);
  const label = deviceLabel(device);
  const reconnects = `It reconnects number ${id}: it does not add a new one.`;
  const secret = 'Whoever has the link can connect a phone to that number of your account: do not share it.';
  if (connectionOf(device) === 'qr') {
    return {
      body: { type: 'qr', device_id: Number(device.id) },
      instructions: (link) => [
        `Open this link, tap the button and scan the QR code with WhatsApp on the phone of ${label} (Linked devices → Link a device):`,
        '',
        `  ${link.url}`,
        '',
        `It works once${expiry(link)}; after tapping the button there are 10 minutes to scan the QR. ${reconnects}`,
        secret,
      ],
      timeoutHint: `If the QR was not scanned within 10 minutes of tapping the button, the link failed: run \`funnelchat connect --device ${id}\` again.`,
      target: device,
      official: false,
    };
  }
  return {
    body: { type: 'meta', allowed_connection_types: allowedConnectionTypes(device), device_id: Number(device.id) },
    instructions: (link) => [
      `Open this link and log in with Facebook to reconnect ${label} to the official WhatsApp API:`,
      '',
      `  ${link.url}`,
      '',
      `It works once${expiry(link)}. ${reconnects}`,
      secret,
    ],
    timeoutHint: 'If the Facebook login or Meta failed, the same link can be tried again (up to 5 failed attempts).',
    target: device,
    official: true,
  };
}

/**
 * `allowed_connection_types` of an official number's reconnection: its `connection` (`coexistence` or
 * `dedicated`, DeviceResource), else `is_coexistence`; when neither says, both, and the page asks.
 */
function allowedConnectionTypes(device: Record<string, unknown>): string[] {
  if (device.connection === 'coexistence' || device.connection === 'dedicated') return [device.connection];
  if (typeof device.is_coexistence === 'boolean') return [device.is_coexistence ? 'coexistence' : 'dedicated'];
  return ['coexistence', 'dedicated'];
}

export async function connect(ctx: Context, flags: ConnectFlags): Promise<void> {
  if (flags.usNumber && flags.device !== undefined) {
    throw usageError(
      '--us-number and --device do not go together: --us-number adds a new number, --device reconnects one you have.',
      'No link was created. Reconnect with `funnelchat connect --device <id>`, or ask for a US number with `funnelchat connect --us-number`.',
    );
  }
  const deviceId = flags.device === undefined ? null : positiveInt(flags.device, '--device');
  const wait = flags.wait !== false;
  const timeout = flags.timeout === undefined ? CONNECT_TIMEOUT_SECONDS : seconds(flags.timeout, '--timeout');
  const client = ctx.client();

  // What was connected before, so the wait recognises the number this link connects. A reconnection
  // lists them even without waiting: the link takes the number's type.
  const before = wait || deviceId !== null ? await listDevices(ctx) : [];
  const known = new Set(before.map((d) => Number(d.id)));
  const connectedBefore = new Set(before.filter(isConnected).map((d) => Number(d.id)));

  let plan: LinkPlan;
  if (deviceId !== null) {
    const device = before.find((d) => Number(d.id) === deviceId);
    if (!device) {
      throw new CliError(`Number ${deviceId} is not one of your account's numbers.`, {
        exitCode: ExitCode.NOT_FOUND,
        code: 'device_not_found',
        hint: 'No link was created. See your numbers and their ids with `funnelchat numbers list`.',
        details: { device_id: deviceId },
      });
    }
    if (isConnected(device)) {
      ctx.out.result({ link: null, device, already_connected: true }, () => [
        `${deviceLabel(device)}, id ${deviceId}, is already connected: there is nothing to reconnect and no link was created.`,
        `Send a message: funnelchat send <phone> "Hello from Funnelchat" --device ${deviceId}`,
      ]);
      return;
    }
    plan = reconnectPlan(device);
  } else {
    plan = flags.usNumber ? US_NUMBER_PLAN : QR_PLAN;
  }

  const body = await client.post(routes.connectLinkCreate, { body: plan.body });
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
  const instructions = plan.instructions(link);
  const result = plan.target ? { link, device: plan.target } : { link };

  if (!wait) {
    ctx.out.result(result, () => [...instructions, '', 'Once it is connected, `funnelchat numbers list` shows it.']);
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
          hint: plan.timeoutHint,
        });
      }
      await pause(ctx, Math.min(POLL_MS, left));
      const devices = await listDevices(ctx);
      let device: Record<string, unknown> | undefined;
      if (plan.target) {
        device = devices.find((d) => Number(d.id) === Number(plan.target?.id) && isConnected(d));
      } else {
        const connected = devices.filter((d) => isConnected(d) && !connectedBefore.has(Number(d.id)));
        device = connected.find((d) => !known.has(Number(d.id))) ?? connected[0];
      }
      if (device) {
        const found = device;
        const several = devices.filter(isConnected).length > 1;
        ctx.out.result({ link, device: found }, () => [
          `${plan.target ? 'Reconnected' : 'Connected'}: ${deviceLabel(found)}, id ${String(found.id)}.`,
          `Send a first message: funnelchat send <phone> "Hello from Funnelchat"${several ? ` --device ${String(found.id)}` : ''}`,
          ...(plan.official
            ? ['It is an official number: free text only reaches a contact who wrote to it in the last 24 hours, so first write to it from the phone you send to.']
            : []),
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
