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
import { CLI_NAME, VERSION } from '../version.js';
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
        if (!statSync(dir).isDirectory()) throw exists(dir, 'Elige una carpeta con --output-dir.');
        if (readdirSync(dir).length > 0) {
          throw exists(
            dir,
            existsSync(statePath)
              ? `Hay una exportación sin terminar en esa carpeta: retómala con\n  funnelchat ${options.kind} export --output-dir ${quote(options.dir)} --resume`
              : 'Elige una carpeta nueva o vacía con --output-dir: la CLI nunca pisa archivos.',
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
      throw usageError(`No hay una exportación para retomar en ${dir}.`, 'Pasa la misma --output-dir de la exportación que se cortó.');
    }
    const state = readState<S>(statePath);
    if (state.kind !== options.kind) {
      throw usageError(`Esa carpeta tiene una exportación de ${state.kind}, no de ${options.kind}.`, `Retómala con \`funnelchat ${state.kind} export --output-dir ${quote(options.dir)} --resume\`.`);
    }
    if (state.base_url !== options.baseUrl) {
      throw usageError(`Esa exportación se hizo contra ${state.base_url} y ahora la URL base es ${options.baseUrl}.`, 'Retómala con la misma URL base (y la misma clave) que la original.');
    }
    const differences = [...options.explicit]
      .filter((key) => JSON.stringify(options.options[key] ?? null) !== JSON.stringify(state.options[key] ?? null))
      .map((key) => `${key}: original ${JSON.stringify(state.options[key] ?? null)}, ahora ${JSON.stringify(options.options[key] ?? null)}`);
    if (differences.length) {
      throw usageError(
        `Las opciones no coinciden con las de la exportación original (${differences.join('; ')}).`,
        'Con --resume no hace falta repetir las opciones: se usan las originales.',
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
    throw usageError(`El estado de la exportación (${path}) no se puede leer.`, 'Empieza la exportación de nuevo en otra carpeta.');
  }
  if (!isRecord(parsed) || parsed.state_version !== 1 || typeof parsed.kind !== 'string') {
    throw usageError(`El estado de la exportación (${path}) no es de esta versión de la CLI.`, 'Empieza la exportación de nuevo en otra carpeta.');
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
        throw new CliError(`Otra ejecución de la CLI (proceso ${pid}) está usando ${dir}.`, {
          exitCode: ExitCode.EXISTS,
          code: 'export_locked',
          hint: 'Espera a que termine, o córtala, y vuelve a intentar.',
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
  return new CliError(`La carpeta ${dir} ya existe y no está vacía.`, { exitCode: ExitCode.EXISTS, code: 'output_exists', hint, details: { path: dir } });
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
    generator: { name: CLI_NAME, version: VERSION },
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

