/**
 * What a command gets: the process streams and environment (injected, so tests run without a
 * network, without a real key and without touching the user's files), the output, and the API
 * client, built only when a command needs it.
 */
import { usageError } from './errors.js';
import { ApiClient } from './http/client.js';
import { DEFAULT_RATE, MAX_RATE, Pacer, type Sleep } from './http/pacer.js';
import { Redactor } from './http/redact.js';
import { loadConfig, type LoadedConfig } from './config/store.js';
import { resolveCredentials, type ConnectionFlags, type ResolvedCredentials } from './config/credentials.js';
import { Output, type Writer } from './output.js';

export interface Stdin {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeAllListeners(event?: string): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
}

export interface Io {
  stdout: Writer;
  stderr: Writer;
  stdin: Stdin;
  env: Record<string, string | undefined>;
  cwd: string;
  fetch: typeof fetch;
  sleep: Sleep;
  clock: () => number;
  /** Aborted on Ctrl+C. */
  signal?: AbortSignal;
}

export interface GlobalOptions extends ConnectionFlags {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  rate?: string | undefined;
  maxWait?: string | undefined;
}

export class Context {
  readonly redactor = new Redactor();
  readonly out: Output;
  #config: LoadedConfig | undefined;
  #credentials: ResolvedCredentials | undefined;
  #client: ApiClient | undefined;
  #warnedConfig = false;

  constructor(
    readonly io: Io,
    readonly globals: GlobalOptions,
  ) {
    this.redactor.add(io.env.FUNNELCHAT_API_KEY);
    this.out = new Output(io.stdout, io.stderr, this.redactor, { json: globals.json === true, quiet: globals.quiet === true, verbose: globals.verbose === true });
  }

  config(): LoadedConfig {
    if (!this.#config) {
      this.#config = loadConfig(this.io.env);
      for (const profile of Object.values(this.#config.config.profiles)) this.redactor.add(profile.api_key);
      if (this.#config.insecurePermissions && !this.#warnedConfig) {
        this.#warnedConfig = true;
        this.out.warn(`otros usuarios de esta máquina pueden leer ${this.#config.path}. Corrígelo con: chmod 600 "${this.#config.path}"`);
      }
    }
    return this.#config;
  }

  credentials(): ResolvedCredentials {
    if (!this.#credentials) {
      this.#credentials = resolveCredentials(this.globals, this.io.env, this.config().config);
      this.redactor.add(this.#credentials.apiKey);
    }
    return this.#credentials;
  }

  client(overrides: { apiKey?: string; baseUrl?: string } = {}): ApiClient {
    if (!overrides.apiKey && this.#client) return this.#client;
    const apiKey = overrides.apiKey ?? this.credentials().apiKey;
    const baseUrl = overrides.baseUrl ?? this.credentials().baseUrl;
    this.redactor.add(apiKey);
    const client = new ApiClient({
      apiKey,
      baseUrl,
      fetch: this.io.fetch,
      pacer: new Pacer(this.rate(), this.io.clock, this.io.sleep),
      sleep: this.io.sleep,
      clock: this.io.clock,
      maxWaitSeconds: this.maxWait(),
      log: (line) => this.out.verbose(line),
      ...(this.io.signal ? { signal: this.io.signal } : {}),
    });
    if (!overrides.apiKey) this.#client = client;
    return client;
  }

  /** Requests per second: `--rate`, then `FUNNELCHAT_RATE`, then 1. */
  rate(): number {
    const raw = this.globals.rate ?? this.io.env.FUNNELCHAT_RATE;
    if (raw === undefined || raw === '') return DEFAULT_RATE;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_RATE) {
      throw usageError(`--rate tiene que ser un número mayor que 0 y hasta ${MAX_RATE} (pedidos por segundo): ${raw}`);
    }
    return value;
  }

  /** The longest `Retry-After` waited for by itself: `--max-wait`, by default 60 s. */
  maxWait(): number {
    const raw = this.globals.maxWait;
    if (raw === undefined) return 60;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 3600) throw usageError(`--max-wait tiene que ser un entero de 0 a 3600 (segundos): ${raw}`);
    return value;
  }
}
