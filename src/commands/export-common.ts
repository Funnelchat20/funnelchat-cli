import type { Context } from '../context.js';
import type { CliError} from '../errors.js';
import { ExitCode } from '../errors.js';
import type { BaseState, ExportSession, Manifest } from '../export/session.js';
import { toCliError } from '../output.js';

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** `1 contact`, `2 contacts`: the count and the noun in singular or plural. */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}

/** Publishes the manifest, deletes the state and prints the result. */
export function finishExport<S extends BaseState>(ctx: Context, session: ExportSession<S>, manifest: Manifest, summary: string): void {
  const entry = session.complete(manifest);
  ctx.out.result({ status: 'complete', output_dir: session.dir, manifest_file: entry, manifest }, () => [
    `Export complete: ${summary}.`,
    `Manifest: ${session.path(entry.path)} (sha256 ${entry.sha256})`,
    `Files: ${manifest.files.length} · API calls: ${manifest.api_calls.toLocaleString('en-US')}`,
  ]);
}

/** After an export started, any stop can be resumed from the last saved page: say how. */
export function withResumeHint(error: unknown, resumeCommand: string): CliError {
  const cliError = toCliError(error);
  if (cliError.exitCode === ExitCode.USAGE || cliError.exitCode === ExitCode.EXISTS) return cliError;
  const resume = `What was exported up to the last complete page is saved. To continue from there:\n  ${resumeCommand}`;
  cliError.hint = cliError.hint ? `${cliError.hint}\n${resume}` : resume;
  cliError.details.resume_command = resumeCommand;
  return cliError;
}
