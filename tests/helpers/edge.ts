/**
 * Faux pour tester les handlers des fonctions Edge sous Node (Request/Response
 * standards) : Supabase Auth, RPC service_role, journal en mémoire.
 */
import { vi } from 'vitest';
import type { AuthPort, AuthResult, RpcPort } from '../../supabase/functions/_shared/ports.ts';
import { createLogger, type Logger } from '../../supabase/functions/_shared/redact.ts';

export const USER_ID = '11111111-2222-4333-8444-555555555555';
export const VALID_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbGlkZQ';
export const ORIGIN = 'https://kinetic.vercel.app';

export const BASE_ENV = {
  ALLOWED_ORIGINS: `${ORIGIN},capacitor://localhost`,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-de-test-0123456789abcdef',
  SUPABASE_ANON_KEY: 'anon-key-de-test',
  RATE_LIMIT_SECRET: 'secret-hmac-de-test',
};

export function fakeAuth(users: Record<string, AuthResult> = {}): AuthPort & {
  getUser: ReturnType<typeof vi.fn>;
} {
  const table: Record<string, AuthResult> = {
    [VALID_JWT]: { status: 'ok', user: { id: USER_ID } },
    ...users,
  };
  return {
    getUser: vi.fn(async (jwt: string) => table[jwt] ?? { status: 'invalid' }),
  };
}

type RpcHandler = (args: Readonly<Record<string, unknown>>) => {
  data: unknown;
  error: { code?: string; message: string } | null;
};

export function fakeRpc(handlers: Record<string, RpcHandler> = {}): RpcPort & {
  rpc: ReturnType<typeof vi.fn>;
  calls: Array<{ fn: string; args: Readonly<Record<string, unknown>> }>;
} {
  const calls: Array<{ fn: string; args: Readonly<Record<string, unknown>> }> = [];
  return {
    calls,
    rpc: vi.fn(async (fn: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ fn, args });
      const handler = handlers[fn];
      if (!handler) return { data: null, error: { code: '42883', message: `inconnu ${fn}` } };
      return handler(args);
    }),
  };
}

export const allowQuota: RpcHandler = () => ({
  data: { allowed: true, reason: 'ok', retry_after_seconds: 0 },
  error: null,
});

export function memLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger('test', {
    info: (l) => lines.push(l),
    warn: (l) => lines.push(l),
    error: (l) => lines.push(l),
  });
  return Object.assign(logger, { lines });
}

export interface RequestOptions {
  method?: string;
  origin?: string | null;
  jwt?: string | null;
  headers?: Record<string, string>;
  /** `auto` : longueur exacte ; `none` : pas d'en-tête ; nombre : valeur imposée. */
  contentLength?: 'auto' | 'none' | number;
  contentType?: string | null;
}

export function jsonRequest(url: string, body: unknown, opts: RequestOptions = {}): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { ...opts.headers };
  const contentType = opts.contentType === undefined ? 'application/json' : opts.contentType;
  if (contentType !== null) headers['content-type'] = contentType;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  const jwt = opts.jwt === undefined ? VALID_JWT : opts.jwt;
  if (jwt !== null) headers['authorization'] = `Bearer ${jwt}`;
  const cl = opts.contentLength ?? 'auto';
  if (cl === 'auto') headers['content-length'] = String(new TextEncoder().encode(text).byteLength);
  else if (cl !== 'none') headers['content-length'] = String(cl);
  const method = opts.method ?? 'POST';
  return new Request(url, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: text }),
  });
}

/**
 * Corps en flux qui compte les octets réellement tirés : prouve qu'un corps
 * énorme n'est pas lu en entier.
 */
export function hugeStreamRequest(
  url: string,
  totalBytes: number,
  opts: RequestOptions = {},
): { req: Request; pulled: () => number } {
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(8192));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  const jwt = opts.jwt === undefined ? VALID_JWT : opts.jwt;
  if (jwt !== null) headers['authorization'] = `Bearer ${jwt}`;
  if (typeof opts.contentLength === 'number')
    headers['content-length'] = String(opts.contentLength);
  const req = new Request(url, {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { req, pulled: () => pulled };
}
