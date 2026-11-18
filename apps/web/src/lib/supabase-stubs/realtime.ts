/** Remplace `@supabase/realtime-js` (non utilisé) : voir ./unused.ts. */
import { unavailable } from './unused';

export class RealtimeClient {
  // Appelé par supabase-js à chaque changement de session : sans effet ici.
  setAuth(_token?: string | null): Promise<void> {
    return Promise.resolve();
  }
  channel(_name?: string, _opts?: unknown): never {
    return unavailable('Realtime');
  }
  getChannels(): never[] {
    return [];
  }
  removeChannel(_channel?: unknown): Promise<'ok'> {
    return Promise.resolve('ok');
  }
  removeAllChannels(): Promise<'ok'[]> {
    return Promise.resolve([]);
  }
}
