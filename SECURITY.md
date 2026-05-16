# Politique de sécurité

## Versions supportées

Seule la branche `main` reçoit des patches de sécurité.

## Signaler une vulnérabilité

**Ne crée pas d'issue publique** pour une vulnérabilité de sécurité.

Envoie un rapport privé via :

- GitHub Security Advisories : https://github.com/LamaJoker/kinetic-vercel-ready/security/advisories/new
- Ou en privé au maintainer

Inclus :

- Description du problème
- Étapes de reproduction
- Impact potentiel
- Suggestions de mitigation (optionnel)

Nous accusons réception sous **72 heures** et fournissons un timeline de fix dans la semaine.

## Périmètre

Dans le périmètre :

- Application web (`apps/web`)
- Edge Functions Supabase
- Migrations SQL et RLS
- Configuration Vercel (headers, CSP)

Hors périmètre :

- Vulnérabilités tierces déjà signalées en amont (Alpine.js, Supabase JS, etc.)
- DoS par flood réseau
- Self-XSS sans propagation

## Mesures de sécurité actuelles

- **CSP stricte** avec `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`.
- **HSTS** avec preload.
- **RLS Supabase** : toutes les tables user-data ont `FORCE ROW LEVEL SECURITY`.
- **Rate limiting** côté serveur sur tables critiques (`vitals_metrics`).
- **Input sanitization** côté client (`apps/web/src/lib/security.ts`).
- **Dependency audit** quotidien (workflow `security.yml`).
- **CodeQL** scan sur chaque push.
- **SBOM** CycloneDX généré à chaque build.
- **Trivy** filesystem scan.
- **Gitleaks** secret scan.

## Bonnes pratiques

- Les secrets Supabase **ne sont jamais** committés. Voir `.env.example`.
- Le `SERVICE_ROLE_KEY` n'est **jamais** exposé côté client.
- Les clés OAuth sont rotées tous les 90 jours.
