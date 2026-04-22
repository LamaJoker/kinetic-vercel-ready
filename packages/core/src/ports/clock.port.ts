/**
 * ClockPort — abstraction de l'horloge système.
 *
 * Permet de mocker le temps dans les tests sans dépendances globales.
 * todayIsoDate() retourne "YYYY-MM-DD" dans le fuseau LOCAL de l'utilisateur.
 */
export interface ClockPort {
  /** Timestamp Unix en millisecondes */
  nowMs(): number;
  /** Date locale ISO "YYYY-MM-DD" (fuseau local, pas UTC) */
  todayIsoDate(): string;
}
