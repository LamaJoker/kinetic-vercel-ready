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

**1. Monétisation — EN COURS (2026-06-18).** Modèle free/Pro défini + **couche
d'entitlement livrée** (`entitlements.domain.ts` : `effectiveTier`/`isPro`/`canUse`/
`startTrial`, essai 7 j, `PRO_FEATURES`, limite programmes gratuits). Reste :
gates UI sur la couche insight + checkout Stripe + webhook (Edge Function Supabase

- table `subscriptions`). **Effort restant : M–L.**
  Free = log + historique (jamais gaté) + stats de base + programmes illimités. Pro
  (~4,99 €/mois) = intelligence : auto-progression, deload, analytics avancées, AI
  coach, scan nutrition, export.

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

## P2 — Qualité du moteur d'autorégulation _(✅ LIVRÉ 2026-06-18)_

L'engine fonctionne (fenêtre deload 14j, charge de départ profil-aware, deload
réduisant volume ET intensité). Les gaps identifiés sont désormais comblés :

- ✅ **Tables RPE→%1RM (RTS/Tuchscherer)** — `rpe-chart.domain.ts` livré.
- ✅ **Sélection du top-set** — `suggestProgression` utilise désormais le meilleur
  set de la dernière séance (`pickTopSet`), plus le dernier set littéral.
- ✅ **e1RM RPE-aware** — `estimatedE1rmFromRpe()` ; la charge cible d'augmentation
  est calculée via la charte RTS, plus un `+increment` aveugle.
- ✅ **Deload via volume (MEV/MRV)** — `deload-advisor.domain.ts` :
  `buildDeloadRecommendation()` combine volume hebdo/muscle vs MRV (repères RP/
  Israetel) ET `needsDeload()` (fatigue RPE) en une reco de planification.

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
- ~~**Scanner code-barres nutrition** (OpenFoodFacts)~~ ✅ **livré 2026-06-18** :
  `openfoodfacts.domain.ts` (parseur pur — normalise les données crowdsourcées :
  kcal/kJ/Atwater, marques, portions) + `lib/openfoodfacts.ts` (fetch) + méthode
  `scanBarcode` du store nutrition + champ code-barres dans la page. Recherche par
  saisie du code ; scan caméra (plugin ML Kit) = ajout futur trivial.

---

## Séquencement recommandé

- Objectif **lancer/monétiser** : P0-1 (entitlement + Stripe) → P1 (activer push +
  AI coach).
- Objectif **qualité produit d'abord** : P2 (moteur, en cours) → P1.
