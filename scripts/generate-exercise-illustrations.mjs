#!/usr/bin/env node
/**
 * Génère les schémas d'exercices (apps/web/public/exercises/*.svg).
 *
 *   node scripts/generate-exercise-illustrations.mjs
 *
 * Un seul style pour tous : silhouette stylisée en traits épais arrondis, vue
 * de profil (ou de face pour les élévations latérales), matériel en gris plus
 * sombre, muscle principal en accent (« ventre » du muscle sur le segment).
 * Les couleurs sont portées par des classes (b : corps, f : membres éloignés,
 * g : matériel, gr : cerclage des disques, p : disques, m : muscle, s : sol) ; les attributs de couleur
 * ne servent que si le SVG est ouvert seul. Dans l'app, le SVG est inséré
 * dans la page (x-svg) et apps/web/src/lib/exercise-illustrations.css (.k-ill)
 * applique la palette du thème.
 *
 * Les poses sont décrites par des angles absolus (degrés) : 0 = vers le bas,
 * 90 = vers l'avant (+x), 180 = vers le haut, -90 = vers l'arrière.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/public/exercises');

// ─── Proportions et épaisseurs ──────────────────────────────────────────────
const L = { torso: 36, neck: 12, ua: 22, fa: 20, th: 28, sh: 27, foot: 9 };
const W = { torso: 15.5, ua: 8.4, fa: 7, th: 10.5, sh: 8, foot: 6 };
const HEAD_R = 8;
const FLOOR = 146;

const COLORS = {
  b: '#9AA3BD',
  f: '#9AA3BD',
  g: '#69728C',
  p: '#4E5670',
  m: '#FF7A66',
  s: '#69728C',
};

const r2 = (n) => Math.round(n * 10) / 10;
const rad = (deg) => (deg * Math.PI) / 180;
const dir = (deg) => [Math.sin(rad(deg)), Math.cos(rad(deg))];
const add = (p, deg, len) => {
  const [dx, dy] = dir(deg);
  return [p[0] + dx * len, p[1] + dy * len];
};

/**
 * Pose → articulations. `hip` : position de la hanche. Angles : torso (hanche →
 * épaules), head (défaut : torse), ua/fa (bras proche), ua2/fa2 (bras éloigné),
 * th/sh/ft (jambe proche), th2/sh2/ft2 (jambe éloignée).
 */
function joints(pose) {
  const j = rawJoints(pose);
  if (pose.ground === false) return j;
  // Pieds au sol : décale la silhouette pour que le point le plus bas touche le sol.
  const low = Math.max(j.leg.A[1], j.leg.T[1], j.leg2.A[1], j.leg2.T[1]) + W.foot / 2;
  return rawJoints({ ...pose, hip: [pose.hip[0], pose.hip[1] + FLOOR - low] });
}

function rawJoints(pose) {
  const P = pose.hip;
  const S = add(P, pose.torso, L.torso);
  const Hd = add(S, pose.head ?? pose.torso, L.neck);
  const arm = (ua, fa) => {
    const E = add(S, ua, L.ua);
    return { E, H: add(E, fa, L.fa) };
  };
  const leg = (th, sh, ft) => {
    const K = add(P, th, L.th);
    const A = add(K, sh, L.sh);
    return { K, A, T: add(A, ft ?? 90, L.foot) };
  };
  return {
    P,
    S,
    Hd,
    arm: arm(pose.ua, pose.fa),
    arm2: arm(pose.ua2 ?? pose.ua, pose.fa2 ?? pose.fa),
    leg: leg(pose.th, pose.sh, pose.ft),
    leg2: leg(pose.th2 ?? pose.th, pose.sh2 ?? pose.sh, pose.ft2 ?? pose.ft),
  };
}

const line = (a, b, w, cls) =>
  `<path class="${cls}" d="M${r2(a[0])} ${r2(a[1])}L${r2(b[0])} ${r2(b[1])}" stroke="${COLORS[cls]}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;
const poly = (pts, w, cls) =>
  `<path class="${cls}" d="M${pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}" stroke="${COLORS[cls]}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
