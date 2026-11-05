/**
 * `funnelchat send <phone> <text...>`: a text message to a phone, and its status live.
 *
 * - `POST /api/v1/message/send-message` with `{device_id, phone, text}` (conversations v1.19.21): no
 *   `contact_id` needed. A phone that is not a contact yet becomes one, which needs conversations:write
 *   (it includes conversations:send). It answers `200 {message}` with `id`, `contact_id` and status
 *   `queued`. Sent once: a write is never retried.
 * - `GET /api/v1/contacts/{contact}/messages/{message}` (conversations:read): its `status`, read with
 *   backoff (1 s, 2 s, 4 s… up to 10 s, back to 1 s after each change) until `read`, `failed`, `null` (an
 *   outcome the provider never confirmed: it does not change any more) or `--timeout`. conversations has no
 *   daily cap.
 *
 * Without `--device`, the only connected number of the account (`GET /api/v1/devices`, accounts:read).
 */
import { ApiError, CliError, ExitCode, InterruptedError, isRecord, usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { toCliError } from '../output.js';
import { pause, seconds } from './common.js';
import { deviceLabel, pickDevice } from './numbers.js';

export interface SendFlags {
  device?: string;
  timeout?: string;
}

export const SEND_TIMEOUT_SECONDS = 90;
const FIRST_POLL_MS = 1_000;
const MAX_POLL_MS = 10_000;

/** Digits with the country code; spaces, dashes, dots, parentheses and a leading `+` are dropped. */
export function normalizePhone(value: string): string {
  const digits = value.trim().replace(/^\+/, '').replace(/[\s\-.()]/g, '');
  if (!/^\d{7,15}$/.test(digits)) {
    throw usageError(`The phone must have the country code and only digits, for example 5491122334455: ${value}`);
  }
  return digits;
}

/** The message of an answer: `{message}` (the send), `{data}` or the resource itself (the read). */
function messageOf(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.message)) return body.message;
  if (isRecord(body.data)) return body.data;
  return 'status' in body || 'id' in body ? body : null;
}

const statusOf = (message: Record<string, unknown>): string | null => (typeof message.status === 'string' ? message.status : null);
const isFinal = (status: string | null): boolean => status === null || status === 'read' || status === 'failed';
const shown = (status: string | null): string => status ?? 'unknown';

