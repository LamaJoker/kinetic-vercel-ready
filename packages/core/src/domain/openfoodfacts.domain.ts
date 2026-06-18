/**
 * OpenFoodFacts Domain — mapping pur d'une réponse produit OpenFoodFacts
 * (API v2) vers un aliment normalisé avec macros pour 100 g.
 *
 * Le scan code-barres ne fait que récupérer un code (13 chiffres EAN) ; toute
 * la valeur est dans la normalisation : OpenFoodFacts est crowdsourcé, donc les
 * champs sont incohérents (énergie en kcal OU en kJ, macros manquantes, noms
 * vides). Cette fonction est pure et défensive — aucun I/O, aucune dépendance —
 * pour être testable exhaustivement.
 *
 * Source des champs : https://openfoodfacts.github.io/openfoodfacts-server/api/
 *   product.nutriments['energy-kcal_100g' | 'energy_100g'(kJ) | 'proteins_100g' …]
 *
 * Pur — aucune dépendance, aucun I/O.
 */

/** Aliment normalisé issu d'un scan, macros pour 100 g. */
export interface ScannedFood {
  barcode: string;
  name: string;
  brand?: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  /** Taille d'une portion en grammes, si renseignée par OpenFoodFacts. */
  servingSizeG?: number;
}

const KJ_PER_KCAL = 4.184;
/** Coefficients d'Atwater — fallback si l'énergie est absente mais les macros présentes. */
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

/** Convertit une valeur inconnue en nombre fini >= 0, sinon 0. */
function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * parseOpenFoodFactsProduct — mappe une réponse API OpenFoodFacts v2 en
 * `ScannedFood`. Retourne `null` si le produit est introuvable ou inexploitable
 * (pas de nom ET pas une seule macro/énergie).
 */
export function parseOpenFoodFactsProduct(barcode: string, payload: unknown): ScannedFood | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  // status 0 = produit absent de la base
  if (root.status === 0 || root.status === '0') return null;

  const product = root.product;
  if (!product || typeof product !== 'object') return null;
  const p = product as Record<string, unknown>;

  const nutr = (p.nutriments as Record<string, unknown> | undefined) ?? {};

  const protein = num(nutr['proteins_100g']);
  const carbs = num(nutr['carbohydrates_100g']);
  const fat = num(nutr['fat_100g']);

  // Énergie : kcal direct > kJ converti > Atwater à partir des macros
  let kcal = num(nutr['energy-kcal_100g']) || num(nutr['energy-kcal']);
  if (kcal === 0) {
    const kj = num(nutr['energy_100g']) || num(nutr['energy-kj_100g']);
    if (kj > 0) kcal = kj / KJ_PER_KCAL;
  }
  if (kcal === 0) {
    kcal = protein * KCAL_PER_G.protein + carbs * KCAL_PER_G.carbs + fat * KCAL_PER_G.fat;
  }

  const name =
    (typeof p.product_name === 'string' && p.product_name.trim()) ||
    (typeof p.generic_name === 'string' && p.generic_name.trim()) ||
    '';

  // Inexploitable : ni nom ni aucune donnée nutritionnelle
  if (!name && kcal === 0 && protein === 0 && carbs === 0 && fat === 0) {
    return null;
  }

  const brand =
    typeof p.brands === 'string' && p.brands.trim() ? p.brands.split(',')[0]!.trim() : undefined;

  const servingSizeG = num(p.serving_quantity);

  return {
    barcode,
    name: name || `Produit ${barcode}`,
    ...(brand ? { brand } : {}),
    kcalPer100: Math.round(kcal),
    proteinPer100: round1(protein),
    carbsPer100: round1(carbs),
    fatPer100: round1(fat),
    ...(servingSizeG > 0 ? { servingSizeG } : {}),
  };
}
