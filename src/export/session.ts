/**
 * One export folder: its state (to resume), its lock (one run at a time) and, at the end, its
 * manifest.
 *
 * - A new export needs a folder that does not exist or is empty.
 * - The state lives in `<folder>/.funnelchat-export.json`, is replaced atomically after every page and
 *   never holds the key. `--resume` reads it, checks that the options and the base URL are the same,
 *   and continues from the saved cursor. When the export completes, the manifest is written and the
 *   state is deleted.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError, ExitCode, isRecord, usageError } from '../errors.js';
import { SPEC_SOURCE, type RouteInfo } from '../generated/routes.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { type FileEntry, writeAtomic, writeNewFile } from './files.js';

export const STATE_FILE = '.funnelchat-export.json';
export const LOCK_FILE = '.funnelchat-export.lock';
export const MANIFEST_FILE = 'manifest.json';

export type ExportKind = 'contacts' | 'conversations';

export interface BaseState {
  state_version: 1;
  kind: ExportKind;
  cli_version: string;
  base_url: string;
  /** The options of the original run: a resume reuses them. */
  options: Record<string, unknown>;
  started_at: string;
  /** 1 for the first run, +1 for every `--resume`. */
  runs: number;
  /** Requests sent so far, over every run. */
  api_calls: number;
}

export interface OpenOptions<S extends BaseState> {
  dir: string;
  cwd: string;
  kind: ExportKind;
  resume: boolean;
  baseUrl: string;
  /** Options as given now; with `--resume`, only the ones typed on the command line are compared. */
  options: Record<string, unknown>;
  explicit: ReadonlySet<string>;
  initial: () => S;
}

export type OpenResult<S extends BaseState> = { session: ExportSession<S> } | { alreadyComplete: string };

export class ExportSession<S extends BaseState> {
  readonly dir: string;
  state: S;
  #locked = true;

  private constructor(dir: string, state: S) {
    this.dir = dir;
    this.state = state;
  }

  static open<S extends BaseState>(options: OpenOptions<S>): OpenResult<S> {
    const dir = resolve(options.cwd, options.dir);
    const statePath = join(dir, STATE_FILE);

    if (!options.resume) {
      if (existsSync(dir)) {
        if (!statSync(dir).isDirectory()) throw exists(dir, 'Choose a folder with --output-dir.');
        if (readdirSync(dir).length > 0) {
          throw exists(
            dir,
            existsSync(statePath)
              ? `There is an unfinished export in that folder: resume it with\n  funnelchat ${options.kind} export --output-dir ${quote(options.dir)} --resume`
              : 'Choose a new or empty folder with --output-dir: the CLI never overwrites files.',
          );
        }
      }
      mkdirSync(dir, { recursive: true });
      lock(dir);
      const session = new ExportSession(dir, options.initial());
      session.save();
      return { session };
    }

    if (!existsSync(statePath)) {
      if (existsSync(join(dir, MANIFEST_FILE))) return { alreadyComplete: join(dir, MANIFEST_FILE) };
      throw usageError(`There is no export to resume in ${dir}.`, 'Pass the same --output-dir as the export that was interrupted.');
    }
    const state = readState<S>(statePath);
    if (state.kind !== options.kind) {
      throw usageError(`That folder holds a ${state.kind} export, not a ${options.kind} one.`, `Resume it with \`funnelchat ${state.kind} export --output-dir ${quote(options.dir)} --resume\`.`);
    }
    if (state.base_url !== options.baseUrl) {
      throw usageError(`That export was made against ${state.base_url} and the base URL is now ${options.baseUrl}.`, 'Resume it with the same base URL (and the same key) as the original.');
    }
    const differences = [...options.explicit]
      .filter((key) => JSON.stringify(options.options[key] ?? null) !== JSON.stringify(state.options[key] ?? null))
      .map((key) => `${key}: original ${JSON.stringify(state.options[key] ?? null)}, now ${JSON.stringify(options.options[key] ?? null)}`);
    if (differences.length) {
      throw usageError(
        `The options do not match those of the original export (${differences.join('; ')}).`,
        'With --resume there is no need to repeat the options: the original ones are used.',
      );
    }
    lock(dir);
    const session = new ExportSession(dir, state);
    session.state.runs += 1;
    session.save();
    return { session };
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  save(): void {
    writeAtomic(join(this.dir, STATE_FILE), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  /** Writes the manifest (never over an existing one), deletes the state and releases the lock. */
  complete(manifest: Manifest): FileEntry {
    const entry = writeNewFile(join(this.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(join(this.dir, STATE_FILE), { force: true });
    this.release();
    return entry;
  }

  release(): void {
    if (!this.#locked) return;
    this.#locked = false;
    rmSync(join(this.dir, LOCK_FILE), { force: true });
  }
}

function readState<S extends BaseState>(path: string): S {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw usageError(`The state of the export (${path}) cannot be read.`, 'Start the export again in another folder.');
  }
  if (!isRecord(parsed) || parsed.state_version !== 1 || typeof parsed.kind !== 'string') {
    throw usageError(`The state of the export (${path}) is not from this version of the CLI.`, 'Start the export again in another folder.');
  }
  return parsed as unknown as S;
}

function lock(dir: string): void {
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
        throw new CliError(`Another run of the CLI (process ${pid}) is using ${dir}.`, {
          exitCode: ExitCode.EXISTS,
          code: 'export_locked',
          hint: 'Wait for it to finish, or stop it, and try again.',
        });
      }
      unlinkSync(path);
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function exists(dir: string, hint: string): CliError {
  return new CliError(`The folder ${dir} already exists and is not empty.`, { exitCode: ExitCode.EXISTS, code: 'output_exists', hint, details: { path: dir } });
}

export function quote(value: string): string {
  return /^[\w./:@=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export interface Manifest {
  manifest_version: 1;
  kind: ExportKind;
  generator: { name: string; version: string };
  api: {
    base_url: string;
    spec: { source: string | null; commit: string | null; sha256: string | null };
    routes: { route: string; pending: string | null }[];
  };
  started_at: string;
  finished_at: string;
  runs: number;
  api_calls: number;
  options: Record<string, unknown>;
  range: Record<string, unknown>;
  counts: Record<string, number>;
  files: FileEntry[];
  notes: string[];
}

/** The parts of the manifest every export shares. Never includes the key or the account's data. */
export function baseManifest(state: BaseState, used: RouteInfo[], finishedAt: string): Omit<Manifest, 'range' | 'counts' | 'files' | 'notes'> {
  return {
    manifest_version: 1,
    kind: state.kind,
    generator: { name: PACKAGE_NAME, version: VERSION },
    api: {
      base_url: state.base_url,
      spec: { source: SPEC_SOURCE.branch ? `developers-portal ${SPEC_SOURCE.branch}` : null, commit: SPEC_SOURCE.commit, sha256: SPEC_SOURCE.sha256 },
      routes: used.map((route) => ({ route: `${route.method} ${route.path}`, pending: route.pending?.source ?? null })),
    },
    started_at: state.started_at,
    finished_at: finishedAt,
    runs: state.runs,
    api_calls: state.api_calls,
    options: state.options,
  };
}

