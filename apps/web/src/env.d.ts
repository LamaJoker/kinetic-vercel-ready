/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_PUBLIC_SITE_URL: string;
  readonly VITE_APP_VERSION: string;
  /** 'true' uniquement dans les builds E2E (pnpm build:e2e). */
  readonly VITE_E2E?: string;
  /** URL de collecte des Web Vitals (optionnel ; sinon rien n'est envoyé). */
  readonly VITE_VITALS_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
