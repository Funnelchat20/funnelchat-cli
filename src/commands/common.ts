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

/** The prefix of each kind of id the CLI takes (the portal's «Identificadores» page has the full table). */
export type IdPrefix = 'dev' | 'ctc' | 'tag';

/**
 * An opaque id of the public API: `<prefix>_` and 23 base62 characters (`ctc_ABsza6Ialu1BCUyPFZ8WJvV`). It is text:
 * it is checked for its shape and passed on as typed, never built or converted. An integer or an id of another kind is a 404 for the API.
 */
export function opaqueId(value: string, flag: string, prefix: IdPrefix): string {
  const trimmed = value.trim();
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]{23}$`).test(trimmed)) {
    throw usageError(`${flag} must be an id like ${prefix}_ followed by 23 letters or digits (${prefix}_ABsza6Ialu1BCUyPFZ8WJvV): ${value}`);
  }
  return trimmed;
}

/** Ids from repeated or comma-separated values: `--contact ctc_…  --contact ctc_…,ctc_…`. */
export function idList(values: string[] | undefined, flag: string, prefix: IdPrefix): string[] {
  const ids: string[] = [];
  for (const value of values ?? []) {
    for (const piece of value.split(',')) {
      if (piece.trim() === '') continue;
      const id = opaqueId(piece, flag, prefix);
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
