import { describe, it, expect } from 'vitest';
import { parseOpenFoodFactsProduct } from '@kinetic/core';

describe('parseOpenFoodFactsProduct', () => {
  it('mappe un produit complet (kcal direct)', () => {
    const f = parseOpenFoodFactsProduct('3017620422003', {
      status: 1,
      product: {
        product_name: 'Nutella',
        brands: 'Ferrero, Nutella',
        serving_quantity: 15,
        nutriments: {
          'energy-kcal_100g': 539,
          proteins_100g: 6.3,
          carbohydrates_100g: 57.5,
          fat_100g: 30.9,
        },
      },
    });
    expect(f).not.toBeNull();
    expect(f!.name).toBe('Nutella');
    expect(f!.brand).toBe('Ferrero'); // première marque seulement
    expect(f!.kcalPer100).toBe(539);
    expect(f!.proteinPer100).toBe(6.3);
    expect(f!.carbsPer100).toBe(57.5);
    expect(f!.fatPer100).toBe(30.9);
    expect(f!.servingSizeG).toBe(15);
    expect(f!.barcode).toBe('3017620422003');
  });

  it('convertit le kJ en kcal quand energy-kcal absent', () => {
    const f = parseOpenFoodFactsProduct('111', {
      status: 1,
      product: {
        product_name: 'Truc',
        nutriments: { energy_100g: 2255, proteins_100g: 6, carbohydrates_100g: 57, fat_100g: 31 },
      },
    });
    // 2255 kJ / 4.184 ≈ 539 kcal
    expect(f!.kcalPer100).toBe(539);
  });

  it('calcule les kcal via Atwater si aucune énergie fournie', () => {
    const f = parseOpenFoodFactsProduct('222', {
      status: 1,
      product: {
        product_name: 'Poulet',
        nutriments: { proteins_100g: 25, carbohydrates_100g: 0, fat_100g: 3 },
      },
    });
    // 4*25 + 4*0 + 9*3 = 127
    expect(f!.kcalPer100).toBe(127);
  });

  it('retourne null si status 0 (produit introuvable)', () => {
    expect(parseOpenFoodFactsProduct('000', { status: 0 })).toBeNull();
    expect(parseOpenFoodFactsProduct('000', { status: '0', product: {} })).toBeNull();
  });

  it('retourne null sans produit exploitable', () => {
    expect(parseOpenFoodFactsProduct('x', { status: 1 })).toBeNull();
    expect(parseOpenFoodFactsProduct('x', { status: 1, product: { nutriments: {} } })).toBeNull();
  });

  it('résiste aux entrées invalides', () => {
    expect(parseOpenFoodFactsProduct('x', null)).toBeNull();
    expect(parseOpenFoodFactsProduct('x', 'pas un objet')).toBeNull();
    expect(parseOpenFoodFactsProduct('x', 42)).toBeNull();
  });

  it('gère les nutriments en chaînes de caractères et les valeurs négatives', () => {
    const f = parseOpenFoodFactsProduct('333', {
      status: 1,
      product: {
        product_name: 'Bizarre',
        nutriments: {
          'energy-kcal_100g': '200',
          proteins_100g: '-5',
          carbohydrates_100g: 'NaN',
          fat_100g: 2,
        },
      },
    });
    expect(f!.kcalPer100).toBe(200);
    expect(f!.proteinPer100).toBe(0); // négatif → 0
    expect(f!.carbsPer100).toBe(0); // NaN → 0
    expect(f!.fatPer100).toBe(2);
  });

  it('fournit un nom de repli quand product_name est vide mais des macros existent', () => {
    const f = parseOpenFoodFactsProduct('444', {
      status: 1,
      product: { product_name: '  ', nutriments: { proteins_100g: 10 } },
    });
    expect(f!.name).toBe('Produit 444');
  });

  it('utilise generic_name en repli de product_name', () => {
    const f = parseOpenFoodFactsProduct('555', {
      status: 1,
      product: { generic_name: 'Yaourt nature', nutriments: { 'energy-kcal_100g': 60 } },
    });
    expect(f!.name).toBe('Yaourt nature');
  });

  it('omet brand et servingSizeG quand absents', () => {
    const f = parseOpenFoodFactsProduct('666', {
      status: 1,
      product: { product_name: 'Sans marque', nutriments: { 'energy-kcal_100g': 100 } },
    });
    expect(f!.brand).toBeUndefined();
    expect(f!.servingSizeG).toBeUndefined();
  });
});
