/**
 * Heatmap Domain — grille de type "GitHub contribution graph" pour visualiser
 * l'assiduité d'entraînement par jour sur N semaines.
 *
 * Pur, sans I/O. Les dates en entrée sont des ISO datetimes (UTC) ; on
 * regroupe par jour LOCAL (fuseau du navigateur), comme on le fait pour les
 * objectifs hebdo.
 *
 * Output structuré pour rendu en grille 7×N (lignes = jours de la semaine).
 */

export interface HeatmapDay {
  /** ISO date locale "YYYY-MM-DD". */
  date: string;
  /** Nombre de séances ce jour. */
  count: number;
  /** Niveau d'intensité 0-4 (pour les couleurs de la heatmap). */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatmapWeek {
  /** ISO date locale du lundi de la semaine. */
  weekStart: string;
  days: HeatmapDay[]; // 7 entrées, lundi → dimanche
}

export interface HeatmapResult {
  weeks: HeatmapWeek[];
  totalSessions: number;
  bestDay: HeatmapDay | null;
  /** Jours actifs (count > 0) sur la fenêtre. */
  activeDays: number;
}

function localIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const offset = (d.getDay() + 6) % 7; // lundi = 0
  d.setDate(d.getDate() - offset);
  return d;
}

function levelOf(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 2;
  if (count === 2) return 3;
  return 4;
}

/**
 * buildHeatmap — construit la grille pour les `weeks` dernières semaines
 * (incluant la semaine courante). Si `now` est un mercredi et `weeks=8`, on
 * retourne 8 semaines complètes : 7 passées + la semaine courante (avec les
 * jours futurs présents mais à count=0).
 */
export function buildHeatmap(
  sessionDates: readonly string[],
  weeks: number = 8,
  now: Date = new Date(),
): HeatmapResult {
  const w = Math.max(1, Math.floor(weeks));

  // Comptage par date locale
  const counts = new Map<string, number>();
  for (const iso of sessionDates) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    const key = localIsoDate(new Date(t));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Génération de la grille — on remonte de `weeks-1` semaines avant la semaine courante
  const currentWeekStart = startOfWeek(now);
  const result: HeatmapWeek[] = [];
  let totalSessions = 0;
  let activeDays = 0;
  let bestDay: HeatmapDay | null = null;

  for (let wi = w - 1; wi >= 0; wi--) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setDate(weekStart.getDate() - wi * 7);
    const days: HeatmapDay[] = [];
    for (let di = 0; di < 7; di++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + di);
      const key = localIsoDate(day);
      const count = counts.get(key) ?? 0;
      const heatmapDay: HeatmapDay = { date: key, count, level: levelOf(count) };
      days.push(heatmapDay);
      totalSessions += count;
      if (count > 0) activeDays++;
      if (!bestDay || count > bestDay.count) bestDay = heatmapDay;
    }
    result.push({ weekStart: localIsoDate(weekStart), days });
  }

  return {
    weeks: result,
    totalSessions,
    bestDay: bestDay && bestDay.count > 0 ? bestDay : null,
    activeDays,
  };
}
