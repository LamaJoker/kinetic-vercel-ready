# Kinetic — Roadmap

> Source de vérité produit/technique. Remplace le blueprint Codex (qui décrivait
> un état du repo largement périmé : il listait en « à faire » des features déjà
> livrées et dépassées). Dernière vérification du code : **2026-05-28**.

## État réel vérifié

Côté **suivi d'entraînement, l'app est quasi feature-complete**. Constaté fichier
par fichier dans `kinetic-prod` :

- **19 routes** : dashboard, seances, progression, records, plates, achievements,
  photos, mensurations, programs, glossaire, bodyweight, nutrition, vitalité,
  profile, onboarding, login, program…
- **22 domaines purs** (`packages/core/src/domain`) : progression, analytics,
  deload, strength-score, tempo, exercise-substitution, workout-generator,
  muscle-balance, achievements, heatmap, plate-calculator, workout-share,
  profile-share, goals, glossary, programs-catalog, xp, streak, task, nutrition,
  program.
- **9 stores**, **migrations 001→008** (training tables, push_subscriptions,
  ai_coach_usage, vitals RLS), **~1000+ tests** (78 fichiers, ~1182 `it()`).
- **Shell natif Android présent** : Capacitor configuré, scripts `android:*`,
  plugins installés (local-notifications, camera, haptics, share, filesystem).
  Les rappels streak sont déjà fiables sur Android (`streak-reminder.ts` utilise
  `@capacitor/local-notifications`, fallback web Notification en PWA).

Déjà livré (le blueprint Codex le listait pourtant en Phase 1/2/3) : migration
004 (+ bodyweight + weekly_goals), écran Progression + graphes, génération auto
de templates, goals (domaine + store), streak-reminder, `suggestProgression()`
branché dans seances, export branché dans profile, import Strong/Hevy, push web,
AI coach (env-gated), i18n FR/EN, timer de repos plein écran, quick-restart.

---

## P0 — Décisions stratégiques bloquantes

**1. Monétisation — 0 ligne de code.** Aucun Stripe, paywall, ni couche
d'entitlement. Tout le modèle Free/Pro/Coach est non implémenté. Si la monétisation
est un objectif, c'est le chantier #1 : couche `isPro` + gates UI + checkout Stripe

- webhook (Edge Function Supabase + table `subscriptions`). **Effort : L.**
  Ne pas gater l'historique à 30 j (l'historique _est_ le produit) — gater la couche
  _insight_ (analytics avancées, auto-progression, heatmap).

**2. iOS natif + Health.** Le shell Android existe déjà ; **iOS natif n'est pas
configuré** (pas de scripts `ios:`). `health-sync.ts` est un stub : Apple Health /
Google Fit nécessitent le plugin `@capacitor-community/health` + permissions
natives. Décider : (a) publier l'app iOS native ? (b) activer le plugin Health ?

---

## P1 — Activer ce qui est codé mais pas live (faible coût, fort impact)

- **Push web** : pipeline VAPID réel (`lib/push.ts` + table `push_subscriptions`
  - Edge `send-push`). Reste : déployer l'Edge Function, définir
    `VITE_VAPID_PUBLIC_KEY`, tester Android + iOS-PWA. **S–M.**
- **AI coach** : `lib/ai-coach.ts` réel mais env-gated. Reste : clé API, vérifier
  le quota (migration 008), garde-fou coût. **S.**
- **Vérifier le déploiement des migrations 004→008 sur Supabase prod.** **S.**

---

## P2 — Qualité du moteur d'autorégulation _(EN COURS)_

L'engine fonctionne et est mieux qu'annoncé (fenêtre deload 14j, suggestion de
charge de départ profil-aware, deload réduisant volume ET intensité). Gaps réels :

- **Tables RPE→%1RM (RTS/Tuchscherer)** — le fichier cite ces sources mais ne les
  implémente pas. Permet de calculer la charge exacte pour viser une RPE cible au
  lieu d'un `+increment` aveugle. → **module `rpe-chart.domain.ts` (livré, additif).**
- **Sélection du top-set** : `suggestProgression` se base sur le set _littéralement
  dernier_ (qui peut être un back-off/échauffement) au lieu du meilleur set de la
  dernière séance. → **`pickTopSet()` livré ; intégration à faire.**
- **e1RM RPE-aware** : Epley seul ignore la réserve (RIR). `estimatedE1rmFromRpe()`
  (livré) donne une estimation plus juste.
- **Deload via volume (MEV/MRV)** : optionnel, gros effort de modélisation — à
  évaluer plus tard ; l'approche RPE+trend actuelle reste raisonnable.

---

## P3 — Engagement (dépend de P1 push)

- **Bilan hebdo automatique** (tonnage + PR + streak) le dimanche. **S** une fois
  push live.
- **Rappel streak H-4** avant reset — fiable sur Android (déjà câblé) ; best-effort
  en PWA pure / iOS-PWA (limite inhérente).
- **Referral** (1 mois Pro/ami) — dépend de P0-1 (entitlement). **M.**

---

## P4 — Social & long terme

- **Profil public hébergé** (au-delà du token `workout-share`/`profile-share`
  déjà codé). **M.**
- **Health sync réel** — dépend de P0-2. **L.**
- **Scanner code-barres nutrition** (OpenFoodFacts). **M.**

---

## Séquencement recommandé

- Objectif **lancer/monétiser** : P0-1 (entitlement + Stripe) → P1 (activer push +
  AI coach).
- Objectif **qualité produit d'abord** : P2 (moteur, en cours) → P1.
