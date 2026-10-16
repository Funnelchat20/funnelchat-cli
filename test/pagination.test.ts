import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routes } from '../src/generated/routes.js';
import { ApiClient } from '../src/http/client.js';
import { Pacer } from '../src/http/pacer.js';
import { followingPage, nextPageQuery } from '../src/http/pagination.js';
import { cli, FakeAccount, jsonl, TEST_KEY, tempDir } from './helpers.js';

function client(fetch: typeof globalThis.fetch): ApiClient {
  const sleep = async () => {};
  return new ApiClient({ apiKey: TEST_KEY, baseUrl: 'https://api.funnelchat.com', fetch, pacer: new Pacer(1000, Date.now, sleep), sleep, clock: Date.now });
}

describe('next page', () => {
  it('reads page numbers, cursors, plain arrays and links.next', () => {
    expect(nextPageQuery({ data: [1], meta: { current_page: 1, last_page: 3 } })).toEqual({ page: 2 });
    expect(nextPageQuery({ data: [1], meta: { current_page: 3, last_page: 3 } })).toBeNull();
    expect(nextPageQuery({ data: [1], meta: { next_cursor: 'abc' } })).toEqual({ cursor: 'abc' });
    expect(nextPageQuery({ data: [1], meta: { next_cursor: null } })).toBeNull();
    expect(nextPageQuery([1, 2, 3])).toBeNull();
    expect(nextPageQuery({ data: [1], links: { next: 'https://api.funnelchat.com/api/v1/x?page=4&perPage=5' } })).toEqual({ page: 4 });
  });

  it('stops on an empty page and on a "next" that repeats the same page', () => {
    expect(followingPage({ data: [], meta: { current_page: 1, last_page: 9 } }, {})).toBeNull();
    expect(followingPage({ data: [1], meta: { next_cursor: 'same' } }, { cursor: 'same' })).toBeNull();
  });
});

describe('walking listings', () => {
  it('walks every page of a page-number listing', async () => {
    const account = new FakeAccount({ contacts: 230 });
    const { fetch, calls } = account.fetch();
    const ids: number[] = [];
    for await (const contact of client(fetch).all<{ id: number }>(routes.contactsList, { query: { perPage: 100 } })) ids.push(contact.id);
    expect(ids).toHaveLength(230);
    expect(new Set(ids).size).toBe(230);
    expect(calls.map((c) => c.query.get('page'))).toEqual([null, '2', '3']);
  });

  it('walks every page of a cursor listing, sending the cursor back', async () => {
    const account = new FakeAccount({ contacts: 1, messagesPerContact: () => 250 });
    const { fetch, calls } = account.fetch();
    const ids: number[] = [];
    for await (const message of client(fetch).all<{ id: number }>(routes.contactMessages, { path: { contactId: 1001 }, query: { perPage: 100 } })) ids.push(message.id);
    expect(ids).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.query.get('cursor')).toBeTruthy();
    expect(calls[2]?.query.get('page')).toBeNull();
  });

  it('takes a plain array as one page with everything', async () => {
    const account = new FakeAccount().hook((request) => (request.path === '/api/v1/devices' ? { body: [{ id: 3 }, { id: 4 }] } : undefined));
    const { fetch, calls } = account.fetch();
    const ids: number[] = [];
    for await (const device of client(fetch).all<{ id: number }>(routes.devicesList)) ids.push(device.id);
    expect(ids).toEqual([3, 4]);
    expect(calls).toHaveLength(1);
  });
});

describe('exports page through the API', () => {
  it('contacts export: ordered by id, 100 per page, every contact once', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 250 });
    const { fetch, calls } = account.fetch();
    const result = await cli(['contacts', 'export', '-o', 'out', '--format', 'jsonl', '--no-tags', '--no-custom-fields'], { fetch, cwd });
    expect(result.code).toBe(0);
    const listing = calls.filter((c) => c.path === '/api/v1/contacts');
    expect(listing.map((c) => c.query.get('page') ?? '1')).toEqual(['1', '2', '3']);
    for (const call of listing) {
      expect(call.query.get('orderBy')).toBe('id');
      expect(call.query.get('orderByMethod')).toBe('asc');
      expect(call.query.get('perPage')).toBe('100');
    }
    const rows = jsonl(readFileSync(join(cwd, 'out', 'contacts.jsonl'), 'utf8'));
    expect(rows.map((r) => r.id)).toEqual(account.contacts.map((c) => c.id));
  });

  it('conversations export: lists oldest first, then each history by cursor', async () => {
    const cwd = tempDir();
    const account = new FakeAccount({ contacts: 3, messagesPerContact: () => 150 });
    const { fetch, calls } = account.fetch();
    const result = await cli(['conversations', 'export', '-o', 'out'], { fetch, cwd });
    expect(result.code).toBe(0);
    expect(calls.find((c) => c.path === '/api/v1/conversations')?.query.get('orderBy')).toBe('asc');
    expect(calls.filter((c) => c.path.endsWith('/messages'))).toHaveLength(6);
    const messages = jsonl(readFileSync(join(cwd, 'out', 'messages-00001.jsonl'), 'utf8'));
    expect(messages).toHaveLength(450);
    expect(new Set(messages.map((m) => m.id)).size).toBe(450);
  });
});
