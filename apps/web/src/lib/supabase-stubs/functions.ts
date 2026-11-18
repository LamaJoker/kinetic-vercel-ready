/** Remplace `@supabase/functions-js` (non utilisé) : voir ./unused.ts. */
import { unavailable } from './unused';

export const FunctionRegion = {} as const;
export class FunctionsError extends Error {}
export class FunctionsFetchError extends FunctionsError {}
export class FunctionsHttpError extends FunctionsError {}
export class FunctionsRelayError extends FunctionsError {}

export class FunctionsClient {
  invoke(_name?: string, _options?: unknown): never {
    return unavailable('Functions');
  }
}
