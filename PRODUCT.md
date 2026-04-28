# Kinetic — Blueprint produit & technique

> Document de vision produit + architecture pour faire évoluer Kinetic
> d'une to-do list sportive vers une app complète de suivi d'entraînement.
> Exploitable directement : les modules `progression`, `analytics`,
> `rest-timer` et `export` livrés dans cette branche sont déjà câblés.

---

## 1. Analyse produit

### Faiblesses d'une to-do list classique appliquée à la musculation

| # | Problème | Impact utilisateur |
|---|----------|--------------------|
| 1 | Une "tâche" ne décrit pas une série (poids × reps × RPE) | Impossible de suivre le progrès réel |
| 2 | Pas de notion de **surcharge progressive** | Stagnation sans alerte |
| 3 | Aucune **récupération** modélisée (fatigue, deload) | Plateau, blessures |
| 4 | Pas d'**agrégats** (volume, tonnage, PR) | Aucun insight à long terme |
| 5 | Pas de **timer de repos** | UX friction en pleine séance |
| 6 | Aucun **historique/graphe** par exercice | Pas de feedback motivant |
| 7 | Checklist = binaire (fait / pas fait) | Nuance perdue (RPE, réserve) |
| 8 | Pas de **génération automatique** de séance | Charge cognitive haute |

### Vision produit

> **Kinetic = un coach de poche qui pense à ta place entre les séries.**
> Offline-first, mobile-first, gamifié, data-driven — mais toujours simple
> à utiliser pieds humides avec une main dans les gants.

