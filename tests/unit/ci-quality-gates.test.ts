/**
 * Portes de qualité de la CI (QA-06) : couverture avec seuils vérifiés et tests SQL des
 * migrations sur Postgres 16. Un retrait accidentel du workflow fait échouer ce test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../../vitest.config';

const ROOT = resolve(__dirname, '../..');
const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('CI : portes de qualité', () => {
  it('pnpm test:coverage lance vitest avec la couverture, et la CI l exécute', () => {
    expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage');
    expect(ci).toMatch(/run: pnpm test:coverage/);
  });

  it('seuils de couverture : global et dossiers critiques', () => {
    const coverage = config.test?.coverage as { thresholds?: Record<string, unknown> };
    const t = coverage.thresholds ?? {};
    expect(t['lines']).toBeGreaterThanOrEqual(80);
    expect(t['branches']).toBeGreaterThanOrEqual(80);
    for (const dir of [
      'packages/core/src/**',
      'packages/adapter-web/src/sync/**',
      'apps/web/src/lib/training/**',
    ]) {
      expect(t[dir], dir).toMatchObject({
        lines: expect.any(Number),
        branches: expect.any(Number),
        functions: expect.any(Number),
        statements: expect.any(Number),
      });
    }
  });

  it('les tests SQL (Postgres 16) tournent en CI', () => {
    expect(pkg.scripts['test:sql']).toBe('bash scripts/test-sql.sh');
    expect(ci).toMatch(/run: pnpm test:sql/);
    expect(ci).toMatch(/postgresql-16/);
  });
});
