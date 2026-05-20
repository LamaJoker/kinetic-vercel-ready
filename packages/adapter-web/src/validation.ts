/**
 * packages/adapter-web/src/validation.ts
 *
 * Re-exports the canonical validation helpers from @kinetic/core so
 * IdbStorage and HybridStorage can import them without depending on the
 * app layer (apps/web/src/lib/security.ts).
 */
export { validateStorageKey, validateStorageValue } from '@kinetic/core';