const circle = (c, r, cls) =>
  `<circle class="${cls}" cx="${r2(c[0])}" cy="${r2(c[1])}" r="${r}" fill="${COLORS[cls]}"/>`;
const rect = (x, y, w, h, rx, cls) =>
  `<rect class="${cls}" x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${rx}" fill="${COLORS[cls]}"/>`;

/** « Ventre » du muscle : ellipse d'accent sur le segment a→b, décalée d'un côté. */
function belly(a, b, width, side = 0, t = 0.5, scale = 1) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const off = side * width * 0.2;
  const cx = a[0] + dx * t + nx * off;
  const cy = a[1] + dy * t + ny * off;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const rx = len * 0.34 * scale;
  const ry = width * 0.36 * scale;
  return `<ellipse class="m" cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(rx)}" ry="${r2(ry)}" transform="rotate(${r2(ang)} ${r2(cx)} ${r2(cy)})" fill="${COLORS.m}"/>`;
}

/** Corps complet + muscles. `hi` : liste de [segment, côté, t?, échelle?]. */
function figure(pose, hi = [], opts = {}) {
  const j = joints(pose);
  const far = [];
  if (!opts.noFarArm) {
    far.push(poly([j.S, j.arm2.E, j.arm2.H], W.ua, 'f'));
  }
  if (!opts.noFarLeg) {
    far.push(poly([j.P, j.leg2.K, j.leg2.A], W.th - 1, 'f'));
    far.push(line(j.leg2.A, j.leg2.T, W.foot, 'f'));
  }
  const body = [
    line(j.P, j.S, W.torso, 'b'),
    line(j.P, j.leg.K, W.th, 'b'),
    line(j.leg.K, j.leg.A, W.sh, 'b'),
    line(j.leg.A, j.leg.T, W.foot, 'b'),
  ];
  const arm = [line(j.S, j.arm.E, W.ua, 'b'), line(j.arm.E, j.arm.H, W.fa, 'b')];
  const seg = {
    torso: [j.P, j.S, W.torso],
    chest: [j.P, j.S, W.torso],
    th: [j.P, j.leg.K, W.th],
    sh: [j.leg.K, j.leg.A, W.sh],
    ua: [j.S, j.arm.E, W.ua],
    fa: [j.arm.E, j.arm.H, W.fa],
    th2: [j.P, j.leg2.K, W.th],
  };
  const muscles = hi.map(([name, side, t, scale]) => {
    if (name === 'delt') return circle(j.S, 5.6, 'm');
    if (name === 'delt2') return circle(add(j.S, pose.ua2 ?? pose.ua, 2), 5.2, 'm');
    if (name === 'glute')
      return circle(add(j.P, (pose.torso ?? 180) - 180 - 70 * (side || 1), 3), 6.4, 'm');
    const [a, b, w] = seg[name];
    return belly(a, b, w, side, t, scale);
  });
  return {
    j,
    far: `<g opacity="0.45">${far.join('')}</g>`,
    body: body.join(''),
    head: circle(j.Hd, HEAD_R, 'b'),
    arm: arm.join(''),
    muscles: muscles.join(''),
  };
}

// ─── Matériel ───────────────────────────────────────────────────────────────
/** Barre vue de profil (disque de face) centrée en c. */
const plateSide = (c, r = 15) =>
  `${circle(c, r, 'p')}<circle class="gr" cx="${r2(c[0])}" cy="${r2(c[1])}" r="${r - 3}" fill="none" stroke="${COLORS.g}" stroke-width="2"/>${circle(c, 3, 'g')}`;