export async function send(ctx: Context, phoneArg: string, words: string[], flags: SendFlags): Promise<void> {
  const phone = normalizePhone(phoneArg);
  const text = words.join(' ');
  if (text.trim() === '') throw usageError('The message has no text.');
  const timeout = flags.timeout === undefined ? SEND_TIMEOUT_SECONDS : seconds(flags.timeout, '--timeout');
  const picked = await pickDevice(ctx, flags.device, { qrOnly: false });
  const from = picked.device ? deviceLabel(picked.device) : `number ${picked.id}`;
  const client = ctx.client();

  ctx.out.progress(`Sending to ${phone} from ${from}…`);
  let answer: unknown;
  try {
    answer = await client.post(routes.sendMessage, { body: { device_id: picked.id, phone, text } });
  } catch (error) {
    throw explainSendError(error);
  }
  let message = messageOf(answer);
  const messageId = message?.id;
  const contactId = message?.contact_id;
  if (!message || messageId === undefined || messageId === null || contactId === undefined || contactId === null) {
    ctx.out.result({ device_id: picked.id, phone, message, outcome: 'not_watched' }, () =>
      `Sent to ${phone}, but the API did not return the message id: its status cannot be watched.`,
    );
    return;
  }

  const started = ctx.io.clock();
  const elapsed = () => Math.round((ctx.io.clock() - started) / 1000);
  let status = statusOf(message);
  const statuses: { status: string | null; seconds: number }[] = [{ status, seconds: 0 }];
  ctx.out.progress(`  ${shown(status)}`);
  const deadline = started + timeout * 1000;
  let delay = FIRST_POLL_MS;
  const ids = { message_id: messageId, contact_id: contactId };

  try {
    while (!isFinal(status) && ctx.io.clock() < deadline) {
      await pause(ctx, Math.min(delay, deadline - ctx.io.clock()));
      const read = messageOf(await client.get(routes.messageShow, { path: { contact: String(contactId), message: String(messageId) } }));
      if (!read) continue;
      message = read;
      const next = statusOf(read);
      if (next === status) {
        delay = Math.min(delay * 2, MAX_POLL_MS);
        continue;
      }
      status = next;
      statuses.push({ status, seconds: elapsed() });
      ctx.out.progress(`  ${shown(status).padEnd(10)} after ${elapsed()} s`);
      delay = FIRST_POLL_MS;
    }
  } catch (error) {
    throw alreadySent(error, ids, status);
  }

  if (status === 'failed') {
    const failure = isRecord(message.error) ? message.error : {};
    const why = [failure.title, failure.reason ?? failure.code].filter((v) => v !== null && v !== undefined && v !== '').map(String);
    throw new CliError(`The message failed${why.length ? `: ${why.join(' · ')}` : '.'}`, {
      exitCode: ExitCode.API,
      code: 'message_failed',
      hint: `Message ${String(messageId)} to ${phone} (contact ${String(contactId)}).`,
      details: { ...ids, status, error: message.error ?? null, statuses },
    });
  }

  const outcome = status === 'read' ? 'read' : status === null ? 'unknown' : timeout === 0 ? 'not_watched' : 'timeout';
  const where = `GET /api/v1/contacts/${String(contactId)}/messages/${String(messageId)}`;
  ctx.out.result({ device_id: picked.id, phone, message, statuses, outcome }, () => {
    const head = `Message ${String(messageId)} to ${phone}`;
    if (outcome === 'read') return `${head}: read ${elapsed()} s after sending.`;
    if (outcome === 'unknown') {
      return [`${head}: the provider did not confirm or reject the send. It may have arrived, and its status will not change.`];
    }
    if (outcome === 'not_watched') return [`${head}: ${shown(status)} (not watched: --timeout 0).`, `Its status: ${where}`];
    return [
      `${head}: ${shown(status)} after ${timeout} s; stopped watching (--timeout).`,
      ...(status === 'delivered' ? ['If the recipient turned read receipts off, it stays delivered.'] : []),
      `Its status keeps changing in Funnelchat: ${where}, or the message.status_changed webhook.`,
    ];
  });
}

/** A rejected send, in plain words, saying that nothing went out where the API guarantees it. */
function explainSendError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const add = (line: string) => {
    error.hint = [line, error.hint].filter(Boolean).join('\n');
  };
  if (error.status === 403 && (error.apiCode === undefined || error.apiCode === 'permission_denied')) {
    add('Sending needs conversations:send; to a phone that is not a contact yet it also needs conversations:write, because the send creates the contact.');
  } else if (error.status === 404 && error.apiCode !== 'route_not_found') {
    add('Nothing was sent. The phone may be a contact of another workspace of your account, or --device not one of your numbers.');
  } else if (error.status === 429 && error.apiCode === 'rate_limited') {
    add('Nothing was sent: the number is sending too fast (per second, or per minute to the same contact).');
  } else if (error.status === 422 && error.fieldErrors) {
    add('Nothing was sent.');
  }
  return error;
}

/** Any stop after the send: the message went out, and must not be sent again. */
function alreadySent(error: unknown, ids: { message_id: unknown; contact_id: unknown }, status: string | null): CliError {
  const cliError =
    error instanceof InterruptedError
      ? new CliError(`Stopped watching the message (Ctrl+C); its last status was ${shown(status)}.`, { exitCode: ExitCode.INTERRUPTED, code: 'interrupted' })
      : toCliError(error);
  if (error instanceof ApiError && error.status === 403) cliError.hint = [cliError.hint, 'Watching the status needs conversations:read.'].filter(Boolean).join('\n');
  const sent = `The message was sent (id ${String(ids.message_id)}, contact ${String(ids.contact_id)}): do not send it again. Its status: GET /api/v1/contacts/${String(ids.contact_id)}/messages/${String(ids.message_id)}`;
  cliError.hint = [cliError.hint, sent].filter(Boolean).join('\n');
  Object.assign(cliError.details, ids, { last_status: status });
  return cliError;
}
