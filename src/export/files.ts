/**
 * Files of an export, written so that a cut never leaves a wrong file behind:
 *
 * - Every file is written as `<name>.part` and only takes its final name when it is complete.
 * - The final name is taken with a hard link, which fails if the name exists: **an existing file is
 *   never overwritten**, not even in a race with another program. Where hard links are not available
 *   (some network or FAT drives) the CLI checks and renames instead.
 * - Rows are appended at a known byte offset. After each page the file is synced and the offset saved
 *   in the export state; resuming truncates the `.part` back to that offset, so a page written after
 *   the last checkpoint is dropped and fetched again, never duplicated.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CliError, ExitCode } from '../errors.js';

export interface FileEntry {
  /** File name inside the export folder. */
  path: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export function outputExists(path: string): CliError {
  return new CliError(`Ya existe ${path}: la CLI nunca pisa un archivo.`, {
    exitCode: ExitCode.EXISTS,
    code: 'output_exists',
    hint: 'Elegí otra carpeta con --output-dir, o mové ese archivo.',
    details: { path },
  });
}

/** SHA-256 (hex) of a file, read in chunks. */
export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL']);

/** Gives `partPath` its final name without ever overwriting `finalPath`. */
export function publish(partPath: string, finalPath: string): void {
  try {
    linkSync(partPath, finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') {
      if (sameFile(partPath, finalPath)) {
        unlinkSync(partPath);
        return;
      }
      throw outputExists(finalPath);
    }
    if (!LINK_UNSUPPORTED.has(code)) throw error;
    if (existsSync(finalPath)) throw outputExists(finalPath);
    renameSync(partPath, finalPath);
    return;
  }
  unlinkSync(partPath);
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/** Writes a small file (the manifest) through `.part` and publishes it without overwriting. */
export function writeNewFile(finalPath: string, content: string): FileEntry {
  if (existsSync(finalPath)) throw outputExists(finalPath);
  const partPath = `${finalPath}.part`;
  const fd = openSync(partPath, 'w', 0o644);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const entry = { path: basename(finalPath), rows: 0, bytes: Buffer.byteLength(content), sha256: sha256File(partPath) };
  publish(partPath, finalPath);
  return entry;
}

/** Atomic replace of a working file (the export state): temporary file, sync, rename. */
export function writeAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** The position of an appendable file, as saved in the export state. */
export interface PartPosition {
  offset: number;
  rows: number;
}

/** A file being written as `<name>.part`, appended at a known offset. */
export class PartFile {
  readonly finalPath: string;
  readonly partPath: string;
  #fd: number | null;
  #offset: number;
  #rows: number;

  private constructor(finalPath: string, fd: number, position: PartPosition) {
    this.finalPath = finalPath;
    this.partPath = `${finalPath}.part`;
    this.#fd = fd;
    this.#offset = position.offset;
    this.#rows = position.rows;
  }

  /** Starts a new file. Fails if the final name already exists. */
  static create(finalPath: string): PartFile {
    if (existsSync(finalPath)) throw outputExists(finalPath);
    return new PartFile(finalPath, openSync(`${finalPath}.part`, 'w', 0o644), { offset: 0, rows: 0 });
  }

  /**
   * Reopens a `.part` at the position of the last checkpoint and drops whatever was written after it.
   * Returns a {@link FileEntry} instead when the file was already published (the run stopped right
   * after publishing it, before saving the state).
   */
  static resume(finalPath: string, position: PartPosition): PartFile | FileEntry {
    const partPath = `${finalPath}.part`;
    if (existsSync(finalPath)) {
      if (existsSync(partPath) && sameFile(partPath, finalPath)) unlinkSync(partPath);
      if (existsSync(partPath)) throw outputExists(finalPath);
      const size = statSync(finalPath).size;
      if (size !== position.offset) {
        throw inconsistent(`${basename(finalPath)} mide ${size} bytes y el estado guardado dice ${position.offset}`);
      }
      return { path: basename(finalPath), rows: position.rows, bytes: size, sha256: sha256File(finalPath) };
    }
    if (!existsSync(partPath)) {
      if (position.offset === 0) return PartFile.create(finalPath);
      throw inconsistent(`falta ${basename(partPath)}`);
    }
    const fd = openSync(partPath, 'r+');
    const size = fstatSync(fd).size;
    if (size < position.offset) {
      closeSync(fd);
      throw inconsistent(`${basename(partPath)} mide ${size} bytes y el estado guardado dice ${position.offset}`);
    }
    if (size > position.offset) ftruncateSync(fd, position.offset);
    return new PartFile(finalPath, fd, position);
  }

  get position(): PartPosition {
    return { offset: this.#offset, rows: this.#rows };
  }

  get rows(): number {
    return this.#rows;
  }

  /** Appends whole rows (each already ending in a newline). */
  append(text: string, rows: number): void {
    const buffer = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(this.fd, buffer, written, buffer.length - written, this.#offset + written);
    }
    this.#offset += buffer.length;
    this.#rows += rows;
  }

  /** Flushes to disk: call it before saving the position in the export state. */
  sync(): void {
    fsyncSync(this.fd);
  }

  /** Syncs, closes, hashes and publishes the file under its final name. */
  finalize(): FileEntry {
    this.sync();
    this.close();
    const entry: FileEntry = { path: basename(this.finalPath), rows: this.#rows, bytes: this.#offset, sha256: sha256File(this.partPath) };
    publish(this.partPath, this.finalPath);
    return entry;
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }

  private get fd(): number {
    if (this.#fd === null) throw new Error(`${this.partPath} ya está cerrado.`);
    return this.#fd;
  }
}

function inconsistent(detail: string): CliError {
  return new CliError(`No se puede retomar: el estado de la exportación no coincide con los archivos (${detail}).`, {
    exitCode: ExitCode.USAGE,
    code: 'resume_inconsistent',
    hint: 'Empezá la exportación de nuevo en otra carpeta.',
  });
}