/** Haltère vu de profil, centré sur la main. */
const dumbbell = (c, ang = 0) => {
  const [dx, dy] = dir(ang + 90);
  const a = [c[0] - dx * 8, c[1] - dy * 8];
  const b = [c[0] + dx * 8, c[1] + dy * 8];
  return `${line(a, b, 3.4, 'g')}${line([a[0] - dx * 1.5, a[1] - dy * 1.5], [a[0] + dx * 2.5, a[1] + dy * 2.5], 9, 'p')}${line([b[0] - dx * 2.5, b[1] - dy * 2.5], [b[0] + dx * 1.5, b[1] + dy * 1.5], 9, 'p')}`;
};
/** Haltère vu de bout (disque rond). */
const dumbbellEnd = (c) => `${circle(c, 7.5, 'p')}${circle(c, 3, 'g')}`;
const floor = (x1 = 14, x2 = 146) => line([x1, FLOOR + 2], [x2, FLOOR + 2], 2.5, 's');
/** Banc plat : plateau à la hauteur y, de x1 à x2. */
const bench = (x1, x2, y) =>
  `${rect(x1, y, x2 - x1, 7, 3.5, 'g')}${line([x1 + 8, y + 6], [x1 + 8, FLOOR], 4, 'g')}${line([x2 - 8, y + 6], [x2 - 8, FLOOR], 4, 'g')}`;

// ─── Assemblage ─────────────────────────────────────────────────────────────
function svg(title, parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" role="img" aria-label="${title}"><title>${title}</title>${parts.join('')}</svg>\n`;
}

/**
 * Ordre de dessin : sol, matériel arrière, membres éloignés, corps, bras,
 * muscles, matériel avant (la tête passe devant la barre si `headOnTop`).
 */
function scene(title, pose, hi, { back = '', front = '', opts = {}, headOnTop = false } = {}) {
  const f = figure(pose, hi, opts);
  const b = typeof back === 'function' ? back(f.j) : back;
  const fr = typeof front === 'function' ? front(f.j) : front;
  return svg(title, [
    floor(),
    b,
    f.far,
    f.body,
    headOnTop ? '' : f.head,
    opts.noArm ? '' : f.arm,
    f.muscles,
    fr,
    headOnTop ? f.head : '',
  ]);
}

const EX = {};

// ─── Jambes ─────────────────────────────────────────────────────────────────
// Squat (barre sur le dos), position basse.
EX['squat'] = () =>
  scene(
    'Squat',
    { hip: [62, 100], torso: 150, head: 166, ua: -70, fa: 40, th: 78, sh: -20 },
    [
      ['th', -1, 0.55],
      ['glute', 1],
    ],
    { front: (j) => plateSide(add(j.S, -120, 3), 13), headOnTop: true },
  );

EX['front-squat'] = () =>
  scene(
    'Squat avant',
    { hip: [60, 100], torso: 166, head: 172, ua: 108, fa: -100, th: 80, sh: -18 },
    [
      ['th', -1, 0.55],
      ['glute', 1],
    ],
    { front: (j) => plateSide(add(j.S, 100, 6), 13), headOnTop: true },
  );

EX['goblet-squat'] = () =>
  scene(
    'Squat gobelet',
    { hip: [60, 100], torso: 162, head: 170, ua: 40, fa: 172, th: 80, sh: -18 },
    [
      ['th', -1, 0.55],
      ['glute', 1],
    ],
    {
      front: (j) =>
        `${line(add(j.arm.H, 0, -4), add(j.arm.H, 0, 8), 5, 'g')}${rect(j.arm.H[0] - 7, j.arm.H[1] + 5, 14, 10, 4, 'p')}`,
    },
  );

EX['lunge'] = () =>
  scene(
    'Fentes',
    {
      hip: [74, 100],
      torso: 180,
      head: 178,
      ua: 6,
      fa: 0,
      th: 84,
      sh: 2,
      th2: -18,
      sh2: -92,
      ft2: 25,
    },
    [
      ['th', -1, 0.55],
      ['glute', 1],
    ],
    { front: (j) => dumbbellEnd(add(j.arm.H, 0, 3)) },
  );

