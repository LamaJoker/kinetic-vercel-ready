# Kinetic — Architecture & Dev Patterns

## Monorepo structure

```
apps/web/          Vite + Alpine.js PWA (deployed on Vercel)
packages/core/     Domain logic + use-cases (framework-free)
packages/adapter-web/  Supabase + IDB-keyval adapters
tests/             Vitest unit + integration tests
```

## Key tech

- **Alpine.js stores** — reactive state via `Alpine.store('vitalite')`, `Alpine.store('nutrition')`
- **IDB-keyval** (via `@kinetic/adapters-web`) for offline-first persistence
- **Supabase** for cloud sync (optional, gracefully absent when offline)
- **pnpm workspaces** — `pnpm --filter @kinetic/web build`

## Persist-first mutation pattern

All async store mutations follow this exact sequence to prevent UI/storage drift:

```typescript
// 1. Compute the next state (pure, no side-effects)
const nextState = computeNext(this.currentState);
// 2. Persist — await before any reactive assignment
await deps.storage.set(KEY, nextState);
// 3. Only now assign to reactive Alpine state
this.currentState = nextState;
```

Never mutate `this.state` first and then persist — a failed write would leave the store and storage out of sync.

## Idempotency guard for double-click / inflight mutations

```typescript
if (this._pendingIds.includes(id)) return;
this._pendingIds = [...this._pendingIds, id];
try {
  // … persist-first mutation …
} finally {
  this._pendingIds = this._pendingIds.filter((p) => p !== id);
}
```

Use spread (`[...arr, x]`) instead of `.push()` on Alpine proxy arrays to avoid `DataCloneError` when IDB tries to clone the proxy.

## Custom task IDs

Use `crypto.randomUUID()` — do not use `Math.random()`:

```typescript
id: `custom-${crypto.randomUUID()}`;
```

## CI

- `pnpm/action-setup@v6` pinned to `PNPM_VERSION: '9.15.9'` to match `packageManager` in `package.json`
- All 15 CI checks must pass before merging to main
- Secret Scan uses gitleaks CLI v8.21.2 (no GHAS required)
- CodeQL and Trivy use `continue-on-error: true` (GHAS not enabled)
- Vercel auto-deploys on merge to main

## Running locally

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # 556 unit tests
pnpm typecheck    # tsc --build
pnpm lint         # ESLint --max-warnings 0
pnpm format:check # Prettier
pnpm e2e          # Playwright (needs preview server)
```
