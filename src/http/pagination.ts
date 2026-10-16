/**
 * The three list shapes of the API, as funnelchat-node reads them (adapted from its
 * feat/inicial @ de14b86, src/core/pagination.ts):
 *
 * - page numbers (Laravel): `{ data, links, meta: { current_page, last_page, … } }`, next with `page`;
 * - cursors: `{ data, links, meta: { next_cursor, … } }`, next with `cursor`;
 * - plain arrays: one page with everything.
 *
 * The CLI keeps the query of the next page in its export state, so an export resumes from there.
 */
import { isRecord } from '../errors.js';

/** What asks for the next page: `{ page }` or `{ cursor }`. */
export type PageQuery = Record<string, string | number>;

export function extractItems<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (isRecord(body) && Array.isArray(body.data)) return body.data as T[];
  return [];
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** The query of the next page according to a response body, or `null`. */
export function nextPageQuery(body: unknown): PageQuery | null {
  if (!isRecord(body)) return null;
  for (const holder of [body.meta, body]) {
    if (!isRecord(holder)) continue;
    if ('next_cursor' in holder) {
      return typeof holder.next_cursor === 'string' && holder.next_cursor !== '' ? { cursor: holder.next_cursor } : null;
    }
    const current = toInt(holder.current_page);
    const last = toInt(holder.last_page);
    if (current !== null && last !== null) return current < last ? { page: current + 1 } : null;
  }
  const links = isRecord(body.links) ? body.links : undefined;
  const nextUrl = links?.next ?? body.next_page_url;
  if (typeof nextUrl === 'string' && nextUrl !== '') {
    const params = new URL(nextUrl, 'https://placeholder.invalid').searchParams;
    const cursor = params.get('cursor');
    if (cursor) return { cursor };
    const page = toInt(params.get('page'));
    if (page !== null) return { page };
  }
  return null;
}

/**
 * The next page after `body`, fetched with `query`; `null` on the last page. An empty page is always
 * the last one, and so is a "next" that asks for the same page again (a server that loops).
 */
export function followingPage(body: unknown, query: Record<string, unknown>): PageQuery | null {
  if (extractItems(body).length === 0) return null;
  const next = nextPageQuery(body);
  if (next === null) return null;
  const unchanged = Object.entries(next).every(([key, value]) => String(query[key]) === String(value));
  return unchanged ? null : next;
}

/** `meta.total` of a page-number listing, when the API sends it. */
export function totalOf(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.meta)) return null;
  return toInt(body.meta.total);
}
