/**
 * `login`, `logout`, `whoami` and `profiles`.
 *
 * The key is read from the terminal without echo, or from stdin (`funnelchat login < key.txt`), never
 * from a flag. It is checked against `GET /api/v1/me` before saving it (unless `--no-verify`).
 */
import { ApiError, InterruptedError, isRecord, usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context, Stdin } from '../context.js';
import { activeProfileName, checkKeyShape, PRODUCTION_URL, resolveBaseUrl } from '../config/credentials.js';
import { saveConfig } from '../config/store.js';
import { table } from '../output.js';

/** The account fields `whoami` shows. `/me` also returns a session `token`: it is never shown. */
const ACCOUNT_FIELDS = ['id', 'name', 'email', 'role', 'timezone', 'locale', 'effective_business_numbers_limit', 'effective_agents_limit'] as const;

export function accountSummary(me: unknown): Record<string, unknown> {
  const record = isRecord(me) && isRecord(me.data) && !('id' in me) ? me.data : me;
  const out: Record<string, unknown> = {};
  if (!isRecord(record)) return out;
  for (const field of ACCOUNT_FIELDS) if (field in record) out[field] = record[field];
  return out;
}

export interface LoginFlags {
  verify?: boolean;
}

export async function login(ctx: Context, flags: LoginFlags): Promise<void> {
  const { config } = ctx.config();
  const profile = activeProfileName(ctx.globals, ctx.io.env, config);
  const baseUrl = resolveBaseUrl(ctx.globals, ctx.io.env, config.profiles[profile]?.base_url);

  const raw = ctx.io.stdin.isTTY && ctx.io.stdin.setRawMode
    ? await promptHidden(ctx.io.stdin, ctx.io.stderr, 'Paste your Funnelchat API key (it is not shown) and press Enter: ')
    : await readAll(ctx.io.stdin);
  const key = checkKeyShape(raw);
  ctx.redactor.add(key);

  let account: Record<string, unknown> | null = null;
  let verified = false;
  if (flags.verify !== false) {
    try {
      account = accountSummary(await ctx.client({ apiKey: key, baseUrl }).get(routes.me));
      verified = true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        ctx.out.warn('the key is valid, but it lacks the accounts:read permission: `funnelchat whoami` and `funnelchat numbers` will not work with it.');
        verified = true;
      } else {
        throw error;
      }
    }
  }

  config.profiles[profile] = { api_key: key, base_url: baseUrl, saved_at: new Date(ctx.io.clock()).toISOString() };
  config.current_profile = profile;
  const path = saveConfig(ctx.io.env, config);
  if (ctx.io.env.FUNNELCHAT_API_KEY) ctx.out.warn('FUNNELCHAT_API_KEY is set: while it is, it wins over the saved profile (except with --profile).');

  ctx.out.result({ profile, base_url: baseUrl, config_file: path, verified, account }, () => [
    `Key saved in the "${profile}" profile (${path}, 0600 permissions).`,
    ...(account ? [`Account: ${String(account.name ?? '-')} (${String(account.email ?? '-')})`] : []),
    ...(baseUrl !== PRODUCTION_URL ? [`Base URL: ${baseUrl}`] : []),
    ...(!verified ? ['The key was not checked against the API (--no-verify).'] : []),
  ]);
}

export function logout(ctx: Context): void {
  const { config } = ctx.config();
  const profile = activeProfileName(ctx.globals, ctx.io.env, config);
  const existed = profile in config.profiles;
  delete config.profiles[profile];
  if (config.current_profile === profile) delete config.current_profile;
  const path = existed ? saveConfig(ctx.io.env, config) : ctx.config().path;
  ctx.out.result({ profile, removed: existed, config_file: path }, () =>
    existed ? `Deleted the key of the "${profile}" profile from ${path}.` : `The "${profile}" profile had no saved key.`,
  );
  if (ctx.io.env.FUNNELCHAT_API_KEY) ctx.out.warn('FUNNELCHAT_API_KEY is still set in your environment.');
}

export async function whoami(ctx: Context): Promise<void> {
  const credentials = ctx.credentials();
  const account = accountSummary(await ctx.client().get(routes.me));
  const keySource = credentials.keySource === 'env' ? 'from the FUNNELCHAT_API_KEY variable' : `from the "${credentials.profile}" profile`;
  ctx.out.result({ account, key_source: credentials.keySource, profile: credentials.keySource === 'profile' ? credentials.profile : null, base_url: credentials.baseUrl }, () => [
    `Account: ${String(account.name ?? '-')} (${String(account.email ?? '-')})`,
    `  id ${String(account.id ?? '-')} · role ${String(account.role ?? '-')} · time zone ${String(account.timezone ?? '-')} · language ${String(account.locale ?? '-')}`,
    `Key: ${keySource} (not shown)`,
    `Base URL: ${credentials.baseUrl}`,
  ]);
}

export function profilesList(ctx: Context): void {
  const { config, path } = ctx.config();
  const active = activeProfileName(ctx.globals, ctx.io.env, config);
  const rows = Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    active: name === active,
    base_url: profile.base_url ?? PRODUCTION_URL,
    has_key: Boolean(profile.api_key),
    saved_at: profile.saved_at ?? null,
  }));
  ctx.out.result({ config_file: path, active_profile: active, env_key: Boolean(ctx.io.env.FUNNELCHAT_API_KEY), profiles: rows }, () =>
    rows.length === 0
      ? `No saved profiles (${path}). Save one with \`funnelchat login\`.`
      : [
          ...table(
            ['', 'profile', 'base url', 'key', 'saved'],
            rows.map((r) => [r.active ? '*' : '', r.name, r.base_url, r.has_key ? 'yes' : 'no', r.saved_at]),
          ),
          ...(ctx.io.env.FUNNELCHAT_API_KEY ? ['', 'FUNNELCHAT_API_KEY is set: it wins over the active profile (except with --profile).'] : []),
        ],
  );
}

export function profilesUse(ctx: Context, name: string): void {
  const { config } = ctx.config();
  if (!config.profiles[name]) throw usageError(`There is no "${name}" profile.`, `Create it with \`funnelchat login --profile ${name}\`.`);
  config.current_profile = name;
  const path = saveConfig(ctx.io.env, config);
  ctx.out.result({ active_profile: name, config_file: path }, () => `Active profile: "${name}".`);
}

/** Reads a line from the terminal without echoing it. */
export function promptHidden(stdin: Stdin, stderr: { write(chunk: string): unknown }, question: string): Promise<string> {
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setEncoding?.('utf8');
    stdin.setRawMode?.(true);
    stdin.resume();
    const finish = (error?: Error) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      stderr.write('\n');
      if (error) reject(error);
      else resolve(value.replace(/\[20[01]~/g, ''));
    };
    stdin.on('data', (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new InterruptedError());
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    });
  });
}

/** Reads all of stdin (a key piped in or redirected from a file). */
export function readAll(stdin: Stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setEncoding?.('utf8');
    stdin.on('data', (chunk) => {
      value += String(chunk);
    });
    stdin.on('end', () => resolve(value.trim()));
    stdin.on('error', reject);
    stdin.resume();
  });
}