EX['bulgarian-split-squat'] = () =>
  scene(
    'Squat bulgare',
    {
      hip: [86, 98],
      torso: 174,
      head: 174,
      ua: 6,
      fa: 0,
      th: 84,
      sh: 6,
      th2: -28,
      sh2: -112,
      ft2: -160,
    },
    [
      ['th', -1, 0.55],
      ['glute', 1],
    ],
    { back: bench(16, 50, 108), front: (j) => dumbbellEnd(add(j.arm.H, 0, 3)) },
  );

EX['leg-press'] = () =>
  scene(
    'Presse à cuisses',
    {
      hip: [48, 118],
      torso: -132,
      head: -140,
      ua: 70,
      fa: 110,
      th: 165,
      sh: 120,
      ft: -140,
      ground: false,
    },
    [
      ['th', -1, 0.55],
      ['glute', 1],
    ],
    {
      back: (j) => {
        const c = add(j.leg.A, 135, 4);
        const rail = add(c, 45, 16);
        return `${line([12, 84], [56, 128], 7, 'g')}${line([38, 128], [68, 128], 7, 'g')}${line([54, 130], [54, FLOOR], 4, 'g')}${line(add(rail, 135, 26), add(rail, 135, -42), 4.5, 'g')}${line(add(c, 45, 20), add(c, 45, -22), 6, 'g')}`;
      },
    },
  );

EX['leg-curl'] = () =>
  scene(
    'Leg curl',
    {
      hip: [80, 98],
      torso: -92,
      head: -96,
      ua: -30,
      fa: 4,
      th: 92,
      sh: 165,
      ft: 75,
      ground: false,
    },
    [['th', -1, 0.55]],
    {
      back: (j) =>
        `${rect(18, 104, 100, 7, 3.5, 'g')}${line([28, 110], [28, FLOOR], 4, 'g')}${line([106, 110], [106, FLOOR], 4, 'g')}${circle(add(j.leg.A, 100, 4), 6, 'p')}`,
      opts: { noFarArm: true, noArm: true },
    },
  );

EX['leg-extension'] = () =>
  scene(
    'Leg extension',
    {
      hip: [62, 104],
      torso: 172,
      head: 172,
      ua: 14,
      fa: 50,
      th: 88,
      sh: 80,
      ft: 170,
      ground: false,
    },
    [['th', -1, 0.55]],
    {
      back: (j) =>
        `${rect(40, 108, 40, 7, 3.5, 'g')}${line([46, 106], [40, 62], 6, 'g')}${line([62, 114], [62, FLOOR], 4, 'g')}${circle(add(j.leg.A, 0, 5), 6, 'p')}`,
    },
  );

EX['calf-raise'] = () =>
  scene(
    'Mollets debout',
    { hip: [72, 73], torso: 180, head: 178, ua: 4, fa: 0, th: 0, sh: 0, ft: 50, ground: false },
    [['sh', 1, 0.4, 1.1]],
    { back: rect(60, 137, 34, 9, 2, 'g') },
  );

EX['hip-thrust'] = () =>
  scene(
    'Hip thrust',
    { hip: [84, 94], torso: -90, head: -100, ua: 80, fa: 96, th: 98, sh: 4, ground: false },
    [
      ['glute', -1],
      ['th', 1, 0.45, 0.8],
    ],
    {
      back: bench(14, 52, 100),
      front: (j) => plateSide(add(j.P, 180, 12), 14),
    },
  );

// ─── Poussée ────────────────────────────────────────────────────────────────
EX['bench-press'] = () =>
  scene(
    'Développé couché',
    { hip: [98, 100], torso: -90, head: -96, ua: 180, fa: 180, th: 80, sh: 18, ground: false },
    [['chest', 1, 0.75, 0.9]],
    { back: bench(40, 114, 104), front: (j) => plateSide(j.arm.H, 14) },
  );

