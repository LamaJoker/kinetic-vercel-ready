/**
 * RateLimiter Supabase — protège les endpoints d'auth côté client.
 * Supabase a son propre rate limiting serveur, mais cette couche
 * évite les appels inutiles et améliore l'UX.
 */

interface Attempt {
  timestamp: number;
}

export class AuthRateLimiter {
  private readonly attempts = new Map<string, Attempt[]>();

  // Magic link : 3 tentatives / 5 minutes
  private readonly MAGIC_LINK_MAX       = 3;
  private readonly MAGIC_LINK_WINDOW_MS = 5 * 60 * 1000;

  // OAuth : 10 tentatives / minute
  private readonly OAUTH_MAX       = 10;
  private readonly OAUTH_WINDOW_MS = 60 * 1000;

  canSendMagicLink(email: string): boolean {
    return this.check(`magic:${email}`, this.MAGIC_LINK_MAX, this.MAGIC_LINK_WINDOW_MS);
  }

  canOAuth(): boolean {
    return this.check('oauth', this.OAUTH_MAX, this.OAUTH_WINDOW_MS);
  }

  recordMagicLink(email: string): void {
    this.record(`magic:${email}`);
  }

  recordOAuth(): void {
    this.record('oauth');
  }

  getWaitTimeMs(email: string): number {
    const key      = `magic:${email}`;
    const now      = Date.now();
    const attempts = this.getValidAttempts(key, this.MAGIC_LINK_WINDOW_MS, now);
    if (attempts.length < this.MAGIC_LINK_MAX) return 0;
    const oldest = attempts[0]!;
    return oldest.timestamp + this.MAGIC_LINK_WINDOW_MS - now;
  }

  private check(key: string, max: number, windowMs: number): boolean {
    const now   = Date.now();
    const valid = this.getValidAttempts(key, windowMs, now);
    return valid.length < max;
  }

  private record(key: string): void {
    const now  = Date.now();
    const list = this.attempts.get(key) ?? [];
    list.push({ timestamp: now });
    this.attempts.set(key, list);
  }

  private getValidAttempts(key: string, windowMs: number, now: number): Attempt[] {
    const list  = this.attempts.get(key) ?? [];
    const valid = list.filter((a) => now - a.timestamp < windowMs);
    this.attempts.set(key, valid);
    return valid;
  }
}

// Singleton partagé
export const authRateLimiter = new AuthRateLimiter();
