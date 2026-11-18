/**
 * Remplace `@supabase/auth-js/…/lib/webauthn` (non utilisé) : voir ./unused.ts.
 * Kinetic ne propose ni double authentification ni passkeys : seuls le lien
 * magique et OAuth servent (stores/auth.ts).
 */
import { unavailable } from './unused';

const webauthn = (..._args: unknown[]): never => unavailable('Auth WebAuthn (MFA, passkeys)');

export class WebAuthnApi {
  constructor(_client?: unknown) {}
  enroll = webauthn;
  challenge = webauthn;
  verify = webauthn;
  authenticate = webauthn;
  register = webauthn;
}

export const webAuthnAbortService = { createNewAbortSignal: webauthn, cancelCeremony(): void {} };
export const browserSupportsWebAuthn = (): boolean => false;
export const createCredential = webauthn;
export const getCredential = webauthn;
export const deserializeCredentialCreationOptions = webauthn;
export const deserializeCredentialRequestOptions = webauthn;
export const serializeCredentialCreationResponse = webauthn;
export const serializeCredentialRequestResponse = webauthn;
