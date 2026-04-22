import type { IdGeneratorPort } from '@kinetic/core';

/**
 * UuidGenerator — IdGeneratorPort via l'API Web Crypto standard.
 *
 * crypto.randomUUID() est disponible dans Chrome 92+, Firefox 95+, Safari 15.4+.
 * Produit des UUIDs v4 (128 bits aléatoires).
 */
export class UuidGenerator implements IdGeneratorPort {
  newId(): string {
    return crypto.randomUUID();
  }
}