EX['incline-press'] = () =>
  scene(
    'Développé incliné',
    { hip: [92, 106], torso: -128, head: -132, ua: 160, fa: 170, th: 92, sh: 8, ground: false },
    [['chest', 1, 0.75, 0.9]],
    {
      back: `${line([96, 112], [58, 66], 7, 'g')}${rect(80, 110, 30, 7, 3.5, 'g')}${line([92, 116], [92, FLOOR], 4, 'g')}${line([64, 80], [64, FLOOR], 4, 'g')}`,
      front: (j) => plateSide(j.arm.H, 14),
    },
  );

EX['dumbbell-bench'] = () =>
  scene(
    'Développé couché haltères',
    { hip: [98, 100], torso: -90, head: -96, ua: 180, fa: 180, th: 80, sh: 18, ground: false },
    [['chest', 1, 0.75, 0.9]],
    { back: bench(40, 114, 104), front: (j) => dumbbell(j.arm.H, 0) },
  );

EX['overhead-press'] = () =>
  scene(
    'Développé militaire',
    { hip: [76, 90], torso: 182, head: 176, ua: 172, fa: 180, th: 1, sh: -1 },
    [
      ['delt', 0],
      ['ua', -1, 0.5],
    ],
    { front: (j) => plateSide(j.arm.H, 11) },
  );

EX['dumbbell-press'] = () =>
  scene(
    'Développé haltères assis',
    { hip: [72, 108], torso: 182, head: 178, ua: 172, fa: 180, th: 90, sh: 2, ground: false },
    [
      ['delt', 0],
      ['ua', -1, 0.5],
    ],
    {
      back: `${rect(48, 112, 36, 7, 3.5, 'g')}${line([52, 118], [52, FLOOR], 4, 'g')}${line([78, 118], [78, FLOOR], 4, 'g')}${line([62, 112], [58, 64], 6, 'g')}`,
      front: (j) => dumbbell(j.arm.H, 0),
    },
  );

EX['dips'] = () =>
  scene(
    'Dips',
    {
      hip: [70, 74],
      torso: 160,
      head: 166,
      ua: -54,
      fa: 6,
      th: -2,
      sh: -44,
      ft: 20,
      th2: 6,
      sh2: -36,
      ground: false,
    },
    [['ua', -1, 0.5, 1.05]],
    {
      back: (j) => {
        const h = j.arm.H;
        const y = h[1] + 3;
        return `${line([h[0] - 14, y], [h[0] + 26, y], 4.5, 'g')}${line([h[0] + 24, y], [h[0] + 24, FLOOR], 4, 'g')}`;
      },
    },
  );

EX['push-up'] = () =>
  scene(
    'Pompes',
    { hip: [80, 112], torso: -104, head: -108, ua: 0, fa: 0, th: 76, sh: 76, ft: 0, ground: false },
    [
      ['chest', 1, 0.78, 0.9],
      ['ua', 1, 0.5],
    ],
    {},
  );

EX['lateral-raise'] = () => {
  const cx = 80;
  const sY = 54;
  const hip = [cx, 89];
  const shL = [cx - 12, sY];
  const shR = [cx + 12, sY];
  return svg('Élévations latérales', [
    floor(),
    line([cx, hip[1]], [cx, sY + 2], 21, 'b'),
    line(shL, shR, 11, 'b'),
    circle([cx, sY - 14], HEAD_R, 'b'),
    poly(
      [
        [cx - 6, hip[1]],
        [cx - 7, 116],
        [cx - 7, 143],
      ],
      9.5,
      'b',
    ),
    poly(
      [
        [cx + 6, hip[1]],
        [cx + 7, 116],
        [cx + 7, 143],
      ],
      9.5,
      'b',
    ),
    line([cx - 7, 144], [cx - 14, 144], W.foot, 'b'),
    line([cx + 7, 144], [cx + 14, 144], W.foot, 'b'),
    poly([shL, [cx - 34, sY + 3], [cx - 53, sY + 5]], W.ua, 'b'),
    poly([shR, [cx + 34, sY + 3], [cx + 53, sY + 5]], W.ua, 'b'),
    circle(shL, 6, 'm'),
    circle(shR, 6, 'm'),
    dumbbell([cx - 55, sY + 5], 0),
    dumbbell([cx + 55, sY + 5], 0),
  ]);
};

