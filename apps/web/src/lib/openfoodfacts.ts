/**
 * OpenFoodFacts — adaptateur réseau (récupération produit par code-barres).
 *
 * La logique de normalisation vit dans `@kinetic/core`
 * (`parseOpenFoodFactsProduct`, pure et testée). Ce module ne fait que l'I/O :
 * appel HTTP, timeout, gestion d'erreur. API publique, gratuite, sans clé.
 */
import { parseOpenFoodFactsProduct, type ScannedFood } from '@kinetic/core';

const API = 'https://world.openfoodfacts.org/api/v2/product';
const FIELDS = 'product_name,generic_name,brands,serving_quantity,nutriments';
const TIMEOUT_MS = 8000;

/** Normalise un code-barres : ne garde que les chiffres. */
export function normalizeBarcode(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * fetchFoodByBarcode — interroge OpenFoodFacts et renvoie un `ScannedFood`
 * normalisé, ou `null` si introuvable / code invalide / erreur réseau.
 */
export async function fetchFoodByBarcode(barcode: string): Promise<ScannedFood | null> {
  const code = normalizeBarcode(barcode);
  if (code.length < 8) return null; // EAN-8 = 8 chiffres minimum

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/${code}.json?fields=${FIELDS}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return parseOpenFoodFactsProduct(code, json);
  } catch {
    return null; // abort / réseau / JSON invalide
  } finally {
    clearTimeout(timer);
  }
}
