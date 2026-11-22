import { describe, it, expect } from 'vitest';
import {
  TOUR_STEPS,
  cropSpotForBubble,
  parseTourState,
  placeBubble,
  scrollDeltaForTarget,
  shouldStartTour,
  spotlightRect,
  tourProgressLabel,
  tourStateAfterOnboarding,
} from '@kinetic/core';

const VP = { width: 393, height: 659, safeTop: 8, safeBottom: 8 };

describe('étapes de la visite', () => {
  it('compte 5 à 7 étapes, identifiants uniques, textes renseignés', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(5);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(7);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const s of TOUR_STEPS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.body.length).toBeGreaterThan(20);
    }
  });
  it('couvre les écrans et gestes clés', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(ids).toEqual(['today', 'quick-log', 'hold', 'swipe', 'pull', 'checkin', 'muscles']);
    expect(TOUR_STEPS.find((s) => s.id === 'quick-log')!.body).toContain('Même chose');
  });
  it('une étape sans cible à l’écran mime le geste', () => {
    for (const s of TOUR_STEPS.filter((x) => x.targets.length === 0))
      expect(s.gesture).toBeTruthy();
  });
});

describe('état et lancement', () => {
  it('lit l’état mémorisé', () => {
    expect(parseTourState('pending')).toBe('pending');
    expect(parseTourState('replay')).toBe('replay');
    expect(parseTourState('done')).toBe('done');
    expect(parseTourState('x')).toBeNull();
    expect(parseTourState(null)).toBeNull();
  });
  it('n’est proposée qu’une fois après l’onboarding', () => {
    expect(tourStateAfterOnboarding(null)).toBe('pending');
    expect(tourStateAfterOnboarding('pending')).toBe('pending');
    expect(tourStateAfterOnboarding('done')).toBe('done');
  });
  it('démarre en attente, jamais en build E2E ni avec le drapeau de test', () => {
    const base = { e2eBuild: false, skipFlag: false };
    expect(shouldStartTour({ ...base, state: 'pending' })).toBe(true);
    expect(shouldStartTour({ ...base, state: 'done' })).toBe(false);
    expect(shouldStartTour({ ...base, state: null })).toBe(false);
    expect(shouldStartTour({ state: 'pending', e2eBuild: true, skipFlag: false })).toBe(false);
    expect(shouldStartTour({ state: 'pending', e2eBuild: false, skipFlag: true })).toBe(false);
  });
  it('« Revoir la visite » fonctionne aussi en build E2E, sauf drapeau de test', () => {
    expect(shouldStartTour({ state: 'replay', e2eBuild: true, skipFlag: false })).toBe(true);
    expect(shouldStartTour({ state: 'replay', e2eBuild: false, skipFlag: true })).toBe(false);
  });
  it('affiche la progression', () => {
    expect(tourProgressLabel(0, 7)).toBe('1 / 7');
    expect(tourProgressLabel(6, 7)).toBe('7 / 7');
  });
});

describe('découpe et bulle', () => {
  it('élargit la découpe sans sortir de l’écran', () => {
    expect(spotlightRect({ top: 100, left: 20, width: 100, height: 50 }, VP, 8)).toEqual({
      top: 92,
      left: 12,
      width: 116,
      height: 66,
    });
    const edge = spotlightRect({ top: 2, left: 0, width: 393, height: 655 }, VP, 8);
    expect(edge).toEqual({ top: 0, left: 0, width: 393, height: 659 });
  });
  it('place la bulle sous la cible quand il y a la place', () => {
    const p = placeBubble(
      { top: 90, left: 12, width: 370, height: 270 },
      { width: 344, height: 180 },
      VP,
    );
    expect(p.placement).toBe('below');
    expect(p.top).toBe(90 + 270 + 14);
    expect(p.left).toBeGreaterThanOrEqual(16);
    expect(p.left + 344).toBeLessThanOrEqual(393 - 16);
  });
  it('au-dessus pour une cible en bas (barre d’onglets), flèche vers elle', () => {
    const p = placeBubble(
      { top: 583, left: 80, width: 90, height: 68 },
      { width: 344, height: 200 },
      VP,
    );
    expect(p.placement).toBe('above');
    expect(p.top).toBe(583 - 14 - 200);
    expect(p.left + p.arrowX).toBeCloseTo(125, 0);
  });
  it('au centre sans cible ou sans place', () => {
    expect(placeBubble(null, { width: 344, height: 260 }, VP).placement).toBe('center');
    const tall = placeBubble(
      { top: 60, left: 0, width: 393, height: 560 },
      { width: 344, height: 200 },
      VP,
    );
    expect(tall.placement).toBe('center');
  });
  it('rogne une cible trop haute pour garder la bulle dessous', () => {
    const spot = { top: 84, left: 12, width: 370, height: 500 };
    const cropped = cropSpotForBubble(spot, 180, VP);
    expect(cropped.height).toBeLessThan(500);
    expect(placeBubble(cropped, { width: 344, height: 180 }, VP).placement).toBe('below');
  });
  it('ne rogne pas une cible qui laisse la place au-dessus', () => {
    const spot = { top: 400, left: 12, width: 370, height: 200 };
    expect(cropSpotForBubble(spot, 180, VP)).toEqual(spot);
  });
});

describe('défilement vers la cible', () => {
  it('ne bouge pas si cible et bulle tiennent déjà', () => {
    expect(scrollDeltaForTarget({ top: 100, left: 0, width: 300, height: 200 }, VP, 180)).toBe(0);
  });
  it('remonte une cible plus bas dans la page', () => {
    const d = scrollDeltaForTarget({ top: 900, left: 0, width: 300, height: 200 }, VP, 180);
    expect(d).toBeGreaterThan(0);
    // après défilement, cible + bulle tiennent sous l'en-tête
    expect(900 - d).toBeGreaterThanOrEqual(76);
    expect(900 - d + 200 + 14 + 180).toBeLessThanOrEqual(659);
  });
  it('cale une cible très haute juste sous l’en-tête', () => {
    const d = scrollDeltaForTarget({ top: 700, left: 0, width: 300, height: 900 }, VP, 180);
    expect(700 - d).toBe(84);
  });
});
