/**
 * Remplace `@supabase/auth-js/…/lib/web3/ethereum` (non utilisé) : voir ./unused.ts.
 * Connexion par portefeuille Ethereum (signInWithWeb3) : sans objet pour Kinetic.
 */
import { unavailable } from './unused';

const web3 = (..._args: unknown[]): never => unavailable('Auth Web3');

export const createSiweMessage = web3;
export const fromHex = web3;
export const getAddress = web3;
export const toHex = web3;
