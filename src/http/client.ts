/**
 * A small HTTP client for the public API, only what the CLI needs.
 *
 * Adapted from funnelchat-node, branch feat/inicial @ de14b86 (src/client.ts and src/core/retry.ts):
 * the same request shape, body parsing and per-attempt timeout. What changes for a CLI that pages
 * through whole accounts:
 *
 * - **Only reads are retried** (`GET`). The CLI sends nothing else today; anything else would never be
 *   retried automatically.
 * - **`429` and `503` honour `Retry-After`**: the CLI waits exactly that, up to `maxWaitSeconds`. A longer
 *   wait (a daily cap can ask for hours) stops the command with exit code 5 and the time it resets.
 * - **`5xx` and network errors back off exponentially** (1 s, 2 s, 4 s… up to 30 s, with jitter).
 * - **Every attempt goes through the pacer** (default 1 request per second).
 * - **The key is never logged**: `--verbose` shows method, URL, status and timing, never headers.
 * - **`X-Request-Id`**: every answer of the API carries one, errors included (portal, autenticacion.md,
 *   from developers-portal main @ c8ddcbe; api-edge v0.3.0 and platform-gate 0.8 send it). `--verbose`
 *   shows it on each answer and every {@link ApiError} carries it, so an error can be cited to support.
 * - **`500 edge_misconfigured` is not retried**: the API's entry is not configured to reach the domain, and
 *   waiting does not change that. `502 origin_unreachable` is, like any `5xx` of a read.
 */
import { ApiError, ConnectionError, ExitCode, InterruptedError, parseRetryAfter } from '../errors.js';
import type { RouteInfo } from '../generated/routes.js';
import { CLI_NAME, VERSION } from '../version.js';
import { extractItems, followingPage, type PageQuery } from './pagination.js';
import type { Pacer, Sleep } from './pacer.js';
import { interpolatePath, joinUrl, serializeQuery } from './url.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 4;
/** The longest `Retry-After` the CLI waits for by itself. */
export const DEFAULT_MAX_WAIT_SECONDS = 60;
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;

/** Domains with a daily call cap per key (10 000 per day each, per the portal). conversations has none. */
export const DAILY_CAP_DOMAINS: readonly string[] = ['accounts', 'communities'];

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  pacer: Pacer;
  sleep: Sleep;
  clock: () => number;
  timeoutMs?: number;
  maxRetries?: number;
  maxWaitSeconds?: number;
  /** Verbose log, one line per attempt. Never receives the key. */
  log?: (line: string) => void;
  /** Aborts every request (Ctrl+C). */
  signal?: AbortSignal;
  random?: () => number;
}

export interface RequestOptions {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
}

export interface FetchedPage<T> {
  items: T[];
  body: unknown;
  /** The query of the next page, or `null` on the last one. */
  next: PageQuery | null;
}

export class ApiClient {
  readonly baseUrl: string;
  /** Requests sent, retries included. */
  requests = 0;

  readonly #apiKey: string;
  readonly #options: ClientOptions;