// ─── Tirage ─────────────────────────────────────────────────────────────────
EX['deadlift'] = () =>
  scene(
    'Soulevé de terre',
    { hip: [58, 92], torso: 120, head: 112, ua: 2, fa: 0, th: 56, sh: -10 },
    [
      ['torso', -1, 0.35],
      ['th', 1, 0.55],
    ],
    { front: (j) => plateSide([j.arm.H[0] + 1, FLOOR - 14], 14) },
  );

EX['romanian-deadlift'] = () =>
  scene(
    'Soulevé de terre jambes tendues',
    { hip: [60, 80], torso: 110, head: 102, ua: 2, fa: 0, th: 12, sh: -6 },
    [
      ['th', 1, 0.5],
      ['glute', 1],
    ],
    { front: (j) => plateSide([j.arm.H[0], j.arm.H[1] + 3], 13) },
  );

EX['pull-up'] = () =>
  scene(
    'Tractions',
    {
      hip: [78, 98],
      torso: 184,
      head: 176,
      ua: 140,
      fa: 196,
      th: 14,
      sh: -26,
      ft: 70,
      ground: false,
    },
    [
      ['torso', -1, 0.55, 1],
      ['ua', 1, 0.5],
    ],
    {
      back: `${line([40, 34], [128, 34], 4, 'g')}${line([44, 34], [44, 12], 4, 'g')}${line([124, 34], [124, 12], 4, 'g')}`,
    },
  );

EX['lat-pulldown'] = () =>
  scene(
    'Tirage vertical',
    { hip: [70, 108], torso: 190, head: 184, ua: 150, fa: 196, th: 88, sh: 2, ground: false },
    [
      ['torso', -1, 0.55, 1],
      ['ua', 1, 0.5],
    ],
    {
      back: (j) => {
        const h = j.arm.H;
        return `${line([118, 14], [118, FLOOR], 5, 'g')}${line([118, 18], [h[0], 18], 4, 'g')}${circle([h[0], 18], 4, 'g')}${line([h[0], 18], h, 1.6, 'g')}${line([h[0] - 20, h[1] - 2], [h[0] + 20, h[1] - 2], 3.4, 'g')}${rect(52, 112, 36, 7, 3.5, 'g')}${line([70, 118], [70, FLOOR], 4, 'g')}${rect(80, 96, 12, 6, 3, 'g')}`;
      },
    },
  );

EX['barbell-row'] = () =>
  scene(
    'Rowing barre',
    { hip: [56, 84], torso: 112, head: 104, ua: -36, fa: 8, th: 26, sh: -14 },
    [
      ['torso', -1, 0.6],
      ['ua', 1, 0.5],
    ],
    { front: (j) => plateSide(add(j.arm.H, 0, 3), 13) },
  );

EX['one-arm-row'] = () =>
  scene(
    'Rowing un bras',
    { hip: [54, 84], torso: 100, head: 94, ua: -40, fa: 6, th: -10, sh: -14, th2: 30, sh2: 0 },
    [
      ['torso', -1, 0.6],
      ['ua', 1, 0.5],
    ],
    { front: (j) => dumbbellEnd(add(j.arm.H, 0, 2)), opts: { noFarArm: true } },
  );

EX['seated-row'] = () =>
  scene(
    'Tirage horizontal',
    {
      hip: [56, 120],
      torso: 174,
      head: 172,
      ua: -30,
      fa: 82,
      th: 82,
      sh: 104,
      ft: 172,
      ground: false,
    },
    [
      ['torso', -1, 0.6],
      ['ua', 1, 0.5],
    ],
    {
      back: (j) =>
        `${rect(28, 124, 46, 7, 3.5, 'g')}${line([40, 130], [40, FLOOR], 4, 'g')}${line([134, 20], [134, FLOOR], 5, 'g')}${circle([134, 104], 4.5, 'g')}${line([134, 104], j.arm.H, 1.6, 'g')}${rect(j.leg.A[0] + 4, 116, 7, 28, 3, 'g')}`,
    },
  );

