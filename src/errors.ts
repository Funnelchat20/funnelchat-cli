/**
 * Errors of the CLI and their exit codes. Every failure that reaches the user is a {@link CliError}:
 * it carries the exit code, a stable `code` for scripts (`--json`) and, when there is one, a hint
 * with what to do next.
 */

/** Exit codes. Documented in the README ("Códigos de salida"); scripts can rely on them. */
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
  /** A limit the CLI does not wait for: daily cap, hourly limit or a `Retry-After` too long. Resumable. */
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

  constructor(init: ApiErrorInit) {
    const record = isRecord(init.body) ? init.body : undefined;
    const apiCode = typeof record?.error === 'string' && record.error !== '' ? record.error : undefined;
    const apiMessage = typeof record?.message === 'string' && record.message !== '' ? record.message : undefined;
    const fieldErrors = isRecord(record?.errors) ? (record.errors as FieldErrors) : undefined;
    const described = describe(init, apiCode, apiMessage, fieldErrors);
    const { exitCode, message } = init.override ?? described;
    const hint = init.override ? undefined : described.hint;
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
        ...init.override?.details,
      },
    });
    this.status = init.status;
    this.apiCode = apiCode;
    this.retryAfter = init.retryAfter;
    this.fieldErrors = fieldErrors;
    this.route = init.route;
    this.domain = init.domain;
  }
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
      message: `La API rechazó la clave (401 en ${where})${said}`,
      hint: 'Revisá que la clave esté completa (con el `<id>|` del principio) y siga activa, y volvé a correr `funnelchat login`.',
    };
  }
  if (status === 403) {
    const permission = init.permission ? ` Esta ruta pide \`${init.permission}\`.` : '';
    return {
      exitCode: ExitCode.AUTH,
      message: `La clave no puede usar ${where} (403${apiCode ? ` ${apiCode}` : ''})${said}`,
      hint: apiCode === 'route_not_available' ? 'Ninguna clave la habilita por ahora.' : `Creá una clave con el permiso que falta.${permission}`,
    };
  }
  if (status === 404) {
    return { exitCode: ExitCode.NOT_FOUND, message: `No existe en tu cuenta (404 en ${where})${said}` };
  }
  if (status === 429) {
    return { exitCode: ExitCode.RATE_LIMITED, message: `La API pidió esperar (429${apiCode ? ` ${apiCode}` : ''} en ${where})${said}` };
  }
  if (status === 422 && fieldErrors) {
    const first = Object.entries(fieldErrors)[0];
    const detail = first ? ` ${first[0]}: ${first[1]?.[0] ?? ''}` : '';
    return { exitCode: ExitCode.API, message: `La API no aceptó la consulta (422 en ${where})${said}${detail ? `\n ${detail}` : ''}` };
  }
  return { exitCode: ExitCode.API, message: `La API respondió ${status}${apiCode ? ` ${apiCode}` : ''} en ${where}${said}` };
}

/** The request never got an answer: DNS, connection refused, reset, TLS, timeout. */
export class ConnectionError extends CliError {
  constructor(message: string, cause?: unknown) {
    super(message, { exitCode: ExitCode.API, code: 'connection_error', hint: 'Revisá tu conexión y la URL base, y volvé a intentar.', cause });
  }
}

export class InterruptedError extends CliError {
  constructor() {
    super('Se interrumpió.', { exitCode: ExitCode.INTERRUPTED, code: 'interrupted' });
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
