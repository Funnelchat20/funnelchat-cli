/**
 * Errors of the CLI and their exit codes. Every failure that reaches the user is a {@link CliError}:
 * it carries the exit code, a stable `code` for scripts (`--json`) and, when there is one, a hint
 * with what to do next.
 */

/** Exit codes. Documented in the README ("Exit codes"); scripts can rely on them. */
export const ExitCode = {
  OK: 0,
  /** Something the CLI did not expect. */
  UNEXPECTED: 1,
  /** Wrong command, option or value; or `--resume` with options that differ from the original run. */
  USAGE: 2,
  /** No key, a key the API rejects (`401`), or a key without the permission the route needs (`403`). */
  AUTH: 3,
  /** The resource does not exist in the account, or belongs to another one: `404 not_found` for both. */
  NOT_FOUND: 4,
  /** A limit the CLI does not wait for: the daily cap or a `Retry-After` too long. Resumable. */
  RATE_LIMITED: 5,
  /**
   * The API failed (`5xx`, `422`…) or could not be reached, after the retries; the account's payment is
   * overdue (`402 payment_required`); or a sent message failed.
   */
  API: 6,
  /** The output already exists: the CLI never overwrites a file. */
  EXISTS: 7,
  /** The CLI waited and it did not happen: no number connected within `connect --timeout`. */
  TIMEOUT: 8,
  /** Interrupted with Ctrl+C. An export can be resumed. */
  INTERRUPTED: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface CliErrorOptions {
  exitCode: ExitCodeValue;
  /** Stable code for scripts, for example `daily_cap_exceeded` or `output_exists`. */
  code: string;
  /** What to do next, in one or two lines. */
  hint?: string;
  /** Extra machine-readable details for `--json`. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CliError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly code: string;
  hint: string | undefined;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: CliErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.exitCode = options.exitCode;
    this.code = options.code;
    this.hint = options.hint;
    this.details = { ...options.details };
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, { exitCode: ExitCode.USAGE, code: 'usage', ...(hint ? { hint } : {}) });
}

/** Validation details of a Laravel `422`: field name -> messages. */
export type FieldErrors = Record<string, string[]>;

export interface ApiErrorInit {
  status: number;
  body: unknown;
  retryAfter: number | undefined;
  method: string;
  /** Route template (`/api/v1/contacts/{contact}`), never the URL with its query. */
  route: string;
  domain: string | null;
  permission: string | null;
  /** `X-Request-Id` of the response: the id support finds the call by. */
  requestId?: string | undefined;
  /** Replaces the default description (used when the CLI decides to stop on a long wait). */
  override?: { message: string; exitCode: ExitCodeValue; details?: Record<string, unknown> };
}

/** The API answered with a non-2xx status. */
export class ApiError extends CliError {
  readonly status: number;
  /** The stable `error` code of the body (`daily_cap_exceeded`, `permission_denied`…), when there is one. */
  readonly apiCode: string | undefined;
  /** Seconds from `Retry-After`, when present. */
  readonly retryAfter: number | undefined;
  readonly fieldErrors: FieldErrors | undefined;
  readonly route: string;
  readonly domain: string | null;
  /** `X-Request-Id` of the response, when it had one. */
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    const record = isRecord(init.body) ? init.body : undefined;
    const apiCode = typeof record?.error === 'string' && record.error !== '' ? record.error : undefined;
    const apiMessage = typeof record?.message === 'string' && record.message !== '' ? record.message : undefined;
    const fieldErrors = isRecord(record?.errors) ? (record.errors as FieldErrors) : undefined;
    const described = describe(init, apiCode, apiMessage, fieldErrors);
    const { exitCode, message } = init.override ?? described;
    const hint = withRequestId(init.override ? undefined : described.hint, init.requestId);
    super(message, {
      exitCode,
      code: apiCode ?? `http_${init.status}`,
      ...(hint ? { hint } : {}),
      details: {
        status: init.status,
        route: `${init.method} ${init.route}`,
        ...(apiCode ? { api_error: apiCode } : {}),
        ...(init.retryAfter !== undefined ? { retry_after: init.retryAfter } : {}),
        ...(fieldErrors ? { errors: fieldErrors } : {}),
        ...(init.requestId ? { request_id: init.requestId } : {}),
        ...init.override?.details,
      },
    });
    this.status = init.status;
    this.apiCode = apiCode;
    this.retryAfter = init.retryAfter;
    this.fieldErrors = fieldErrors;
    this.route = init.route;
    this.domain = init.domain;
    this.requestId = init.requestId;
  }
}

/** The hint plus the line with the id to cite, when the response had one. */
function withRequestId(hint: string | undefined, requestId: string | undefined): string | undefined {
  if (!requestId) return hint;
  const cite = `Request id (X-Request-Id): ${requestId}. Quote it, with the approximate time, if you report this to support.`;
  return hint ? `${hint}\n${cite}` : cite;
}

/**
 * The stable `error` codes the commands can get, in plain words (the API's own `message` is in Spanish and
 * changes by area). The exit code still comes from the status. `payment_required` is declared by the spec
 * since portal v0.6.15 for most routes, those of `send` and `connect` included. The others, all in production:
 * conversations v1.19.21 (sends of a key), accounts v1.5.97 (connect links) and communities v2.35.7
 * (following a group), as the full unified spec of developers-portal 99928866 and funnelchat-node
 * feat/seguir-un-grupo @ f913feb (src/core/error-codes.ts) list them.
 */
export const KNOWN_API_ERRORS: Readonly<Record<string, { message: string; hint?: string }>> = {
  // any route
  payment_required: {
    message: 'The account\'s payment is overdue: the API does not take calls from it until it is settled.',
    hint: 'Settle it in the Funnelchat panel. Retrying does not help.',
  },
  // send
  window_closed: {
    message: 'WhatsApp does not let this number send free text to this contact now: on an official number, free text only goes out within 24 hours of the contact\'s last message, so the first message to a new contact has to be a template.',
    hint: 'Nothing was sent. Ask the contact to write to you first, or send from a number connected by QR.',
  },
  recipient_mismatch: { message: 'The phone is not the one of that contact.', hint: 'Nothing was sent.' },
  recipient_unsupported: { message: 'That recipient is a group, a broadcast list or a channel: `send` writes to a person.', hint: 'Nothing was sent.' },
  antiblock_duplicate_content: {
    message: 'The same text was already sent too many times to a contact that did not answer: Funnelchat stopped it to protect the number.',
    hint: 'Nothing was sent.',
  },
  antiblock_unanswered_limit: {
    message: 'Too many messages in a row to a contact that did not answer: Funnelchat stopped it to protect the number.',
    hint: 'Nothing was sent. Wait for the contact to answer.',
  },
  device_unavailable: { message: 'The number is not connected or cannot send now.', hint: 'Nothing was sent. Check it with `funnelchat numbers list`.' },
  not_sent: { message: 'The message could not be registered for sending.', hint: 'Nothing was sent.' },
  mac_lockout_24h: { message: 'The account used up its monthly active contacts (MACs) and is locked for 24 hours.', hint: 'Nothing was sent. Retrying does not help: see `funnelchat mac status`.' },
  mac_limit_reached: { message: 'The account used up its monthly active contacts (MACs).', hint: 'Nothing was sent. Retrying does not help: see `funnelchat mac status`.' },
  // connect
  numbers_not_included: { message: 'Your plan does not include WhatsApp numbers.', hint: 'No link was created. Change the plan from the panel.' },
  number_limit_reached: { message: 'Every number of your plan is in use.', hint: 'No link was created. Delete a number or change the plan from the panel.' },
  connect_not_allowed: { message: 'Only the owner of the account can connect numbers, and this key is not the owner\'s.', hint: 'No link was created.' },
  too_many_open_links: { message: 'The account already has 20 connect links open.', hint: 'No link was created. They end when they are used or expire.' },
  // connect --device and --us-number
  invalid_reference_device: { message: 'That number is not one of your account\'s numbers.', hint: 'No link was created. See them with `funnelchat numbers list`.' },
  connection_type_mismatch: {
    message: 'The link is not of the number\'s type: a number connected by QR reconnects by QR, and an official one through Meta.',
    hint: 'No link was created. The number may have changed since it was listed: check it with `funnelchat numbers list` and try again.',
  },
  meta_connect_disabled: { message: 'Connecting official numbers by link is not enabled right now.', hint: 'No link was created. Try again later.' },
  // groups
  provider_unsupported: { message: 'The number cannot do that: only a number connected by QR can follow groups.' },
  group_not_found: {
    message: 'That group is not one of the number\'s groups (or it belongs to another workspace of the account).',
    hint: 'List them with `funnelchat groups` and use the uid it shows.',
  },
  device_not_found: { message: 'That number is not one of the account (or of this key\'s workspace).', hint: 'See them with `funnelchat numbers list`.' },
  device_not_connected: { message: 'The number is not connected.', hint: 'See it with `funnelchat numbers list`.' },
  device_not_group_admin: { message: 'The number is not an admin of that group.' },
  unsupported_group_type: { message: 'That uid is a community or a channel, not a group.' },
  import_permission_required: { message: 'Following a group needs the Groups and campaigns → Manage groups permission (`communities:operate`).', hint: 'Create a key with that permission.' },
  import_rate_limited: { message: 'This number already followed 5 groups in the last minute.' },
  import_in_progress: { message: 'That group is being imported right now.', hint: 'Try again in a few seconds.' },
};

function exitCodeOf(status: number): ExitCodeValue {
  if (status === 401 || status === 403) return ExitCode.AUTH;
  if (status === 404) return ExitCode.NOT_FOUND;
  if (status === 429) return ExitCode.RATE_LIMITED;
  return ExitCode.API;
}

function describe(
  init: ApiErrorInit,
  apiCode: string | undefined,
  apiMessage: string | undefined,
  fieldErrors: FieldErrors | undefined,
): { exitCode: ExitCodeValue; message: string; hint?: string } {
  const where = `${init.method} ${init.route}`;
  const said = apiMessage ? `: ${apiMessage}` : '.';
  const { status } = init;
  if (status === 401) {
    return {
      exitCode: ExitCode.AUTH,
      message: `The API rejected the key (401 on ${where})${said}`,
      hint: 'Check that the key is complete (with the `<id>|` at the start) and still active, and run `funnelchat login` again.',
    };
  }
  const known = apiCode !== undefined && Object.hasOwn(KNOWN_API_ERRORS, apiCode) ? KNOWN_API_ERRORS[apiCode] : undefined;
  if (known) {
    return { exitCode: exitCodeOf(status), message: `${known.message} (${status} ${apiCode} on ${where})`, ...(known.hint ? { hint: known.hint } : {}) };
  }
  if (status === 403) {
    const permission = init.permission ? ` This route needs \`${init.permission}\`.` : '';
    return {
      exitCode: ExitCode.AUTH,
      message: `The key cannot use ${where} (403${apiCode ? ` ${apiCode}` : ''})${said}`,
      hint: apiCode === 'route_not_available' ? 'No key enables it for now.' : `Create a key with the missing permission.${permission}`,
    };
  }
  if (status === 404 && apiCode === 'route_not_found') {
    return {
      exitCode: ExitCode.NOT_FOUND,
      message: `The route does not exist in the API (404 route_not_found on ${where}).`,
      hint: 'The CLI only calls routes of the API reference: check that the base URL is the public API\'s (https://api.funnelchat.com) and that you have the latest version of the CLI.',
    };
  }
  if (status === 404) {
    return { exitCode: ExitCode.NOT_FOUND, message: `Not found in your account (404 on ${where})${said}` };
  }
  if (status === 429) {
    return { exitCode: ExitCode.RATE_LIMITED, message: `The API asked to wait (429${apiCode ? ` ${apiCode}` : ''} on ${where})${said}` };
  }
  if (status === 422 && fieldErrors) {
    const first = Object.entries(fieldErrors)[0];
    const detail = first ? ` ${first[0]}: ${first[1]?.[0] ?? ''}` : '';
    return { exitCode: ExitCode.API, message: `The API did not accept the request (422 on ${where})${said}${detail ? `\n ${detail}` : ''}` };
  }
  if (status === 500 && apiCode === 'edge_misconfigured') {
    return {
      exitCode: ExitCode.API,
      message: `The API is not available right now (500 edge_misconfigured on ${where}): the API's entry point is not configured to reach this area.`,
      hint: 'It is a problem on Funnelchat\'s side: please report it.',
    };
  }
  if (status === 502 && apiCode === 'origin_unreachable') {
    return {
      exitCode: ExitCode.API,
      message: `The API is not available right now (502 origin_unreachable on ${where}): the API's entry point could not reach the area that serves the route.`,
      hint: 'Try again in a few minutes; if it persists, please report it.',
    };
  }
  return { exitCode: ExitCode.API, message: `The API answered ${status}${apiCode ? ` ${apiCode}` : ''} on ${where}${said}` };
}

/** The request never got an answer: DNS, connection refused, reset, TLS, timeout. */
export class ConnectionError extends CliError {
  constructor(message: string, cause?: unknown) {
    super(message, { exitCode: ExitCode.API, code: 'connection_error', hint: 'Check your connection and the base URL, and try again.', cause });
  }
}

export class InterruptedError extends CliError {
  constructor() {
    super('Interrupted.', { exitCode: ExitCode.INTERRUPTED, code: 'interrupted' });
  }
}

/**
 * Seconds to wait from a `Retry-After` header: delta-seconds (`"30"`) or an HTTP date.
 * `undefined` when absent or unreadable. (Copied from funnelchat-node feat/inicial @ de14b86,
 * src/core/errors.ts.)
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
