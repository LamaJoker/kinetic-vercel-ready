/** Remplace `@supabase/storage-js` (non utilisé) : voir ./unused.ts. */
import { unavailable } from './unused';

export class StorageApiError extends Error {}

export class StorageClient {
  from(_bucket?: string): never {
    return unavailable('Storage');
  }
}
