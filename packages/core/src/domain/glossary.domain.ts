/**
 * Glossary — définitions des termes techniques de la musculation utilisés
 * dans Kinetic. Données pures, réutilisées par la page /glossaire ET les
 * tooltips ⓘ inline.
 *
 * Chaque terme a :
 *   - `short` : une phrase, pour le tooltip (≤ 120 car idéalement)
 *   - `long`  : explication complète pour la page glossaire
 *   - `formula?` : formule si pertinent (e1RM, Wilks...)
 *   - `example?` : exemple concret pour ancrer
 *
 * Pur — aucune dépendance, aucun I/O.
 */

export interface GlossaryTerm {
  /** Clé stable utilisée par les tooltips : t('rpe'). */
  id: string;
  /** Terme affiché (peut différer de l'id). */
  term: string;
  /** Catégorie pour regrouper dans la page glossaire. */
  category: 'intensité' | 'volume' | 'progression' | 'force' | 'technique' | 'général';
  short: string;
  long: string;
  formula?: string;
  example?: string;
}

export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    id: 'rpe',
    term: 'RPE',
    category: 'intensité',
    short: "Difficulté ressentie d'une série, de 6 à 10. RPE 8 = il te restait 2 reps en réserve.",
    long: "RPE (Rate of Perceived Exertion = effort perçu) mesure la difficulté d'une série sur une échelle de 6 à 10. C'est une façon d'auto-réguler ton entraînement selon ta forme du jour, plutôt que de suivre un pourcentage figé. RPE 10 = échec total, aucune rep en réserve. RPE 8 = il te restait environ 2 répétitions. La plupart des séries productives se font entre RPE 7 et 9.",
    example: 'Tu fais 100 kg × 8 et tu sens que tu aurais pu en faire 2 de plus → RPE 8.',
  },
  {
    id: 'rir',
    term: 'RIR',
    category: 'intensité',
    short: 'Reps In Reserve : nombre de répétitions que tu aurais encore pu faire.',
    long: "RIR (Reps In Reserve = répétitions en réserve) est l'inverse direct du RPE. RIR 2 = RPE 8, RIR 0 = RPE 10. Certains préfèrent compter en RIR car c'est plus intuitif : « combien j'aurais pu en faire de plus ? ».",
  },
  {
    id: 'e1rm',
    term: 'e1RM',
    category: 'force',
    short: 'Ton 1RM estimé : la charge max théorique sur 1 répétition, calculée depuis une série.',
    long: "e1RM (estimated 1 Rep Max = 1RM estimé) prédit la charge maximale que tu pourrais soulever une seule fois, à partir d'une série de plusieurs répétitions. Ça évite d'avoir à tester un vrai max (risqué et fatigant). Kinetic utilise la formule d'Epley.",
    formula: 'e1RM = poids × (1 + reps / 30). Ex : 100 kg × 8 → 100 × (1 + 8/30) ≈ 127 kg.',
    example: "100 kg × 5 reps donne un e1RM d'environ 117 kg.",
  },
  {
    id: '1rm',
    term: '1RM',
    category: 'force',
    short: 'La charge maximale que tu peux soulever pour une seule répétition.',
    long: "1RM (One Rep Max = maximum sur 1 répétition) est la charge la plus lourde que tu peux soulever une fois avec une technique correcte. C'est la référence pour mesurer la force pure. On l'estime souvent (e1RM) plutôt que de le tester directement.",
  },
  {
    id: 'amrap',
    term: 'AMRAP',
    category: 'volume',
    short: 'As Many Reps As Possible : fais le maximum de répétitions sur cette série.',
    long: "AMRAP (As Many Reps As Possible = autant de reps que possible) signifie que sur cette série, tu pousses jusqu'à ne plus pouvoir (ou presque). Souvent utilisé sur le dernier set d'un exercice dans des programmes comme le 5/3/1, pour mesurer ta progression réelle.",
    example: '« 85 % × 5+ » veut dire : au moins 5 reps, mais fais-en le plus possible.',
  },
  {
    id: 'tonnage',
    term: 'Tonnage',
    category: 'volume',
    short: 'Le poids total soulevé sur une séance : somme de (poids × reps) de tous les sets.',
    long: "Le tonnage (ou volume-charge) est la quantité totale de poids déplacé. On l'obtient en additionnant poids × répétitions pour chaque série. C'est un bon indicateur du volume d'entraînement et de la charge globale imposée au corps.",
    formula: 'Tonnage = Σ (poids × reps). Ex : 3 séries de 100 kg × 5 = 1500 kg.',
  },
  {
    id: 'volume',
    term: 'Volume',
    category: 'volume',
    short: 'Quantité de travail : souvent le nombre de séries dures par muscle et par semaine.',
    long: "Le volume désigne la quantité totale de travail. Selon le contexte, on le mesure en séries hebdomadaires par groupe musculaire (10-20 séries/semaine est une zone classique pour l'hypertrophie) ou en tonnage. Plus de volume = plus de stimulus, jusqu'à un point où la récupération ne suit plus.",
  },
  {
    id: 'deload',
    term: 'Deload',
    category: 'progression',
    short:
      'Semaine allégée (charges et volume réduits) pour récupérer et éviter le surentraînement.',
    long: "Un deload est une période (souvent 1 semaine) où tu réduis volontairement l'intensité et/ou le volume — typiquement à 60 % du volume et −10 % de charge. L'objectif est de dissiper la fatigue accumulée pour revenir plus fort. Kinetic le suggère quand ton RPE reste très élevé sans progression d'e1RM.",
  },
  {
    id: 'surcharge-progressive',
    term: 'Surcharge progressive',
    category: 'progression',
    short:
      'Augmenter graduellement la difficulté (poids, reps, séries) pour continuer à progresser.',
    long: "La surcharge progressive est le principe fondamental de la musculation : pour progresser, il faut augmenter régulièrement la demande imposée aux muscles — en ajoutant du poids, des répétitions, des séries, ou en améliorant la technique. Sans surcharge, le corps n'a aucune raison de s'adapter.",
  },
  {
    id: 'double-progression',
    term: 'Double progression',
    category: 'progression',
    short: "D'abord augmenter les reps jusqu'à un plafond, ensuite augmenter le poids.",
    long: "La double progression est une méthode simple : tu gardes la même charge jusqu'à atteindre le haut d'une fourchette de reps (ex : 8 à 12), puis tu augmentes le poids et tu recommences en bas de la fourchette. Ça évite d'augmenter le poids trop tôt.",
  },
  {
    id: 'hypertrophie',
    term: 'Hypertrophie',
    category: 'général',
    short: 'La prise de masse musculaire (augmentation de la taille des muscles).',
    long: "L'hypertrophie est l'augmentation du volume des fibres musculaires, c'est-à-dire la prise de muscle. Elle est favorisée par un volume suffisant (souvent 6-12 reps, RPE 7-9), une surcharge progressive et une nutrition adaptée.",
  },
  {
    id: 'tm',
    term: 'Training Max (TM)',
    category: 'progression',
    short: 'Un 1RM « de travail » volontairement sous-estimé (souvent 90 % du vrai 1RM).',
    long: "Le Training Max (TM) est une base de calcul utilisée par des programmes comme le 5/3/1. Au lieu d'utiliser ton vrai 1RM, on prend 90 % pour avoir une marge de sécurité, garantir une bonne technique et permettre une progression durable sur plusieurs cycles.",
  },
  {
    id: 'sbd',
    term: 'SBD',
    category: 'force',
    short: 'Squat, Bench, Deadlift — les trois mouvements de la force athlétique (powerlifting).',
    long: "SBD est l'acronyme de Squat (squat), Bench (développé couché) et Deadlift (soulevé de terre) — les trois mouvements jugés en powerlifting. Le « total SBD » est la somme des meilleurs lifts sur ces trois mouvements, utilisée pour calculer les scores de force normalisés.",
  },
  {
    id: 'wilks',
    term: 'Wilks',
    category: 'force',
    short:
      'Score qui normalise ta force par rapport à ton poids de corps, pour comparer entre athlètes.',
    long: "Le coefficient Wilks permet de comparer la force d'athlètes de poids différents. Il ajuste ton total SBD selon ton poids corporel, via un polynôme. Plus le score est haut, plus tu es fort relativement à ton poids. Historiquement la référence à l'IPF, désormais complété par l'IPF GL.",
  },
  {
    id: 'ipf-gl',
    term: 'IPF GL Points',
    category: 'force',
    short: "Score officiel actuel de l'IPF pour comparer la force entre catégories de poids.",
    long: 'Les IPF GL Points (Goodlift) sont le système officiel de la Fédération Internationale de Powerlifting depuis 2020, remplaçant le Wilks. Ils normalisent le total selon le poids de corps avec une formule exponentielle calibrée sur les performances mondiales.',
  },
  {
    id: 'dots',
    term: 'DOTS',
    category: 'force',
    short: 'Alternative open-source au Wilks pour comparer la force relative au poids de corps.',
    long: "DOTS est un système de scoring de force développé en 2019, populaire car open-source et simple à calculer. Comme le Wilks et l'IPF GL, il normalise ton total selon ton poids pour permettre des comparaisons équitables entre gabarits.",
  },
  {
    id: 'tempo',
    term: 'Tempo',
    category: 'technique',
    short:
      "La cadence d'exécution, notée en 4 chiffres : excentrique-pause bas-concentrique-pause haut.",
    long: "Le tempo contrôle la vitesse de chaque phase d'une répétition, noté par 4 nombres (en secondes) : descente (excentrique), pause en bas, montée (concentrique), pause en haut. « 3-1-1-0 » = 3 s pour descendre, 1 s de pause, 1 s pour monter, pas de pause. Un tempo lent augmente le temps sous tension.",
    example: 'Tempo 4-0-1-0 sur le squat = 4 secondes de descente contrôlée.',
  },
  {
    id: 'tut',
    term: 'Temps sous tension (TUT)',
    category: 'technique',
    short: 'Durée totale où le muscle travaille pendant une série.',
    long: "Le TUT (Time Under Tension) est le temps cumulé pendant lequel le muscle est sous charge sur une série. Il dépend du nombre de reps et du tempo. Une zone de 30-60 s par série est souvent citée pour l'hypertrophie, mais ce n'est pas une règle absolue.",
  },
  {
    id: 'emom',
    term: 'EMOM',
    category: 'volume',
    short:
      'Every Minute On the Minute : une série au début de chaque minute, repos sur le temps restant.',
    long: 'EMOM (Every Minute On the Minute = chaque minute pile) est un format où tu démarres une nouvelle série au début de chaque minute : plus tu finis vite, plus tu te reposes longtemps. Utile pour accumuler du volume de qualité sous contrainte de temps.',
  },
  {
    id: 'pr',
    term: 'PR / Record',
    category: 'force',
    short: 'Personal Record : ta meilleure performance sur un exercice (charge, reps ou e1RM).',
    long: "Un PR (Personal Record = record personnel) est ta meilleure performance sur un exercice donné. Ça peut être une charge max, un nombre de reps à un poids donné, ou un e1RM record. Battre un PR est le signe concret d'une progression.",
  },
  {
    id: 'compound',
    term: 'Polyarticulaire',
    category: 'technique',
    short:
      'Exercice qui mobilise plusieurs articulations et groupes musculaires (squat, développé...).',
    long: "Un exercice polyarticulaire (compound) sollicite plusieurs articulations et muscles simultanément (squat, soulevé de terre, développé couché, tractions). Ils permettent de soulever lourd et de progresser efficacement, contrairement aux exercices d'isolation qui ciblent un seul muscle.",
  },
];

/** Recherche un terme par id. */
export function getGlossaryTerm(id: string): GlossaryTerm | null {
  return GLOSSARY.find((t) => t.id === id) ?? null;
}

/** Recherche texte simple (id, terme, short) — insensible à la casse/accents. */
export function searchGlossary(query: string): GlossaryTerm[] {
  const q = normalize(query);
  if (!q) return [...GLOSSARY];
  return GLOSSARY.filter(
    (t) =>
      normalize(t.term).includes(q) ||
      normalize(t.id).includes(q) ||
      normalize(t.short).includes(q) ||
      normalize(t.long).includes(q),
  );
}

/** Liste les catégories présentes, dans un ordre lisible. */
export function glossaryCategories(): GlossaryTerm['category'][] {
  const order: GlossaryTerm['category'][] = [
    'intensité',
    'volume',
    'progression',
    'force',
    'technique',
    'général',
  ];
  const present = new Set(GLOSSARY.map((t) => t.category));
  return order.filter((c) => present.has(c));
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // retire les accents (combining diacritics)
    .trim();
}
