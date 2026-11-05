import type { Command } from 'commander';
import type { Context } from '../context.js';
import { InterruptedError, usageError } from '../errors.js';

/** `--timeout`: whole seconds, from 0 up to a day. */
export function seconds(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 86_400) throw usageError(`${flag} must be a whole number of seconds, from 0 to 86400: ${value}`);
  return Number(value);
}

/** Waits `ms` between two polls; Ctrl+C ends the wait with an {@link InterruptedError}. */
export async function pause(ctx: Context, ms: number): Promise<void> {
  if (ctx.io.signal?.aborted) throw new InterruptedError();
  try {
    await ctx.io.sleep(Math.max(0, ms), ctx.io.signal);
  } catch (error) {
    if (ctx.io.signal?.aborted) throw new InterruptedError();
    throw error;
  }
}

export function positiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw usageError(`${flag} must be a positive integer: ${value}`);
  }
  return Number(value);
}

/** Ids from repeated or comma-separated values: `--contact 1 --contact 2,3`. */
export function idList(values: string[] | undefined, flag: string): number[] {
  const ids: number[] = [];
  for (const value of values ?? []) {
    for (const piece of value.split(',')) {
      const trimmed = piece.trim();
      if (trimmed === '') continue;
      const id = positiveInt(trimmed, flag);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** The options of a command that were typed on the command line (not defaults). */
export function explicitOptions(command: Command, names: string[]): Set<string> {
  return new Set(names.filter((name) => command.getOptionValueSource(name) === 'cli'));
}
