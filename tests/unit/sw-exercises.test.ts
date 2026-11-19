/**
 * Service worker : les schémas d'exercices (/exercises/*.svg) sont précachés
 * à l'installation dans un cache persistant et servis hors ligne.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { injectSwTokens } from '../../apps/web/vite.config';

const SW_SRC = readFileSync(resolve(__dirname, '../../apps/web/public/sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

class FakeCache {
  store = new Map<string, Response>();
  async put(req: string | Request, resp: Response) {
    this.store.set(typeof req === 'string' ? req : new URL(req.url).pathname, resp);
  }
  async match(req: string | Request, opts?: { ignoreSearch?: boolean }) {
    const url = new URL(typeof req === 'string' ? req : req.url, 'https://k.test');
    const key = opts?.ignoreSearch ? url.pathname : url.pathname + url.search;
    return this.store.get(key)?.clone();
  }
  async keys() {
    return [...this.store.keys()];
  }
  async delete(k: string) {
    return this.store.delete(k);
  }
}

function boot(src: string, fetchImpl: (url: string) => Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const caches = new Map<string, FakeCache>();
  const cacheStorage = {
    async open(name: string) {
      if (!caches.has(name)) caches.set(name, new FakeCache());
      return caches.get(name)!;
    },
    async keys() {
      return [...caches.keys()];
    },
    async delete(name: string) {
      return caches.delete(name);
    },
    async match(req: Request | string, opts?: { ignoreSearch?: boolean }) {
      for (const c of caches.values()) {
        const hit = await c.match(req, opts);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: 'https://k.test' },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: {},
  };
  const fetchFn = (req: string | Request) =>
    fetchImpl(typeof req === 'string' ? req : new URL(req.url).pathname);
  new Function('self', 'caches', 'fetch', src)(self, cacheStorage, fetchFn);
  return { handlers, caches };
}

const svg = (body = '<svg></svg>') =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });

async function runWaitUntil(handler: Handler | undefined, extra: Record<string, unknown> = {}) {
  let p: Promise<unknown> = Promise.resolve();
  handler?.({ waitUntil: (x: Promise<unknown>) => (p = x), ...extra });
  await p;
}

describe('injectSwTokens', () => {
  it('remplace version et liste triée, filtre les noms suspects', () => {
    const out = injectSwTokens("'__SW_BUILD__' '__SW_EXERCISES__'", 'v1', [
      'squat',
      'curl',
      '../x',
    ]);
    expect(out).toBe("'v1' 'curl,squat'");
  });
});

describe('sw.js — schémas hors ligne', () => {
  const src = injectSwTokens(SW_SRC, 'kinetic-vtest', ['squat', 'curl']);

  it('précache tous les schémas à l’installation, dans un cache persistant', async () => {
    const { handlers, caches } = boot(src, async (url) =>
      url.endsWith('.svg') ? svg(url) : new Response('ok', { status: 200 }),
    );
    await runWaitUntil(handlers.get('install'));
    const ex = caches.get('kinetic-exercises-v1')!;
    expect([...ex.store.keys()].sort()).toEqual(['/exercises/curl.svg', '/exercises/squat.svg']);
  });

  it('garde le cache des schémas à l’activation d’une nouvelle version', async () => {
    const { handlers, caches } = boot(src, async () => svg());
    await runWaitUntil(handlers.get('install'));
    caches.set('kinetic-vOLD-runtime', new FakeCache());
    await runWaitUntil(handlers.get('activate'));
    expect(caches.has('kinetic-exercises-v1')).toBe(true);
    expect(caches.has('kinetic-vOLD-runtime')).toBe(false);
  });

  it('sert le schéma depuis le cache quand le réseau est coupé', async () => {
    let online = true;
    const { handlers } = boot(src, async () => {
      if (!online) throw new Error('offline');
      return svg('<svg id="squat"></svg>');
    });
    await runWaitUntil(handlers.get('install'));
    online = false;
    let responded: Promise<Response> | null = null;
    handlers.get('fetch')?.({
      request: { method: 'GET', url: 'https://k.test/exercises/squat.svg', mode: 'no-cors' },
      respondWith: (r: Promise<Response>) => (responded = r),
    });
    const resp = await responded!;
    expect(await resp.text()).toBe('<svg id="squat"></svg>');
  });

  it('ne met jamais en cache une page HTML de repli', async () => {
    const { handlers, caches } = boot(
      src,
      async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    );
    await runWaitUntil(handlers.get('install'));
    expect(caches.get('kinetic-exercises-v1')!.store.size).toBe(0);
  });

  it('sans jeton injecté (dev), aucune liste et pas d’erreur', () => {
    expect(() => boot(SW_SRC, async () => svg())).not.toThrow();
  });
});