EX['face-pull'] = () =>
  scene(
    'Face pull',
    { hip: [58, 84], torso: 176, head: 176, ua: 104, fa: -150, th: 4, sh: -2 },
    [
      ['delt', 0],
      ['torso', -1, 0.82, 0.6],
    ],
    {
      back: (j) =>
        `${line([134, 16], [134, FLOOR], 5, 'g')}${circle([134, 40], 4.5, 'g')}${line([134, 40], j.arm.H, 1.6, 'g')}`,
    },
  );

EX['pullover'] = () =>
  scene(
    'Pull-over haltère',
    { hip: [102, 100], torso: -90, head: -96, ua: -112, fa: -102, th: 80, sh: 18, ground: false },
    [['torso', -1, 0.62]],
    { back: bench(44, 118, 104), front: (j) => dumbbellEnd(add(j.arm.H, -102, 3)) },
  );

// ─── Bras ───────────────────────────────────────────────────────────────────
EX['curl'] = () =>
  scene(
    'Curl biceps',
    { hip: [72, 84], torso: 180, head: 178, ua: 6, fa: 150, th: 1, sh: -1 },
    [['ua', 1, 0.5, 1.05]],
    { front: (j) => dumbbell(j.arm.H, 0) },
  );

EX['triceps-pushdown'] = () =>
  scene(
    'Extension triceps à la poulie',
    { hip: [62, 84], torso: 172, head: 168, ua: 6, fa: 70, th: 3, sh: -1 },
    [['ua', -1, 0.5, 1.05]],
    {
      back: (j) =>
        `${line([112, 16], [112, FLOOR], 5, 'g')}${circle([104, 22], 4.5, 'g')}${line([104, 22], j.arm.H, 1.6, 'g')}${line(add(j.arm.H, -40, 1), add(j.arm.H, 20, 7), 3.4, 'g')}`,
    },
  );

EX['skull-crusher'] = () =>
  scene(
    'Barre au front',
    { hip: [98, 100], torso: -90, head: -96, ua: 166, fa: -48, th: 80, sh: 18, ground: false },
    [['ua', 1, 0.5, 1.05]],
    { back: bench(40, 114, 104), front: (j) => plateSide(add(j.arm.H, -48, 2), 12) },
  );

EX['overhead-triceps'] = () =>
  scene(
    'Extension triceps au-dessus de la tête',
    { hip: [72, 86], torso: 180, head: 176, ua: 166, fa: -36, th: 1, sh: -1 },
    [['ua', 1, 0.5, 1.05]],
    { front: (j) => dumbbell(add(j.arm.H, -36, 2), 54) },
  );

// ─── Gainage ────────────────────────────────────────────────────────────────
EX['plank'] = () =>
  scene(
    'Gainage',
    {
      hip: [88, 118],
      torso: -101,
      head: -104,
      ua: 0,
      fa: -88,
      th: 79,
      sh: 79,
      ft: 0,
      ground: false,
    },
    [['torso', 1, 0.42]],
    {},
  );

EX['hanging-leg-raise'] = () =>
  scene(
    'Relevé de jambes suspendu',
    {
      hip: [76, 96],
      torso: 180,
      head: 180,
      ua: 172,
      fa: 180,
      th: 92,
      sh: 94,
      ft: 180,
      ground: false,
    },
    [['torso', 1, 0.3]],
    {
      back: `${line([40, 20], [128, 20], 4, 'g')}${line([44, 20], [44, 6], 4, 'g')}${line([124, 20], [124, 6], 4, 'g')}`,
    },
  );

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(EX)) {
  writeFileSync(resolve(OUT, `${name}.svg`), make());
}
console.log(`${Object.keys(EX).length} schémas écrits dans ${OUT}`);
