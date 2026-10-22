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
  /** The resource does not exist in the account (`404`). */
  NOT_FOUND: 4,
  /** A limit the CLI does not wait for: the daily cap or a `Retry-After` too long. Resumable. */
  RATE_LIMITED: 5,
  /** The API failed (`5xx`, `422`…) or could not be reached, after the retries. */
  API: 6,
  /** The output already exists: the CLI never overwrites a file. */
  EXISTS: 7,
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
