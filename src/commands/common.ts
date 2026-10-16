import type { Command } from 'commander';
import { usageError } from '../errors.js';

export function positiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw usageError(`${flag} tiene que ser un número entero positivo: ${value}`);
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