**Cible principale**
- 18-40 ans, salle de sport classique ou home gym
- Niveau intermédiaire (≥ 6 mois d'entraînement)
- Veut progresser sans y penser → délègue les calculs à l'app

**Cible secondaire**
- Débutants qui sortent d'un programme guidé et veulent autonomie
- Athlètes qui veulent un carnet propre, exportable, partageable

**Différenciation**
1. **Auto-progression RPE** — charge suivante suggérée à chaque série (pas juste "coche la tâche")
2. **Offline-first sérieux** — IndexedDB + CRDT + sync Supabase, jamais de perte de donnée
3. **PWA native-feel** — pas besoin d'installer 200 Mo, tout tourne dans le navigateur
4. **Gamification honnête** — XP + streak, mais liée à la *qualité* de la séance (pas juste présence)
5. **Data ownership** — export JSON/CSV en 1 clic, pas de lock-in

---

## 2. Roadmap fonctionnelle structurée

### 🧠 Suivi intelligent — *partiellement livré dans cette branche*

| Feature | État | Module |
|---------|------|--------|
| Tracking poids / reps / RPE | ✅ existant | `lib/training/types.ts` |
| Historique par exercice | ✅ existant | stockage IDB |
| Estimation e1RM (Epley) | ✅ existant | `lib/training/rpe.ts` |
| **Suggestion automatique de progression** | ✅ **NEW** | `core/domain/progression.domain.ts` |
| **Détection de deload (fatigue chronique)** | ✅ **NEW** | `needsDeload()` |
| Suggestion de charge de départ (1er exo) | 🟡 fallback heuristique | à enrichir avec profil |

### 📅 Planification avancée

| Feature | État |
|---------|------|
| Splits PPL / Upper-Lower / Full Body / Bro Split | ✅ existant (`program.domain.ts`) |
| Génération automatique depuis un split + objectifs | 🟡 à faire (use case) |
| Adaptation fatigue/récupération (insert deload semaine) | 🟡 lié à `needsDeload()` |
| Planning par jour de la semaine | ✅ existant (`todayFocus()`) |

### 📊 Analytics — *livré dans cette branche*

| Feature | Module |
|---------|--------|
| **Tonnage hebdomadaire** | `weeklyVolume()` |
| **Stats par exercice** (tonnage, meilleur e1RM) | `perExerciseStats()` |
| **Heatmap muscles** | `muscleDistribution()` |
| **Détection PR automatique** | `detectPRs()` |
| **Score de régularité (N semaines)** | `consistencyScore()` |

### 🔔 Engagement

| Feature | État |
|---------|------|
| XP + niveaux (8 paliers) | ✅ existant |
| Streak quotidien | ✅ existant |
| **Timer de repos (vibration + notification)** | ✅ **NEW** (`lib/training/rest-timer.ts`) |
| Push Web réelle (Service Worker + VAPID) | 🟡 à faire |
| Objectifs hebdo (3 séances, X kg tonnage) | 🟡 à faire |

### 👤 UX

| Feature | État |
|---------|------|
| Mobile-first, dark, minimal | ✅ existant |
| Onboarding multi-étapes | ✅ existant |
| Quick-start séance (dernière ou template du jour) | 🟡 à faire |
| Raccourci +1 rep / +incrément | 🟡 à faire |
| Timer plein écran entre séries | 🟡 lié au nouveau module |

### 🌐 Social *(optionnel, phase 3)*

| Feature | Priorité |
|---------|----------|
| Profil public (best lifts, streaks) | Basse |
| Défis entre amis (tonnage hebdo) | Moyenne |
| Partage de template via lien | Haute (viral, simple) |

### 🧩 Extras différenciants — *partiellement livré*

| Feature | État |
|---------|------|
| Mode offline complet | ✅ existant |
| Sync cloud (Supabase + RLS + CRDT) | ✅ existant |
| **Export JSON / CSV des séances** | ✅ **NEW** (`lib/training/export.ts`) |
| Import depuis Strong / Hevy | 🟡 à faire (format CSV standardisé) |
| Wearables (Apple Health, Google Fit) | 🟡 phase 3 |

---

## 3. Architecture technique

### Stack existante (déjà solide — à garder)

```
Frontend  : Alpine.js 3 + Vite + Tailwind 3 (PWA, service worker)
Langage   : TypeScript strict (monorepo pnpm)
Storage   : IndexedDB (idb-keyval) + Supabase (Postgres, RLS)
Auth      : Supabase (magic link + OAuth Google)
Sync      : HybridStorage (IDB→cloud, CRDT)
Tests     : Vitest (214 tests unitaires/intégration) + Playwright (E2E)
CI/CD     : GitHub Actions → Vercel (Paris CDN)
```

### Découpage des packages (clean architecture)

```
packages/core           # Pure TS — domaine, zero I/O
├── domain/             # Règles métier (xp, streak, task, nutrition, program,
│                       #                 progression ★, analytics ★)
├── ports/              # Interfaces (Storage, Clock, Notifier, IdGen)
└── usecases/           # Orchestration (complete-task, award-xp…)

packages/adapter-web    # Implémentations navigateur
├── IdbStorage          # IndexedDB
├── SystemClock         # Date.now
└── supabase/           # SupabaseStorage, HybridStorage, auth, CRDT

apps/web                # UI Alpine
├── pages/              # HTML + .page.ts par route
├── stores/             # auth, xp, vitalite, nutrition, notifications, offline
├── lib/
│   ├── training/       # types, storage, seed, rpe, calories,
│   │                   #  rest-timer ★, export ★
│   └── user/           # profil
└── router.ts           # SPA History API
```

★ = modules livrés dans cette branche.

### API design (quand on introduira un backend dédié)

> Aujourd'hui Supabase suffit (auth + Postgres RLS + storage).
> Quand un backend métier deviendra nécessaire (coach IA, fédération sociale),
> on ajoute une fonction Edge Supabase avec ces endpoints :

```
POST   /api/v1/sessions                  # Créer une séance
GET    /api/v1/sessions?from=&to=        # Historique paginé
POST   /api/v1/sessions/:id/sets         # Ajouter un set
GET    /api/v1/progression?exerciseId=   # Suggestion charge prochaine
GET    /api/v1/analytics/weekly          # Agrégats tonnage
GET    /api/v1/analytics/prs             # Records personnels
POST   /api/v1/export?format=json|csv    # Export server-side (gros historiques)
POST   /api/v1/programs/generate         # Génération split + templates
```

Contrats typés via `packages/core` (DTO = Domain types).

### Modèle de données (PostgreSQL — à ajouter)

Migration `004_training_tables.sql` (suggérée) :

```sql
create table public.workout_sessions (
  id           uuid primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  template_id  uuid,
  started_at   timestamptz not null,
  ended_at     timestamptz,
  duration_min int,
  avg_rpe      numeric(3,1),
  calories_kcal int,
  created_at   timestamptz default now()
);

create table public.workout_sets (
  id           uuid primary key,
  session_id   uuid not null references workout_sessions(id) on delete cascade,
  exercise_id  text not null,
  set_index    int  not null,
  reps         int  not null check (reps between 0 and 100),
  weight_kg    numeric(6,2) not null check (weight_kg >= 0),
  rpe          numeric(3,1) check (rpe between 6 and 10),
  performed_at timestamptz not null default now()
);

create index on workout_sessions (user_id, started_at desc);
create index on workout_sets     (session_id, set_index);
create index on workout_sets     (exercise_id, performed_at desc);

alter table workout_sessions enable row level security;
alter table workout_sets     enable row level security;

create policy "own sessions" on workout_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own sets" on workout_sets
  for all using (
    exists (select 1 from workout_sessions s
            where s.id = session_id and s.user_id = auth.uid())
  );
```

---

## 4. UI / UX

### Direction design

- **Palette** — violet `#7F77DD` (progression), teal `#00C2A0` (vitalité),
  gold `#FFD166` (force), coral `#FF6B6B` (alertes). Fond noir profond `#0A0A0F`.
- **Typographie** — Inter 16 px, 1.5 line-height, bold 700 uniquement sur chiffres.
- **Densité** — gros boutons (48 px tactile mini), une action principale par écran.
- **Feedback** — confettis sur PR, vibration sur fin de repos, toast sur XP.

### Écrans clés

**Dashboard**
- XP bar + niveau (gradient purple → violet)
- Streak avec flamme animée
- "Prochaine séance" (bouton primaire plein écran)
- 3 mini-stats : volume semaine, PR du mois, score régularité

**Séance en cours**
- 1 exercice à la fois (swipe horizontal entre exos)
- Chaque set = 3 champs XXL : reps / kg / RPE
- **Suggestion IA** en dessous : "100 kg × 8 @ RPE 8" avec justification
- Bouton "⏱️ Repos 90 s" après validation d'un set → timer plein écran
- Progress bar : 3 sets sur 4 validés

**Progression**
- Onglets : Force | Volume | Muscles | Records
- **Force** : courbe e1RM par exo sélectionné
- **Volume** : bar chart tonnage / semaine
- **Muscles** : heatmap corps humain (SVG)
- **Records** : timeline des PR avec date + vidéo (phase 2)

**Profil**
- Photo + niveau + titre
- Objectifs (poids cible, date)
- **Export de données** (JSON / CSV) — un tap
- Réglages (unités kg/lbs, thème, notifs)

### Mobile-first

- Navigation bottom tab 5 items, toujours visible
- Toutes les actions destructives → confirmation dialog natif (`<dialog>`)
- `vh` bug iOS : on utilise `100dvh` + fallback `window.innerHeight`
- Safe area insets respectées (`env(safe-area-inset-bottom)`)

---

## 5. Code — exemples concrets (livrés)

### 5.1 Suggestion de progression (RPE-based autoregulation)

`packages/core/src/domain/progression.domain.ts`

```ts
import { suggestProgression, type PerformedSet } from '@kinetic/core';

const history: PerformedSet[] = [
  { reps: 8, weightKg: 100, rpe: 7, at: '2025-04-15T18:00:00Z' },
  { reps: 8, weightKg: 102.5, rpe: 8, at: '2025-04-18T18:00:00Z' },
];

const suggestion = suggestProgression({
  exerciseId:  'squat',
  targetReps:  8,
  targetRpe:   8,
  incrementKg: 2.5,
  history,
});

// suggestion.strategy        → 'increase_weight' | 'increase_reps' | 'hold' | 'deload' | 'first_time'
// suggestion.suggestedWeight → 105
// suggestion.rationale       → "RPE 7 < cible 8 avec reps ok — +2.5 kg."
// suggestion.confidence      → 0..1
```

**Règles d'autorégulation** :
1. Historique vide → `first_time`
2. 3 dernières séances RPE ≥ 9.5 + e1RM plat/négatif → `deload` (-10 %)
3. Dernier set RPE ≤ cible − 1 et reps atteintes → `increase_weight` (+incrément)
4. RPE ≈ cible mais reps manquantes → `increase_reps` (double progression)
5. Sinon → `hold`

### 5.2 Analytics — tonnage hebdomadaire

`packages/core/src/domain/analytics.domain.ts`

```ts
import { weeklyVolume, perExerciseStats, detectPRs, type AnalyticsSet } from '@kinetic/core';

const sets: AnalyticsSet[] = sessions.flatMap(sess =>
  sess.entries.flatMap(e =>
    e.sets.map(s => ({
      sessionId:   sess.id,
      exerciseId:  e.exerciseId,
      muscles:     exerciseCatalog.get(e.exerciseId)?.muscles ?? [],
      reps:        s.reps,
      weightKg:    s.weightKg,
      rpe:         s.rpe,
      performedAt: s.performedAt,
    }))
  )
);

const volume = weeklyVolume(sets);      // → [{ isoWeek, tonnageKg, totalSets, totalReps }]
const byExo  = perExerciseStats(sets);  // → classé par tonnage décroissant
const prs    = detectPRs(sets);         // → timeline des records e1RM croissants
```

### 5.3 Rest timer avec vibration + notification

`apps/web/src/lib/training/rest-timer.ts`

```ts
import { startRestTimer, requestNotificationPermission, suggestedRestSec } from './rest-timer';

// 1. Demander la permission notif au premier tap utilisateur
await requestNotificationPermission();

// 2. Démarrer le timer après validation d'un set
const timer = startRestTimer({
  durationSec: suggestedRestSec(lastRpe),  // 60 / 90 / 180 selon RPE
  onTick: remaining => (document.getElementById('rest')!.textContent = `${remaining}s`),
  onDone: () => playReadySound(),
  label:  'Série suivante — go !',
});

// 3. Contrôles
timer.pause(); timer.resume(); timer.skip(); timer.stop();
```

### 5.4 Export JSON / CSV

`apps/web/src/lib/training/export.ts`

```ts
import { exportAsJson, exportAsCsv } from './export';

document.getElementById('btn-export-csv')!.addEventListener('click', () => {
  exportAsCsv(allSessions, allExercises); // télécharge kinetic-export-YYYY-MM-DD.csv
});
```

### 5.5 Structure d'une séance (types déjà existants)

`apps/web/src/lib/training/types.ts`

```ts
interface WorkoutSession {
  id:         WorkoutSessionId;
  name:       string;
  templateId?: WorkoutTemplateId;
  startedAt:  IsoDateTime;
  endedAt?:   IsoDateTime;
  entries:    readonly SessionExerciseEntry[];
  durationMin?: number;
  avgRpe?:    number;
  caloriesKcal?: number;
}

interface SessionExerciseEntry {
  exerciseId: ExerciseId;
  sets:       readonly SetEntry[];
}

interface SetEntry {
  setIndex:    number;
  reps:        number;
  weightKg:    number;
  rpe:         number;          // 6..10
  performedAt: IsoDateTime;
}
```

---

## 6. Optimisation business

### Modèle de monétisation — **Freemium + abonnement**

| Tier | Prix | Ce qu'on débloque |
|------|------|-------------------|
| **Free** | 0 € | Tracking illimité, XP, streak, 1 programme actif, 30 jours d'historique |
| **Pro** | 4,99 €/mois ou 39 €/an | Historique illimité, analytics avancées (heatmap, PR timeline), IA auto-progression, export, sync cloud multi-device, programmes illimités |
| **Coach** | 19 €/mois | Pro + partage de programmes, suivi d'élèves (5 max) — phase 3 |

**Gates naturelles** :
- L'historique > 30 j = vrai valeur ajoutée (motivation, analytics)
- L'auto-progression = la feature qui *remplace un coach* → payant justifié
- Export = data ownership → rassure même les non-abonnés

### Leviers de rétention

1. **Streak visuel** avec rappel push si on est à H-4 du reset (engagement +30 %)
2. **PR notification** — célébration instantanée après la série, confettis + partage
3. **Bilan hebdo automatique** — email / push chaque dimanche avec 3 chiffres (tonnage, nouveau PR, streak)
4. **Challenges mensuels** — "100 pompes par jour", "squat 1× poids de corps" → badges non monétisés
5. **Onboarding < 90 s** — 3 questions (sexe / objectif / niveau) → 1ère séance proposée direct
6. **Empty states utiles** — jamais d'écran vide, toujours "commence ici"
7. **Referral** — 1 mois Pro offert pour chaque ami inscrit qui complète 3 séances

### Métriques à tracker (déjà `lib/analytics.ts`)

- D1 / D7 / D30 retention
- Séances/semaine (médiane)
- Conversion Free → Pro (cible 4-6 % à M+3)
- Churn mensuel < 5 %
- NPS in-app après 10 séances complétées

---

## 7. Prochaines étapes (priorisées)

### Phase 1 — 2 semaines *(immédiat, bas risque)*

- [x] Moteur de progression RPE (`progression.domain.ts`) ← livré
- [x] Module analytics (`analytics.domain.ts`) ← livré
- [x] Rest timer + notifications ← livré
- [x] Export JSON/CSV ← livré
- [x] Brancher `suggestProgression()` dans `seances.page.ts` sous chaque exo
- [x] Écran "Progression" avec graphes — onglets Force / Volume / Muscles / Records
      (`progression.page.ts` + `progression.html`, route `/progression`, SVG natif)
- [x] Bouton "Exporter mes données" dans Profil

### Phase 2 — 1 mois

- [x] Génération automatique de templates depuis un split choisi
      (bouton "⚡ Générer" dans `program.html`, mapping muscles → exercices IDB)
- [x] Push Web réel — rappel streak local à 20h (`lib/streak-reminder.ts`,
      Notification API, planifié au démarrage, pas de VAPID requis)
- [x] Objectifs hebdomadaires (3 séances, X kg tonnage) avec XP bonus +100
      (`stores/goals.ts`, widget dashboard, reload sur `kinetic:session-saved`)
- [x] Migration SQL `004_training_tables.sql` — workout_sessions, workout_sets,
      bodyweight_entries, weekly_goals (RLS activé)
- [x] UI bodyweight refaite — hero poids, barre objectif, graphe avec grille +
      goal line, historique avec indicateurs de tendance ↑↓→

### Phase 3 — 2-3 mois

- [ ] Partage de template via lien public (viral)
- [ ] Intégration Apple Health / Google Fit (poids, fréquence cardiaque)
- [ ] Scanner code-barres pour nutrition (OpenFoodFacts gratuit)
- [ ] Paywall + Stripe pour tier Pro

---

## 8. Contraintes respectées

- ✅ **Simplicité** — chaque feature livrée a une API < 5 paramètres
- ✅ **Pas de gadget** — zéro IA externe facturée, tout tourne en TS pur
- ✅ **Mobile-first** — timer avec Vibration API + Notification API
- ✅ **Code production** — 214 tests verts, TS strict, zéro dépendance ajoutée
- ✅ **Offline-first préservé** — tous les nouveaux modules sont pure functions, compatibles IDB

---

*Document vivant — à mettre à jour à chaque merge de phase.*