  constructor(options: ClientOptions) {
    this.#apiKey = options.apiKey;
    this.#options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** What `JSON.stringify(client)` shows: never the key. */
  toJSON(): { baseUrl: string } {
    return { baseUrl: this.baseUrl };
  }

  /** One `GET` of `route`, with retries. Returns the parsed body. */
  async get<T = unknown>(route: RouteInfo, options: RequestOptions = {}): Promise<T> {
    return (await this.#send(route, options)) as T;
  }

  /** One page of a listing route, and the query of the page after it. */
  async page<T = unknown>(route: RouteInfo, options: RequestOptions = {}): Promise<FetchedPage<T>> {
    const body = await this.#send(route, options);
    return { items: extractItems<T>(body), body, next: followingPage(body, options.query ?? {}) };
  }

  /** Every item of every page of a listing route. */
  async *all<T = unknown>(route: RouteInfo, options: RequestOptions = {}): AsyncGenerator<T, void, undefined> {
    let query: Record<string, unknown> = { ...options.query };
    for (;;) {
      const page = await this.page<T>(route, { ...options, query });
      yield* page.items;
      if (!page.next) return;
      query = mergeNext(query, page.next);
    }
  }

  async #send(route: RouteInfo, options: RequestOptions): Promise<unknown> {
    const opts = this.#options;
    const method = route.method;
    const pathname = interpolatePath(route.path, options.path);
    const url = joinUrl(this.baseUrl, pathname, serializeQuery(options.query));
    const maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    const maxWait = opts.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;
    const retriesAllowed = method === 'GET';
    const random = opts.random ?? Math.random;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': 'es',
      'User-Agent': `${CLI_NAME}/${VERSION} node/${process.version}`,
      Authorization: `Bearer ${this.#apiKey}`,
    };

    for (let attempt = 0; ; attempt++) {
      const canRetry = retriesAllowed && attempt < maxRetries;
      await opts.pacer.wait(opts.signal);
      this.requests++;
      const started = opts.clock();
      opts.log?.(`→ ${method} ${url}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);

      let response: Response;
      let text: string;
      try {
        ({ response, text } = await this.#attempt(method, url, headers));
      } catch (error) {
        if (error instanceof InterruptedError) throw error;
        if (canRetry) {
          const delay = backoffMs(attempt, random);
          opts.log?.(`← ${describeConnectionError(error)}; retrying in ${formatSeconds(delay / 1000)}`);
          await this.#sleep(delay);
          continue;
        }
        throw error;
      }

      const requestId = response.headers.get('x-request-id') ?? undefined;
      opts.log?.(`← ${response.status} in ${opts.clock() - started} ms${requestId ? ` · X-Request-Id ${requestId}` : ''}`);
      const body = parseBody(response, text);
      if (response.ok) return body;

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), opts.clock());
      const error = new ApiError({
        status: response.status,
        body,
        retryAfter,
        method,
        route: route.path,
        domain: route.domain,
        permission: route.permission,
        requestId,
      });

      const retryable = response.status === 429 || (response.status >= 500 && error.apiCode !== 'edge_misconfigured');
      if (!retryable) throw error;

      if (retryAfter !== undefined && retryAfter > maxWait) {
        throw stopForLongWait(error, retryAfter, opts.clock());
      }
      if (!canRetry) {
        if (response.status === 429) error.hint = [`Wait ${formatSeconds(retryAfter ?? 60)} and try again.`, error.hint].filter(Boolean).join('\n');
        throw error;
      }
      const delay = retryAfter !== undefined ? Math.ceil(retryAfter * 1000) : backoffMs(attempt, random);
      opts.log?.(`  ${response.status}${error.apiCode ? ` ${error.apiCode}` : ''}: waiting ${formatSeconds(delay / 1000)}${retryAfter !== undefined ? ' (Retry-After)' : ''}`);
      await this.#sleep(delay);
    }
  }

  async #sleep(ms: number): Promise<void> {
    try {
      await this.#options.sleep(ms, this.#options.signal);
    } catch (error) {
      if (this.#options.signal?.aborted) throw new InterruptedError();
      throw error;
    }
  }

  async #attempt(method: string, url: string, headers: Record<string, string>): Promise<{ response: Response; text: string }> {
    const signal = this.#options.signal;
    if (signal?.aborted) throw new InterruptedError();
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const classify = (cause: unknown): Error => {
      if (signal?.aborted) return new InterruptedError();
      if (timedOut) return new ConnectionError(`The Funnelchat API did not answer within ${timeoutMs / 1000} s.`, cause);
      return new ConnectionError(`Could not connect to the Funnelchat API (${hostOf(url)}).`, cause);
    };

    try {
      let response: Response;
      try {
        response = await this.#options.fetch(url, { method, headers, signal: controller.signal });
      } catch (error) {
        throw classify(error);
      }
      try {
        return { response, text: await response.text() };
      } catch (error) {
        throw classify(error);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** The query of the next page: `{ cursor }` drops `page` and the other way around. */
export function mergeNext(query: Record<string, unknown>, next: PageQuery): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...query, ...next };
  if ('cursor' in next) delete merged.page;
  if ('page' in next) delete merged.cursor;
  return merged;
}

/** Exponential backoff with up to 25 % of jitter: 1 s, 2 s, 4 s… up to 30 s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(base * (1 - 0.25 * random()));
}

/** A `429`/`503` whose `Retry-After` is longer than the CLI waits for: stop, and say when it resets. */
function stopForLongWait(error: ApiError, retryAfter: number, now: number): ApiError {
  const at = new Date(now + retryAfter * 1000);
  const when = `${formatSeconds(retryAfter)} (at ${at.toISOString().slice(11, 16)} UTC on ${at.toISOString().slice(0, 10)})`;
  let message: string;
  if (error.apiCode === 'daily_cap_exceeded') {
    const domain = error.domain ?? 'this area';
    message = `The daily cap of calls to ${domain} was reached for this key. It resets in ${when}.`;
  } else {
    message = `${error.message} The API asks to wait ${when}, longer than the CLI waits on its own.`;
  }
  return new ApiError({
    status: error.status,
    body: error.apiCode ? { error: error.apiCode } : null,
    retryAfter,
    method: 'GET',
    route: error.route,
    domain: error.domain,
    permission: null,
    requestId: error.requestId,
    override: {
      message,
      exitCode: error.status === 429 ? ExitCode.RATE_LIMITED : ExitCode.API,
      details: { resets_at: at.toISOString() },
    },
  });
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${h} h${m ? ` ${m} min` : ''}`;
}

/** The decoded body: JSON when it parses, the text otherwise, `null` when there is none (a `204`). */
function parseBody(response: Response, text: string): unknown {
  if (text === '') return null;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text.length <= 300 ? text : `${text.slice(0, 300)}…`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describeConnectionError(error: unknown): string {
  return error instanceof Error ? error.message : 'network error';
}
