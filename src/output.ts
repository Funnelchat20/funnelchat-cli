/**
 * Everything the CLI prints goes through here, and through the {@link Redactor} on the way out.
 *
 * - Results go to stdout: human text by default, one JSON document with `--json`.
 * - Progress, notes, warnings and errors go to stderr, so stdout stays clean for scripts.
 * - With `--json`, an error is one JSON object on stderr: `{"error": {code, message, hint, exit_code, …}}`.
 */
import { CliError, ExitCode } from './errors.js';
import type { Redactor } from './http/redact.js';

export interface Writer {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

export class Output {
  constructor(
    private readonly stdout: Writer,
    private readonly stderr: Writer,
    private readonly redactor: Redactor,
    readonly options: OutputOptions,
  ) {}

  get json(): boolean {
    return this.options.json;
  }

  /** The result of a command: `data` with `--json`, the human lines otherwise. */
  result(data: unknown, human: () => string | string[]): void {
    if (this.options.json) this.#write(this.stdout, `${JSON.stringify(data, null, 2)}\n`);
    else this.#lines(this.stdout, human());
  }

  /** Progress of a long command (stderr). Silent with `--quiet` or `--json`. */
  progress(line: string): void {
    if (!this.options.quiet && !this.options.json) this.#lines(this.stderr, line);
  }

  /** A note for people (stderr). Silent with `--json`. */
  note(line: string | string[]): void {
    if (!this.options.json) this.#lines(this.stderr, line);
  }

  /** A warning (stderr), always shown. */
  warn(line: string): void {
    this.#lines(this.stderr, `warning: ${line}`);
  }

  /** `--verbose` only (stderr). */
  verbose(line: string): void {
    if (this.options.verbose) this.#lines(this.stderr, line);
  }

  error(error: unknown): number {
    const cliError = toCliError(error);
    if (this.options.json) {
      const body = {
        error: {
          code: cliError.code,
          message: cliError.message,
          ...(cliError.hint ? { hint: cliError.hint } : {}),
          exit_code: cliError.exitCode,
          ...cliError.details,
        },
      };
      this.#write(this.stderr, `${JSON.stringify(body)}\n`);
    } else {
      this.#lines(this.stderr, [`error: ${cliError.message}`, ...(cliError.hint ? cliError.hint.split('\n').map((l) => `  ${l}`) : [])]);
      if (this.options.verbose && cliError.exitCode === ExitCode.UNEXPECTED && error instanceof Error && error.stack) {
        this.#lines(this.stderr, error.stack);
      }
    }
    return cliError.exitCode;
  }

  #lines(writer: Writer, lines: string | string[]): void {
    const text = Array.isArray(lines) ? lines.join('\n') : lines;
    this.#write(writer, text.endsWith('\n') ? text : `${text}\n`);
  }

  #write(writer: Writer, text: string): void {
    writer.write(this.redactor.redact(text));
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(`Unexpected error: ${message}`, { exitCode: ExitCode.UNEXPECTED, code: 'unexpected', cause: error });
}

/** A plain-text table: columns padded to their widest cell. */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): string[] {
  const cells = rows.map((row) => row.map((cell) => (cell === null || cell === undefined || cell === '' ? '-' : String(cell))));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ');
  return [line(headers), ...cells.map(line)];
}
