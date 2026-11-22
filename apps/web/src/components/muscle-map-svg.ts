/**
 * Silhouette avant / arrière dessinée à la main (aucune image externe), pour
 * la carte des muscles. Seule la moitié droite de chaque vue est décrite ; la
 * gauche est son miroir. Chaque zone porte la classe `mm-r-<zone>` (lecture du
 * toucher par délégation : x-svg ne recrée pas les gestionnaires d'événements)
 * et `k-mm-l<palier>` pour sa couleur (styles dans visual-views.css, qui lisent
 * la palette : sombre et clair).
 */
import type { MuscleLevel, MuscleRegion } from '@kinetic/core';

type Shape = readonly [region: MuscleRegion | null, d: string];

/** Vue de face, moitié droite (axe x = 60). `null` : partie neutre (tête, mains…). */
const FRONT: readonly Shape[] = [
  [null, 'M54 29h12l1.5 12h-15z'],
  ['traps', 'M65.5 33q4 6.5 15.5 9l-14.5 0.5z'],
  [
    'shoulders',
    'M82 42.5c7 0 11.5 5 11.8 12.5 0.2 5.5-1.6 10.5-3.6 14.5-1.8-7-6-12.5-12.5-16.5-0.6-4.8 1-8.8 4.3-10.5z',
  ],
  ['chest', 'M61 45l16-0.8c5 5 7.6 11.6 7 19.6-4.6 7-12.6 9.8-23 8.6z'],
  [
    'biceps',
    'M85.6 64.5c5 2.2 7.8 8 7.8 15.6 0 7.6-1.8 13-4.8 16.2-3-3.4-5-9.4-5.2-17 0-6.4 0.6-11 2.2-14.8z',
  ],
  [
    'forearms',
    'M89.4 99.5c4.6 1 7.4 6.6 8.4 14.4 0.8 7.4 0.8 13.4 0.2 18.6h-5c-2-7.6-4.6-17.6-5.4-25.6-0.2-4 0.6-6.4 1.8-7.4z',
  ],
  [null, 'M93 134.5h5.6c1.6 2.6 2.4 6.4 1.6 9.8-0.8 3-3.2 4.2-5.4 3.4-2-1-2.6-4-2.4-7.4z'],
  [
    'core',
    'M62 76h8.4v9.4h-8.4zM62 87.6h8.4v9.4h-8.4zM62 99.2h8.4v9.6h-8.4zM62 111h8.4v8.6c-2.6 1.6-5.4 2.4-8.4 2.6z',
  ],
  ['core', 'M72.6 75.4c4.6 0.6 8 4.4 9 11.4 1.2 9.6-0.6 19.2-4.8 27.6l-4.2 2.6z'],
  [null, 'M61 123.4c4.6-0.4 9.6-2 15-5 3.4 3 5.6 7 6.4 11.6-6.4-2.4-12.6-1.8-18.4 2.2l-3 1.4z'],
  ['adductors', 'M61.2 134.6c1.8-0.8 3.6-0.6 5 0.6-0.6 11 0 21.4 1.6 30.8-3.4-5-5.8-12-6.6-20.6z'],
  [
    'quads',
    'M67.6 131.4c6-3.2 12-3.4 16.4 0.2 2.2 12 1.8 25.6-2.8 37.6-3.4 2-8 2.2-11.4 0.4-2.6-11.2-3.6-24.2-2.2-38.2z',
  ],
  [null, 'M69.8 172.6c3.4 1.6 7.6 1.6 11 0.2l0.6 7.6c-3.8 1.8-8.4 1.8-12 0.2z'],
  [
    'calves',
    'M69.6 184c3.6-2.4 9-2.2 11.4 1.6 2 12.4 0.8 26-2.2 39.6h-6c-2.4-13.2-4-27.2-3.2-41.2z',
  ],
  [null, 'M72.4 227.4h6.4c2.6 2.6 4.6 6 4.6 9.8-0.2 1.4-1 2-2.4 2h-9.6c-0.6-4-0.2-8 1-11.8z'],
];

