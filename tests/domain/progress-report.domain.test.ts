import { describe, it, expect } from 'vitest';
import {
  createPdf,
  toWinAnsi,
  textWidth,
  wrapText,
  buildProgressReport,
  renderProgressReportPdf,
  progressReportPdf,
  progressReportFileName,
  reportPeriodStart,
  isReportPeriodKey,
  type ProgressReportInput,
  type ReportSession,
} from '@kinetic/core';

const NOW = Date.parse('2026-11-22T10:00:00Z');
const DAY = 86_400_000;

/** Vérifie la structure : en-tête, objets, xref aux bons décalages, trailer. */
function checkStructure(pdf: string): { objects: number; pages: number } {
  expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
  expect(pdf.endsWith('%%EOF\n')).toBe(true);
  // Entièrement ASCII : longueur de chaîne = octets.
  expect([...pdf].every((c) => c === '\n' || (c >= ' ' && c <= '~'))).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
  expect(pdf.slice(startxref, startxref + 5)).toBe('xref\n');
  const head = /^xref\n0 (\d+)\n/.exec(pdf.slice(startxref))!;
  const size = Number(head[1]);
  const rows = pdf
    .slice(startxref + head[0].length)
    .split('\n')
    .slice(0, size);
  expect(rows[0]).toBe('0000000000 65535 f ');
  for (let id = 1; id < size; id++) {
    expect(rows[id]).toMatch(/^\d{10} 00000 n $/);
    const off = Number(rows[id]!.slice(0, 10));
    expect(pdf.slice(off, off + `${id} 0 obj\n`.length)).toBe(`${id} 0 obj\n`);
  }
  expect(pdf).toContain(`/Size ${size} /Root 1 0 R`);
  // Chaque flux a la bonne longueur.
  for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    expect(pdf.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream');
  }
  const pages = Number(/\/Type \/Pages \/Count (\d+)/.exec(pdf)![1]);
  return { objects: size - 1, pages };
}

/** Octets WinAnsi d'un texte, tels qu'écrits dans les chaînes hexadécimales. */
const hexOf = (s: string) =>
  toWinAnsi(s)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

