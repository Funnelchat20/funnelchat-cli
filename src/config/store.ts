/**
 * The user's configuration file: profiles with a key and a base URL.
 *
 * - Where: `FUNNELCHAT_CONFIG_DIR`, or `%APPDATA%\funnelchat` on Windows, or
 *   `$XDG_CONFIG_HOME/funnelchat` (by default `~/.config/funnelchat`).
 * - The folder is created with permissions 0700 and the file is always written as 0600, through a
 *   temporary file and a rename, so a half-written file never replaces a good one.
 * - Reading a file that others can read is allowed but warned about, like ssh does.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, ExitCode, isRecord } from '../errors.js';

export const CONFIG_FILE_NAME = 'config.json';

export interface Profile {
  api_key?: string;
  base_url?: string;
  saved_at?: string;
}

export interface ConfigFile {
  version: 1;
  current_profile?: string;
  profiles: Record<string, Profile>;
}

export function configDir(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  if (env.FUNNELCHAT_CONFIG_DIR) return env.FUNNELCHAT_CONFIG_DIR;
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'funnelchat');
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(env.HOME ?? homedir(), '.config');
  return join(base, 'funnelchat');
}

export function configPath(env: Record<string, string | undefined>): string {
  return join(configDir(env), CONFIG_FILE_NAME);
}

export interface LoadedConfig {
  path: string;
  config: ConfigFile;
  /** Set when the file can be read by other users of the machine. */
  insecurePermissions: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): LoadedConfig {
  const path = configPath(env);
  if (!existsSync(path)) return { path, config: { version: 1, profiles: {} }, insecurePermissions: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new CliError(`No se pudo leer el archivo de configuración ${path}: no es JSON válido.`, {
      exitCode: ExitCode.USAGE,
      code: 'config_unreadable',
      hint: 'Corregilo o borralo y volvé a correr `funnelchat login`.',
      cause,
    });
  }
  const profiles: Record<string, Profile> = {};
  if (isRecord(parsed) && isRecord(parsed.profiles)) {
    for (const [name, value] of Object.entries(parsed.profiles)) {
      if (!isRecord(value)) continue;
      profiles[name] = {
        ...(typeof value.api_key === 'string' ? { api_key: value.api_key } : {}),
        ...(typeof value.base_url === 'string' ? { base_url: value.base_url } : {}),
        ...(typeof value.saved_at === 'string' ? { saved_at: value.saved_at } : {}),
      };
    }
  }
  const current = isRecord(parsed) && typeof parsed.current_profile === 'string' ? parsed.current_profile : undefined;
  const insecurePermissions = process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0;
  return { path, config: { version: 1, ...(current ? { current_profile: current } : {}), profiles }, insecurePermissions };
}

/** Writes the configuration with permissions 0600, atomically. */
export function saveConfig(env: Record<string, string | undefined>, config: ConfigFile): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, CONFIG_FILE_NAME);
  const tmp = join(dir, `.${CONFIG_FILE_NAME}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return path;
}
