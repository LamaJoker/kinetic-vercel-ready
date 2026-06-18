import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFoodByBarcode, normalizeBarcode } from '../../apps/web/src/lib/openfoodfacts.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeBarcode', () => {
  it('ne garde que les chiffres', () => {
    expect(normalizeBarcode(' 3017-620 422003 ')).toBe('3017620422003');
    expect(normalizeBarcode('abc')).toBe('');
    // @ts-expect-error — robustesse aux entrées nulles
    expect(normalizeBarcode(null)).toBe('');
  });
});

describe('fetchFoodByBarcode', () => {
  it('retourne null sans appel réseau si le code fait moins de 8 chiffres', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await fetchFoodByBarcode('123');
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('récupère et normalise un produit trouvé', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 1,
          product: {
            product_name: 'Nutella',
            brands: 'Ferrero',
            nutriments: {
              'energy-kcal_100g': 539,
              proteins_100g: 6.3,
              carbohydrates_100g: 57.5,
              fat_100g: 30.9,
            },
          },
        }),
      }),
    );
    const r = await fetchFoodByBarcode('3017620422003');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('Nutella');
    expect(r!.kcalPer100).toBe(539);
  });

  it('retourne null si la réponse HTTP n est pas ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchFoodByBarcode('3017620422003')).toBeNull();
  });

  it('retourne null en cas d erreur réseau (catch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await fetchFoodByBarcode('3017620422003')).toBeNull();
  });
});
