import type { ClockPort } from '@kinetic/core';

/**
 * SystemClock — ClockPort basé sur Date.now() et le fuseau local du navigateur.
 *
 * todayIsoDate() renvoie "YYYY-MM-DD" dans le TZ local de l'utilisateur,
 * pour que les streaks respectent son minuit réel (pas UTC).
 */
export class SystemClock implements ClockPort {
  nowMs(): number {
    return Date.now();
  }

  todayIsoDate(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
