/**
 * Exercise Cues Domain — consignes de forme par exercice (FR).
 *
 * Comble un vrai trou : les exercices n'avaient ni instructions ni démonstration.
 * On fournit des consignes texte concises et sûres (exécution, erreurs courantes,
 * conseils) pour les mouvements les plus loggés. Volontairement sans vidéo (pas de
 * licence) ni promesse médicale — guidage technique général.
 *
 * Clés = ids de `exercises.v1.json`. Les exercices sans consignes renvoient null
 * (l'UI masque alors la section proprement) — extension incrémentale possible.
 *
 * Pur — aucune dépendance, aucun I/O.
 */

export interface ExerciseCues {
  /** Étapes d'exécution, dans l'ordre. */
  execution: string[];
  /** Erreurs fréquentes à éviter. */
  mistakes: string[];
  /** Conseils / points de coaching. */
  tips: string[];
}

const CUES: Readonly<Record<string, ExerciseCues>> = {
  sq: {
    execution: [
      'Barre sur le haut du dos (trapèzes), pieds largeur épaules, pointes légèrement ouvertes.',
      'Inspire, gaine, descends en poussant les hanches en arrière et les genoux vers l’extérieur.',
      'Descends au moins jusqu’à la parallèle (hanches sous les genoux si mobilité).',
      'Remonte en poussant le sol, sans avancer les genoux avant les hanches.',
    ],
    mistakes: [
      'Talons qui décollent',
      'Dos qui s’arrondit en bas',
      'Genoux qui rentrent vers l’intérieur',
    ],
    tips: ['Garde tout le pied au sol', 'Regard neutre, pas vers le plafond'],
  },
  fsq: {
    execution: [
      'Barre sur l’avant des épaules, coudes hauts, prise clavicule.',
      'Buste le plus vertical possible, descends entre les jambes.',
      'Remonte en gardant les coudes hauts pour ne pas basculer en avant.',
    ],
    mistakes: ['Coudes qui tombent', 'Buste qui penche en avant'],
    tips: ['Mobilité poignets/épaules requise — sinon prise croisée'],
  },
  bp: {
    execution: [
      'Allongé, omoplates serrées et basses, léger arch lombaire, pieds ancrés au sol.',
      'Descends la barre vers le bas des pectoraux, coudes ~45-75° du buste.',
      'Touche la poitrine sans rebond, puis pousse en ligne légèrement diagonale.',
    ],
    mistakes: ['Coudes trop écartés (90°)', 'Fesses qui décollent', 'Rebond sur la poitrine'],
    tips: ['Garde les omoplates serrées tout le set', 'Poignets droits au-dessus des coudes'],
  },
  ibp: {
    execution: [
      'Banc incliné 30-45°, mêmes réglages que le développé plat.',
      'Descends vers le haut des pectoraux / clavicule.',
      'Pousse sans laisser les coudes filer trop bas.',
    ],
    mistakes: ['Inclinaison trop forte (devient un OHP)', 'Barre qui descend trop bas sur le cou'],
    tips: ['30-45° cible le haut des pectoraux'],
  },
  cgbp: {
    execution: [
      'Prise largeur épaules (pas plus serré), coudes près du corps.',
      'Descends vers le bas du sternum, avant-bras verticaux.',
      'Pousse en gardant les coudes rentrés (focus triceps).',
    ],
    mistakes: ['Prise trop serrée (stress poignets)', 'Coudes qui s’écartent'],
    tips: ['Excellent accessoire pour le verrouillage du développé couché'],
  },
  dl: {
    execution: [
      'Barre au-dessus du milieu du pied, tibias proches de la barre.',
      'Hanches plus hautes que les genoux, dos plat, gaine fort.',
      'Pousse le sol et tire la barre le long des jambes, hanches et épaules montent ensemble.',
      'Verrouille hanches et genoux en haut sans hyperextension lombaire.',
    ],
    mistakes: ['Dos rond', 'Barre qui s’éloigne des jambes', 'Hanches qui montent trop vite'],
    tips: ['Engage les dorsaux (« protéger les aisselles »)', 'La barre reste collée aux jambes'],
  },
  rdl: {
    execution: [
      'Départ debout, légère flexion des genoux fixe.',
      'Pousse les hanches loin en arrière, barre glissant sur les cuisses.',
      'Descends jusqu’à l’étirement des ischios (dos plat), puis reviens par les hanches.',
    ],
    mistakes: [
      'Plier les genoux comme un squat',
      'Dos qui s’arrondit',
      'Descendre trop bas en perdant le dos',
    ],
    tips: ['Sens l’étirement des ischios, pas du bas du dos'],
  },
  sumo: {
    execution: [
      'Pieds larges, pointes ouvertes, mains à l’intérieur des jambes.',
      'Hanches basses, buste plus vertical que le conventionnel.',
      'Pousse le sol en écartant les genoux, barre collée aux jambes.',
    ],
    mistakes: ['Hanches qui montent avant la barre', 'Genoux qui rentrent'],
    tips: ['Ouvre activement les genoux vers les pointes de pieds'],
  },
  ohp: {
    execution: [
      'Barre sur le haut des pectoraux, prise un peu plus large que les épaules, gaine + fessiers serrés.',
      'Pousse à la verticale en reculant légèrement la tête pour laisser passer la barre.',
      'Verrouille en haut, barre au-dessus du milieu du pied, tête « à travers » la fenêtre des bras.',
    ],
    mistakes: ['Cambrure lombaire excessive', 'Pousser la barre vers l’avant'],
    tips: ['Serre fessiers et abdos pour protéger le bas du dos'],
  },
  pushpress: {
    execution: [
      'Comme l’OHP mais avec une légère flexion des jambes (dip) puis extension explosive.',
      'Utilise l’élan des jambes pour lancer la barre, finis bras tendus.',
    ],
    mistakes: ['Dip trop profond (devient un squat)', 'Buste qui penche en avant pendant le dip'],
    tips: ['Le dip est court et vertical'],
  },
  row: {
    execution: [
      'Buste penché ~45°, dos plat, barre pendue bras tendus.',
      'Tire la barre vers le bas-ventre / nombril en serrant les omoplates.',
      'Contrôle la descente sans relâcher le gainage.',
    ],
    mistakes: [
      'Buste qui se relève à chaque rep (triche)',
      'Tirer vers la poitrine',
      'Dos arrondi',
    ],
    tips: ['Mène le mouvement avec les coudes, pas les mains'],
  },
  pendlay: {
    execution: [
      'Buste quasi parallèle au sol, barre repose au sol entre chaque rep.',
      'Tire explosif vers le bas des pectoraux, repose en contrôle.',
    ],
    mistakes: ['Buste qui se relève', 'Enchaîner sans poser la barre'],
    tips: ['Chaque rep repart du sol, dos plat'],
  },
  hipthrust: {
    execution: [
      'Haut du dos calé sur un banc, barre sur le pli des hanches (avec coussin).',
      'Pieds à plat, tibias verticaux en haut du mouvement.',
      'Pousse les hanches vers le plafond, verrouille fessiers, menton rentré.',
    ],
    mistakes: ['Hyperextension lombaire en haut', 'Talons qui décollent', 'Amplitude trop courte'],
    tips: ['Cherche la contraction des fessiers, pas du bas du dos'],
  },
  lunges: {
    execution: [
      'Grand pas en avant, descends le genou arrière vers le sol.',
      'Genou avant aligné au-dessus de la cheville, buste droit.',
      'Pousse sur le talon avant pour avancer / remonter.',
    ],
    mistakes: ['Genou avant qui dépasse loin la pointe de pied', 'Buste qui penche'],
    tips: ['Pas assez long = stress du genou'],
  },
  bss: {
    execution: [
      'Pied arrière surélevé sur un banc, pied avant assez loin devant.',
      'Descends vertical sur la jambe avant jusqu’à cuisse parallèle.',
      'Pousse sur le talon avant pour remonter.',
    ],
    mistakes: ['Pied avant trop proche (stress genou)', 'Pencher exagérément en avant'],
    tips: ['Léger penché du buste = plus de fessiers'],
  },
  gobsquat: {
    execution: [
      'Haltère/kettlebell tenu contre la poitrine, coudes pointés vers le bas.',
      'Squat profond entre les jambes, buste droit.',
      'Remonte en poussant le sol.',
    ],
    mistakes: ['Buste qui s’effondre', 'Talons qui décollent'],
    tips: ['Idéal pour apprendre le mouvement du squat'],
  },
  dbbp: {
    execution: [
      'Un haltère dans chaque main, omoplates serrées, pieds ancrés.',
      'Descends jusqu’à l’étirement des pectoraux, coudes ~45°.',
      'Pousse en rapprochant légèrement les haltères en haut.',
    ],
    mistakes: ['Descente non contrôlée', 'Coudes trop écartés'],
    tips: ['Amplitude supérieure à la barre — profites-en'],
  },
  db_ohp: {
    execution: [
      'Assis ou debout, haltères au niveau des épaules, paumes vers l’avant.',
      'Pousse à la verticale sans verrouiller brutalement.',
      'Descends en contrôle au niveau des oreilles.',
    ],
    mistakes: ['Cambrer le bas du dos', 'Cogner les haltères en haut'],
    tips: ['Assis avec dossier pour isoler les épaules'],
  },
  arnold: {
    execution: [
      'Départ paumes vers soi devant le visage.',
      'Pousse en tournant les paumes vers l’avant jusqu’en haut.',
      'Inverse la rotation à la descente.',
    ],
    mistakes: ['Rotation trop rapide', 'Charge trop lourde qui casse la technique'],
    tips: ['La rotation recrute davantage le deltoïde antérieur'],
  },
  curl: {
    execution: [
      'Debout, coudes près du corps, haltères en supination.',
      'Fléchis les coudes sans balancer le buste.',
      'Contrôle la descente jusqu’à l’extension complète.',
    ],
    mistakes: ['Balancer le dos pour tricher', 'Coudes qui partent en avant'],
    tips: ['Garde les coudes fixes — seul l’avant-bras bouge'],
  },
  hammercurl: {
    execution: [
      'Prise neutre (paumes face à face), coudes près du corps.',
      'Fléchis sans rotation, contrôle la descente.',
    ],
    mistakes: ['Balancer', 'Amplitude partielle'],
    tips: ['Cible le brachial et l’avant-bras'],
  },
  latraise: {
    execution: [
      'Haltères le long du corps, légère flexion des coudes fixe.',
      'Lève sur les côtés jusqu’à hauteur d’épaules, petits doigts légèrement plus hauts.',
      'Descends en contrôle.',
    ],
    mistakes: ['Charge trop lourde + élan', 'Monter au-dessus des épaules (trapèzes)'],
    tips: ['Léger, propre, sans à-coups — c’est un isolation'],
  },
  rearraise: {
    execution: [
      'Buste penché en avant, haltères pendus.',
      'Écarte les bras sur les côtés en serrant les omoplates.',
      'Contrôle la descente.',
    ],
    mistakes: ['Tirer vers le haut (devient un rowing)', 'Buste qui se relève'],
    tips: ['Cible le deltoïde postérieur — reste léger'],
  },
  lat: {
    execution: [
      'Prise un peu plus large que les épaules, buste légèrement incliné en arrière.',
      'Tire la barre vers le haut des pectoraux en abaissant les omoplates.',
      'Contrôle la remontée jusqu’à l’étirement complet des dorsaux.',
    ],
    mistakes: ['Tirer derrière la nuque', 'Se balancer en arrière pour tricher'],
    tips: ['Initie le mouvement en abaissant les épaules'],
  },
  cableRow: {
    execution: [
      'Buste droit, légère flexion des genoux, dos plat.',
      'Tire la poignée vers le nombril en serrant les omoplates.',
      'Reviens en contrôle sans arrondir le dos.',
    ],
    mistakes: ['Balancer le buste d’avant en arrière', 'Arrondir le dos à l’étirement'],
    tips: ['Poitrine sortie, épaules basses'],
  },
  facepull: {
    execution: [
      'Corde réglée à hauteur du visage, prise neutre.',
      'Tire vers le front en écartant les mains, coudes hauts.',
      'Serre les omoplates et les deltoïdes postérieurs.',
    ],
    mistakes: ['Charge trop lourde', 'Coudes qui tombent'],
    tips: ['Excellent pour la santé des épaules — léger et propre'],
  },
  legpress: {
    execution: [
      'Pieds largeur épaules sur la plateforme, dos et fesses plaqués.',
      'Descends jusqu’à ~90° aux genoux en contrôle.',
      'Pousse sans verrouiller brutalement les genoux.',
    ],
    mistakes: ['Fesses qui décollent en bas (dos rond)', 'Verrouiller sec les genoux'],
    tips: ['Ne descends pas plus bas que le contrôle du bas du dos'],
  },
  legcurl: {
    execution: [
      'Réglage cheville sous le coussin, hanches plaquées.',
      'Fléchis les genoux en contractant les ischios.',
      'Contrôle la descente complète.',
    ],
    mistakes: ['Décoller les hanches', 'Mouvement saccadé'],
    tips: ['Contraction marquée en fin de flexion'],
  },
  legext: {
    execution: [
      'Dos calé, cheville derrière le coussin.',
      'Étends les genoux jusqu’à la contraction des quadriceps.',
      'Descends en contrôle.',
    ],
    mistakes: ['À-coups', 'Charge qui claque en bas'],
    tips: ['Pause courte en haut pour la contraction'],
  },
  calfraise: {
    execution: [
      'Avant-pieds sur un support, talons libres.',
      'Monte sur la pointe en contractant les mollets.',
      'Descends en étirement complet sous le niveau du support.',
    ],
    mistakes: ['Amplitude partielle', 'Rebondir'],
    tips: ['Marque une pause en haut ET en bas'],
  },
  skull: {
    execution: [
      'Allongé, barre/haltères au-dessus du front, coudes pointés vers le haut.',
      'Fléchis les coudes pour descendre vers le front sans bouger les épaules.',
      'Étends les coudes en gardant les bras fixes.',
    ],
    mistakes: ['Coudes qui s’écartent', 'Bouger les épaules (devient un pull-over)'],
    tips: ['Garde les coudes pointés vers le plafond'],
  },
};

/** Renvoie les consignes d'un exercice, ou null s'il n'en a pas. */
export function getExerciseCues(exerciseId: string): ExerciseCues | null {
  return CUES[exerciseId] ?? null;
}

/** L'exercice a-t-il des consignes ? */
export function hasExerciseCues(exerciseId: string): boolean {
  return exerciseId in CUES;
}

/** Liste des ids d'exercices documentés (pour stats / couverture). */
export function cuedExerciseIds(): string[] {
  return Object.keys(CUES);
}
