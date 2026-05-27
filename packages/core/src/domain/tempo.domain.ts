/**
 * Tempo & EMOM domain — règles de prescription pour la cadence d'exécution
 * (tempo lifting) et l'entraînement à intervalle minute (EMOM).
 *
 * Pur — aucune dépendance, aucun I/O.
 */

// ─── Tempo lifting ──────────────────────────────────────────────────────────

/**
 * Notation tempo standard : 4 nombres dans l'ordre
 *   excentrique - pause bas - concentrique - pause haut
 *
 * Exemples :
 *   "4-1-2-0" : 4 s pour descendre, 1 s pause, 2 s pour monter, pas de pause
 *   "3-0-X-0" : 3 s descente, explosif au montée ("X" = explosive)
 *
 * On accepte "X" → 0.5 s (approximation pour le calcul de durée totale).
 */
export interface Tempo {
  eccentricSec: number;
  pauseBottomSec: number;
  concentricSec: number;
  pauseTopSec: number;
}

const PRESETS: Record<string, Tempo> = {
  standard: { eccentricSec: 2, pauseBottomSec: 0, concentricSec: 1, pauseTopSec: 0 },
  hypertrophy: { eccentricSec: 3, pauseBottomSec: 0, concentricSec: 1, pauseTopSec: 1 },
  control: { eccentricSec: 4, pauseBottomSec: 1, concentricSec: 2, pauseTopSec: 0 },
  explosive: { eccentricSec: 1, pauseBottomSec: 0, concentricSec: 0.5, pauseTopSec: 0 },
  pause_squat: { eccentricSec: 3, pauseBottomSec: 3, concentricSec: 1, pauseTopSec: 0 },
};

export function tempoPreset(name: keyof typeof PRESETS): Tempo {
  return PRESETS[name] ?? PRESETS.standard!;
}

/**
 * parseTempo — convertit "4-1-2-0" ou "4120" en Tempo.
 * Renvoie null si invalide (l'UI doit afficher une erreur).
 */
export function parseTempo(input: string): Tempo | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
  // Accepte "4-1-2-0" ou "4120"
  const parts = cleaned.includes('-')
    ? cleaned.split('-')
    : cleaned.length === 4
      ? [cleaned[0]!, cleaned[1]!, cleaned[2]!, cleaned[3]!]
      : null;
  if (!parts || parts.length !== 4) return null;
  const nums = parts.map((p) => (p === 'X' ? 0.5 : Number(p)));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 15)) return null;
  return {
    eccentricSec: nums[0]!,
    pauseBottomSec: nums[1]!,
    concentricSec: nums[2]!,
    pauseTopSec: nums[3]!,
  };
}

/** Durée d'une rep selon le tempo, en secondes. */
export function repDurationSec(t: Tempo): number {
  return t.eccentricSec + t.pauseBottomSec + t.concentricSec + t.pauseTopSec;
}

/**
 * Estime le temps sous tension (TUT) d'une série pour un nombre de reps.
 * Référence d'hypertrophie : 30–60 s TUT, force : 4–20 s, endurance : 60+.
 */
export function timeUnderTensionSec(t: Tempo, reps: number): number {
  return repDurationSec(t) * Math.max(0, Math.floor(reps));
}

// ─── EMOM (Every Minute On the Minute) ──────────────────────────────────────

export interface EmomBlock {
  /** Nombre de répétitions par minute. */
  repsPerMinute: number;
  /** Nombre total de minutes (= nombre de sets). */
  totalMinutes: number;
  /** Charge à utiliser (kg). */
  weightKg: number;
}

/**
 * suggestEmomReps — donne un nombre de reps "raisonnable" à exécuter par
 * minute pour une intensité donnée (en % 1RM), afin que chaque minute
 * laisse au moins 15 s de repos.
 *
 * Référence : à 70 % 1RM, 5–7 reps prennent ~25–35 s, ce qui laisse 25–35 s
 * de repos. C'est la zone "sweet spot" pour EMOM force-endurance.
 */
export function suggestEmomReps(intensityPct: number): number {
  const p = Math.min(0.95, Math.max(0.3, intensityPct));
  if (p >= 0.9) return 2;
  if (p >= 0.8) return 3;
  if (p >= 0.7) return 5;
  if (p >= 0.6) return 7;
  return 10;
}

/**
 * computeEmomVolume — agrégats utiles à l'UI : reps totales, tonnage.
 */
export function computeEmomVolume(block: EmomBlock): { totalReps: number; tonnageKg: number } {
  const totalReps = block.repsPerMinute * block.totalMinutes;
  return {
    totalReps,
    tonnageKg: Math.round(totalReps * block.weightKg),
  };
}
