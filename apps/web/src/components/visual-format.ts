/** Formats partagés par le calendrier et la carte des muscles (chunks à la demande). */

/** 840 → « 840 kg » ; 12 480 → « 12,5 t ». */
export function formatTonnage(kg: number): string {
  const v = Number.isFinite(kg) ? Math.max(0, kg) : 0;
  if (v >= 1000) return `${(v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} t`;
  return `${Math.round(v).toLocaleString('fr-FR')} kg`;
}