/** Vue de dos, moitié droite. */
const BACK: readonly Shape[] = [
  [null, 'M54 29h12l1 9h-14z'],
  [
    'traps',
    'M60 30.5c2.6 5 6 8.8 10.4 11 4.4 1.6 9 2.2 13.4 2.6l-12.4 6.6c-4.6 8.2-8.4 16.8-11.4 26z',
  ],
  [
    'rear_delts',
    'M84.6 44.6c5.6 0.8 9 5.6 9.2 12.2 0.2 5.2-1.4 9.6-3.6 13.2-1.8-6.4-5.6-11.6-11.4-15.4z',
  ],
  ['upper_back', 'M72.6 52.4l10.4-1.6c2.6 5.2 2.6 11 0 16.6l-15.6 3.4c0.8-6.8 2.6-12.8 5.2-18.4z'],
  [
    'lats',
    'M64 80.6c5.6-5.6 12.2-9.2 19.6-11 2 8.6 1.2 18.2-2.6 27.4-3.6 7.6-8.4 13.6-13.4 18.6v-19.4c-0.8-6-2-11.2-3.6-15.6z',
  ],
  ['lower_back', 'M61 84c2 3.6 3.6 8 4.4 13v20.2c-1.2 2.4-2.6 3.8-4.4 4.4z'],
  [
    'triceps',
    'M85.8 60.6c4.8 2.2 7.8 8 8.2 15.8 0.2 7.8-1.6 13.8-4.6 18.8-3.2-3.8-5.2-10-5.6-17.6-0.2-7 0.4-12.6 2-17z',
  ],
  [
    'forearms',
    'M89.4 99.5c4.6 1 7.4 6.6 8.4 14.4 0.8 7.4 0.8 13.4 0.2 18.6h-5c-2-7.6-4.6-17.6-5.4-25.6-0.2-4 0.6-6.4 1.8-7.4z',
  ],
  [null, 'M93 134.5h5.6c1.6 2.6 2.4 6.4 1.6 9.8-0.8 3-3.2 4.2-5.4 3.4-2-1-2.6-4-2.4-7.4z'],
  ['glutes', 'M61 123.6c5.4-4.4 13-5.4 19.4-1.8 4 5.4 4.6 13 1.2 19.6-5.8 4.4-13.6 5.2-20.6 2.6z'],
  [
    'hamstrings',
    'M63.4 147.6c6.4 0.4 13.4-0.6 20.2-3.2 1.8 10 1 19.6-3 28.2h-12.4c-3-7.4-4.6-15.6-4.8-25z',
  ],
  [null, 'M68.6 175h12.2l-0.4 6.4c-3.8 1.4-7.6 1.4-11.4 0z'],
  [
    'calves',
    'M68.6 184.4c3.6-3.2 10-3.4 13 0.6 2.4 8.4 2 17.6-1.8 26-2.2 5-3.4 9.4-3.6 14.2h-4.4c-0.8-7.6-3-15.4-3.8-24.2-0.4-6.4-0.2-11.8 0.6-16.6z',
  ],
  [null, 'M72 227.4h5.6c2 2.8 3 6.2 2.6 9.8-0.4 1.4-1.2 2-2.6 2h-6.4c-0.6-4-0.4-8 0.8-11.8z'],
];

const HEAD = '<ellipse cx="60" cy="17.5" rx="10.5" ry="12.5" class="k-mm-base"/>';
/** Miroir horizontal autour de x = 60. */
const MIRROR = 'matrix(-1 0 0 1 120 0)';

export interface MuscleMapSvgInput {
  levels: Partial<Record<MuscleRegion, MuscleLevel>>;
  selected?: MuscleRegion | null;
  /** Aperçu (accueil) : sans libellés « Avant / Arrière ». */
  compact?: boolean;
  /** Texte alternatif de l'image. */
  label?: string;
  /**
   * Mode « Récupération » : classe de couleur par zone (k-mm-fresh / k-mm-rec /
   * k-mm-tired), à la place du palier de volume.
   */
  tones?: Partial<Record<MuscleRegion, string>>;
}

function shapes(list: readonly Shape[], input: MuscleMapSvgInput): string {
  return list
    .map(([region, d]) => {
      if (!region) return `<path d="${d}" class="k-mm-base"/>`;
      const tone = input.tones ? (input.tones[region] ?? 'k-mm-fresh') : null;
      const cls = tone ?? `k-mm-l${input.levels[region] ?? 0}`;
      const on = input.selected === region ? ' k-mm-on' : '';
      return `<path d="${d}" class="k-mm ${cls} mm-r-${region}${on}"/>`;
    })
    .join('');
}

function figure(list: readonly Shape[], input: MuscleMapSvgInput, dx: number): string {
  const half = shapes(list, input);
  return `<g transform="translate(${dx} 0)">${HEAD}<g>${half}</g><g transform="${MIRROR}">${half}</g></g>`;
}

/** SVG complet : vue de face à gauche, de dos à droite. */
export function muscleMapSvg(input: MuscleMapSvgInput): string {
  const h = input.compact ? 244 : 258;
  const captions = input.compact
    ? ''
    : '<text x="60" y="255" text-anchor="middle" font-size="9" font-weight="600" letter-spacing="0.6" class="k-mm-caption">AVANT</text>' +
      '<text x="190" y="255" text-anchor="middle" font-size="9" font-weight="600" letter-spacing="0.6" class="k-mm-caption">ARRIÈRE</text>';
  const label = (input.label ?? 'Carte des muscles').replace(/[<>&"]/g, '');
  return (
    `<svg viewBox="0 0 250 ${h}" role="img" aria-label="${label}" class="k-mm-svg">` +
    figure(FRONT, input, 0) +
    figure(BACK, input, 130) +
    captions +
    '</svg>'
  );
}

/** Zone touchée d'après les classes de l'élément visé (`mm-r-<zone>`). */
export function regionFromClass(className: string | null | undefined): MuscleRegion | null {
  const m = /(?:^|\s)mm-r-([a-z_]+)(?:\s|$)/.exec(className ?? '');
  return m ? (m[1] as MuscleRegion) : null;
}

/** Zones dessinées (tests : chaque zone de la carte a au moins une forme). */
export function drawnRegions(): Set<MuscleRegion> {
  const out = new Set<MuscleRegion>();
  for (const [r] of [...FRONT, ...BACK]) if (r) out.add(r);
  return out;
}
