import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error — script Node en .mjs sans déclarations de types
import { extractRoutes, writeEntrypoints } from '../../scripts/spa-entrypoints.mjs';

const routerSource = readFileSync(resolve(__dirname, '../../apps/web/src/router.ts'), 'utf8');

describe('spa-entrypoints', () => {
  it('extrait toutes les routes déclarées dans router.ts', () => {
    const routes = extractRoutes(routerSource) as string[];
    const declared = [...routerSource.matchAll(/\|\s*'(\/[^']*)'/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThanOrEqual(18);
    expect(new Set(routes)).toEqual(new Set(declared));
    for (const r of [
      '/records',
      '/plates',
      '/achievements',
      '/photos',
      '/programs',
      '/glossaire',
    ]) {
      expect(routes).toContain(r);
    }
  });

  it('génère un .html par route (hors /) et l alias legacy /auth/callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinetic-dist-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    await writeEntrypoints(dir, ['/', '/records', '/auth-callback']);
    expect(existsSync(join(dir, 'records.html'))).toBe(true);
    expect(existsSync(join(dir, 'auth-callback.html'))).toBe(true);
    expect(existsSync(join(dir, 'auth', 'callback.html'))).toBe(true);
    expect(existsSync(join(dir, '.html'))).toBe(false);
  });
});
