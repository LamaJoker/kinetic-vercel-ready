import { describe, expect, it } from 'vitest';
import { parsePlan } from '../../apps/web/src/lib/autotest';

describe('parsePlan', () => {
  it('garde les routes internes valides et borne la durée', () => {
    expect(
      parsePlan(
        JSON.stringify({ demo: true, routes: ['/seances', 'https://x', '/', 3], stepMs: 10 }),
      ),
    ).toEqual({ demo: true, routes: ['/seances', '/'], stepMs: 3500 });
  });

  it('refuse un contenu illisible', () => {
    expect(parsePlan('pas du json')).toBeNull();
    expect(parsePlan('null')).toBeNull();
  });

  it('valeurs par défaut', () => {
    expect(parsePlan('{}')).toEqual({ demo: false, routes: [], stepMs: 3500 });
  });
});
