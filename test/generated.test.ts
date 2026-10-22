import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routes, SPEC_SOURCE } from '../src/generated/routes.js';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('generated route table', () => {
  it('is up to date with the spec, and every route exists in it', () => {
    // Fails if a route or a query parameter of spec/routes-used.json is not in the spec.
    const output = execFileSync(process.execPath, [join(root, 'scripts/generate.mjs'), '--check'], { encoding: 'utf8' });
    expect(output).toContain('is up to date');
  });

  it('matches the provenance of the spec copy', () => {
    const provenance = JSON.parse(readFileSync(join(root, 'spec/procedencia.json'), 'utf8'));
    const hash = createHash('sha256').update(readFileSync(join(root, 'spec/funnelchat.json'))).digest('hex');
    expect(provenance.sha256).toBe(hash);
    expect(SPEC_SOURCE.sha256).toBe(hash);
    expect(SPEC_SOURCE.commit).toBe(provenance.source.commit);
  });

  it('uses only routes that are in production: none comes from an unmerged branch', () => {
    expect(Object.values(routes).filter((r) => r.pending)).toEqual([]);
    expect(Object.values(routes).map((r) => r.path)).not.toContain('/api/v1/templates/{template}/metrics');
  });

  it('knows the domain, the permission and the pagination of each route', () => {
    expect(routes.devicesList).toMatchObject({ domain: 'accounts', permission: 'accounts:read', pagination: 'page', plainArray: true });
    expect(routes.contactsList).toMatchObject({ domain: 'conversations', pagination: 'page', perPageMax: 100 });
    expect(routes.contactMessages).toMatchObject({ domain: 'conversations', pagination: 'cursor' });
    expect(routes.conversationsList).toMatchObject({ pagination: 'cursor' });
  });

  it('every route the CLI calls is a read', () => {
    for (const route of Object.values(routes)) expect(route.method).toBe('GET');
  });

  it('the version matches package.json', () => {
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe(VERSION);
  });
});
