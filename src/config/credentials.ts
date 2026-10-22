/**
 * Which key and which base URL a command uses.
 *
 * Key: an explicit `--profile` wins; otherwise `FUNNELCHAT_API_KEY`; otherwise the active profile
 * (`FUNNELCHAT_PROFILE`, then the one `login` left active, then `default`). The key is never taken
 * from a command-line flag, so it does not end up in the shell history or in `ps`.
 *
 * Base URL: `--base-url`, then `--staging`, then `FUNNELCHAT_BASE_URL`, then the profile's, then
 * production. Plain `http` is accepted only for this machine (the sandbox), never to send a key
 * across the network.
 */
import { CliError, ExitCode, usageError } from '../errors.js';
import type { ConfigFile } from './store.js';

export const PRODUCTION_URL = 'https://api.funnelchat.com';
export const STAGING_URL = 'https://api-staging.funnelchat.com';
export const DEFAULT_PROFILE = 'default';

/** `<numeric id>|fc_live_<letters and digits>`, the shape the API mints. */
const KEY_SHAPE = /^\d+\|fc_[a-z]+_[A-Za-z0-9]+$/;

export interface ConnectionFlags {
  profile?: string | undefined;
  baseUrl?: string | undefined;
  staging?: boolean | undefined;
}

export type KeySource = 'env' | 'profile';

export interface ResolvedCredentials {
  apiKey: string;
  keySource: KeySource;
  /** The profile the key came from, or the active profile when it came from the environment. */
  profile: string;
  baseUrl: string;
}

export function activeProfileName(flags: ConnectionFlags, env: Record<string, string | undefined>, config: ConfigFile): string {
  return flags.profile ?? nonEmpty(env.FUNNELCHAT_PROFILE) ?? config.current_profile ?? DEFAULT_PROFILE;
}

export function checkKeyShape(key: string): string {
  const trimmed = key.trim();
  if (!KEY_SHAPE.test(trimmed)) {
    throw new CliError('La clave no tiene la forma de una clave de Funnelchat (`<id>|fc_live_…`).', {
      exitCode: ExitCode.AUTH,
      code: 'malformed_key',
      hint: 'Cópiala completa desde la pantalla Desarrolladores de tu cuenta, incluido el `<id>|` del principio.',
    });
  }
  return trimmed;
}

export function resolveBaseUrl(flags: ConnectionFlags, env: Record<string, string | undefined>, profileUrl: string | undefined): string {
  if (flags.baseUrl && flags.staging) throw usageError('Usa --base-url o --staging, no los dos.');
  const raw = flags.baseUrl ?? (flags.staging ? STAGING_URL : undefined) ?? nonEmpty(env.FUNNELCHAT_BASE_URL) ?? profileUrl ?? PRODUCTION_URL;
  return checkBaseUrl(raw);
}

export function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`La URL base no es válida: ${raw}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw usageError(
      `La URL base tiene que ser https (${raw}).`,
      'Solo se acepta http para esta máquina (por ejemplo el sandbox en http://127.0.0.1:4010), para que la clave no viaje sin cifrar.',
    );
  }
  if (url.search || url.hash) throw usageError(`La URL base no lleva query ni #: ${raw}`);
  return url.toString().replace(/\/+$/, '');
}

export function resolveCredentials(flags: ConnectionFlags, env: Record<string, string | undefined>, config: ConfigFile): ResolvedCredentials {
  const profileName = activeProfileName(flags, env, config);
  const profile = config.profiles[profileName];
  const envKey = nonEmpty(env.FUNNELCHAT_API_KEY);

  if (flags.profile === undefined && envKey) {
    return { apiKey: checkKeyShape(envKey), keySource: 'env', profile: profileName, baseUrl: resolveBaseUrl(flags, env, undefined) };
  }
  if (profile?.api_key) {
    return { apiKey: checkKeyShape(profile.api_key), keySource: 'profile', profile: profileName, baseUrl: resolveBaseUrl(flags, env, profile.base_url) };
  }
  if (flags.profile !== undefined) {
    throw new CliError(`El perfil "${flags.profile}" no tiene clave guardada.`, {
      exitCode: ExitCode.AUTH,
      code: 'no_key',
      hint: `Guárdala con \`funnelchat login --profile ${flags.profile}\`.`,
    });
  }
  throw new CliError('No hay clave de API.', {
    exitCode: ExitCode.AUTH,
    code: 'no_key',
    hint: 'Define la variable FUNNELCHAT_API_KEY o guárdala con `funnelchat login`.',
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value.trim() : undefined;
}
