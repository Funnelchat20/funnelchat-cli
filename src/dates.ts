/**
 * Dates on the command line. The API is strict about formats:
 *
 * - `updated_since` (conversations and messages) must be `Y-m-d\TH:i:sP`, that is
 *   `2026-10-01T00:00:00+00:00`; Laravel's `date_format` rejects a `Z` suffix
 *   (conversations origin/main @ 3b0326e4f, ConversationController::index and ::getLatestMessages).
 * - `created_from` / `created_to` (contacts) take a day (`2026-10-01`, the whole day) or a date and time
 *   (ContactService::normalizeRangeBound).
 */
import { usageError } from './errors.js';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

export function isValidDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toApiDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/** `--since`: a day (00:00 UTC) or a date and time with its zone; sent as `Y-m-d\TH:i:s+00:00`. */
export function parseSince(value: string, flag = '--since'): string {
  if (isValidDay(value)) return `${value}T00:00:00+00:00`;
  if (DATE_TIME.test(value)) {
    const date = new Date(value.replace(' ', 'T'));
    if (!Number.isNaN(date.getTime())) return toApiDateTime(date);
  }
  throw usageError(
    `${flag} must be a date (YYYY-MM-DD, from 00:00 UTC) or a date and time with a zone (2026-10-01T09:00:00-03:00): ${value}`,
  );
}

/** `--created-from` / `--created-to`: a day as is (the API takes the whole day), or a date and time in UTC. */
export function parseContactBound(value: string, flag: string): string {
  if (isValidDay(value)) return value;
  if (DATE_TIME.test(value)) {
    const date = new Date(value.replace(' ', 'T'));
    if (!Number.isNaN(date.getTime())) return toApiDateTime(date);
  }
  throw usageError(`${flag} must be a YYYY-MM-DD date or a date and time with a zone: ${value}`);
}

export function timestampForName(now: number): string {
  return new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}