describe('pdf-writer', () => {
  it('encode les accents français en WinAnsi', () => {
    expect(toWinAnsi('é è à ç ô œ « »')).toEqual([
      0xe9, 0x20, 0xe8, 0x20, 0xe0, 0x20, 0xe7, 0x20, 0xf4, 0x20, 0x9c, 0x20, 0xab, 0x20, 0xbb,
    ]);
    expect(toWinAnsi('Œuvre – 5 €’')).toEqual([
      0x8c,
      ...'uvre '.split('').map((c) => c.charCodeAt(0)),
      0x96,
      0x20,
      0x35,
      0x20,
      0x80,
      0x92,
    ]);
    // Emoji retiré, espace fine insécable → espace.
    expect(toWinAnsi('💪 12\u202f450')).toEqual([0x20, 0x31, 0x32, 0x20, 0x34, 0x35, 0x30]);
  });

  it('mesure et coupe le texte', () => {
    expect(textWidth('A', 10)).toBeCloseTo(6.67, 2);
    expect(textWidth('é', 10)).toBe(textWidth('e', 10));
    expect(textWidth('Bold', 10, true)).toBeGreaterThan(textWidth('Bold', 10));
    const lines = wrapText('un deux trois quatre cinq six sept huit', 60, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(60);
    expect(wrapText('a\nb', 100, 10)).toEqual(['a', 'b']);
  });

  it('produit un PDF valide avec des offsets xref exacts', () => {
    const doc = createPdf({ title: 'Été « test »', createdAt: new Date(NOW) });
    const p = doc.addPage();
    p.text(40, 40, 'Élan à ç ô œ « »', { size: 12, bold: true });
    p.rect(10, 10, 50, 20, [255, 122, 102]);
    p.line(0, 0, 100, 100, { width: 2, dash: [2, 2] });
    p.polyline([
      [0, 0],
      [10, 10],
      [20, 5],
    ]);
    doc.addPage().text(10, 10, 'Deuxième page', { align: 'center' });
    const pdf = doc.build();
    const { pages } = checkStructure(pdf);
    expect(pages).toBe(2);
    expect(pdf).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(pdf).toContain('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding');
    expect(pdf).toContain(`<${hexOf('Élan à ç ô œ « »')}> Tj`);
    expect(pdf).toContain('re f');
    expect(pdf).toContain('/CreationDate (D:20261122100000Z)');
  });

  it('document vide : une page blanche valide', () => {
    const { pages } = checkStructure(createPdf().build());
    expect(pages).toBe(1);
  });
});

function session(daysAgo: number, kg: number, note?: string): ReportSession {
  const startedAt = new Date(NOW - daysAgo * DAY).toISOString();
  return {
    startedAt,
    durationMin: 60,
    entries: [
      {
        exerciseId: 'squat',
        sets: [
          { reps: 5, weightKg: 40, kind: 'warmup' },
          { reps: 5, weightKg: kg, ...(note ? { note, performedAt: startedAt } : {}) },
          { reps: 5, weightKg: kg },
        ],
      },
      { exerciseId: 'plank', sets: [{ reps: 0, weightKg: 0, durationSec: 60 }] },
      { exerciseId: 'dips', sets: [{ reps: 12, weightKg: 0 }] },
    ],
  };
}

const INPUT: Omit<ProgressReportInput, 'period'> = {
  name: 'Zoé',
  sessions: [
    session(200, 80),
    session(20, 100, 'Genoux qui rentrent, à surveiller'),
    session(13, 102.5),
    session(6, 105),
  ],
  exerciseName: (id) => (id === 'squat' ? 'Squat' : 'Gainage'),
  musclesOf: (id) =>
    id === 'squat' ? ['quads', 'glutes'] : id === 'dips' ? ['triceps'] : ['core'],
  bodyweight: [
    { date: '2026-10-30', weight: 80, note: null },
    { date: '2026-11-20', weight: 78.5, note: 'Après une semaine légère' },
  ],
  measurements: [
    { date: '2026-10-28', waist: 84, chest: 100 },
    { date: '2026-11-18', waist: 82.5, chest: 101 },
  ],
  goals: [
    { id: 'g1', exerciseId: 'squat', kind: 'weight', targetKg: 120, createdAt: '2026-09-01' },
  ],
};

describe('bilan de progression', () => {
  it('périodes', () => {
    expect(isReportPeriodKey('6m')).toBe(true);
    expect(isReportPeriodKey('2y')).toBe(false);
    expect(reportPeriodStart('4w', NOW)).toBe(NOW - 28 * DAY);
    expect(new Date(reportPeriodStart('1y', NOW)).getFullYear()).toBe(2025);
    expect(reportPeriodStart('all', NOW, NOW - 500 * DAY)).toBe(NOW - 500 * DAY);
    expect(reportPeriodStart('all', NOW)).toBe(NOW);
    expect(progressReportFileName(NOW)).toMatch(/^kinetic-bilan-2026-11-2\d\.pdf$/);
  });

  it('calcule la synthèse de la période', () => {
    const r = buildProgressReport({ ...INPUT, period: '4w' }, NOW);
    expect(r.name).toBe('Zoé');
    expect(r.summary.sessions).toBe(3);
    expect(r.summary.minutes).toBe(180);
    // Échauffements et gainage exclus du tonnage.
    expect(r.summary.tonnageKg).toBe(2 * 5 * (100 + 102.5 + 105));
    expect(r.summary.totalWeeks).toBe(4);
    expect(r.summary.activeWeeks).toBe(3);
    expect(r.summary.regularityPct).toBe(75);
    expect(r.summary.bodyweightStart).toBe(80);
    expect(r.summary.bodyweightEnd).toBe(78.5);
    expect(r.weekly.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('records et e1RM comparés à tout l’historique', () => {
    const r = buildProgressReport({ ...INPUT, period: '4w' }, NOW);
    const sq = r.exercises[0]!;
    expect(sq.name).toBe('Squat');
    expect(sq.points).toHaveLength(3);
    expect(sq.bestE1rm).toBeCloseTo(105 * (1 + 5 / 30), 1);
    expect(sq.records).toBe(3); // 100 > 80 (avant la période), puis 102,5 et 105
    expect(sq.bestSet).toMatchObject({ weightKg: 105, reps: 5 });
    expect(sq.deltaPct).toBe(5);
    expect(r.summary.records).toBe(3);
    // Chronométré ou au poids du corps : pas d'e1RM, pas dans les records.
    expect(r.exercises.map((e) => e.id)).toEqual(['squat']);
  });

  it('corps, muscles, objectifs, notes', () => {
    const r = buildProgressReport({ ...INPUT, period: '3m' }, NOW);
    expect(r.measurements.map((m) => m.key)).toEqual(['waist', 'chest']);
    expect(r.measurements[0]).toMatchObject({ first: 84, last: 82.5 });
    expect(r.muscles[0]).toEqual({ label: 'Quadriceps', sets: 6 });
    expect(r.muscles.find((m) => m.label === 'Abdos')?.sets).toBe(3);
    expect(r.goals[0]).toMatchObject({ target: 124 }); // e1RM d'un 120 kg × 1;
    expect(r.goals[0]!.pct).toBeGreaterThan(90);
    expect(r.notes.map((n) => n.source)).toEqual(['Pesée', 'Squat']);
  });

  it('période « Tout » depuis la première donnée', () => {
    const r = buildProgressReport({ ...INPUT, period: 'all' }, NOW);
    expect(r.summary.sessions).toBe(4);
    expect(r.start).toBe(NOW - 200 * DAY);
    expect(r.exercises[0]!.records).toBe(3);
    expect(r.periodLabel).toMatch(/^Tout l’historique · du /);
  });

  it('rend un PDF de plusieurs pages, avec les accents', () => {
    const pdf = progressReportPdf({ ...INPUT, period: '3m' }, NOW);
    const { pages } = checkStructure(pdf);
    expect(pages).toBeGreaterThanOrEqual(3);
    for (const t of [
      'Bilan de progression',
      'Synthèse',
      'Régularité',
      'Répartition par groupe musculaire',
      'Genoux qui rentrent, à surveiller',
    ])
      expect(pdf).toContain(`<${hexOf(t)}>`);
    expect(pdf).toContain(`<${hexOf(`Page 1 / ${pages}`)}>`);
  });

  it('sans données : PDF valide avec messages vides', () => {
    const r = buildProgressReport({ period: '4w', sessions: [], exerciseName: (id) => id }, NOW);
    expect(r.name).toBe('Athlète Kinetic');
    expect(r.summary.sessions).toBe(0);
    const pdf = renderProgressReportPdf(r, NOW);
    checkStructure(pdf);
    expect(pdf).toContain(`<${hexOf('Aucune pesée sur la période.')}>`);
  });
});
