import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createShareCardImage = vi.fn();
const shareCardImage = vi.fn();
vi.mock('../../apps/web/src/lib/session-share-image', () => ({
  createShareCardImage: (...a: unknown[]) => createShareCardImage(...a),
  shareCardImage: (...a: unknown[]) => shareCardImage(...a),
}));

import { sessionShareSheet } from '../../apps/web/src/lib/session-share-sheet';

const flush = () => new Promise((r) => setTimeout(r, 0));
const sessions = [
  { id: 'a', name: 'Push', startedAt: '2026-11-17T18:00:00Z', entries: [] },
  { id: 'b', name: 'Pull', startedAt: '2026-11-18T18:00:00Z', entries: [] },
];

function host() {
  return {
    sessions,
    exerciseName: (id: string) => `Ex ${id}`,
    ...sessionShareSheet(),
  };
}

const notified: Array<{ kind: string; message: string }> = [];

beforeEach(() => {
  notified.length = 0;
  createShareCardImage.mockReset();
  shareCardImage.mockReset();
  createShareCardImage.mockImplementation(async (_s, _h, _n, format: string) => ({
    blob: new Blob([format], { type: 'image/png' }),
    fileName: 'k.png',
    title: 'Push',
  }));
  vi.stubGlobal('window', {
    dispatchEvent: (e: { detail: { kind: string; message: string } }) => notified.push(e.detail),
  });
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(
        public type: string,
        public init: { detail: unknown },
      ) {}
      get detail() {
        return this.init.detail;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('feuille « Partager en image »', () => {
  it('ouvre l’aperçu au format publication, puis story', async () => {
    const h = host();
    h.openShareCard('a');
    expect(h.shareSheet).toMatchObject({ sessionId: 'a', format: 'post', url: '' });
    await flush();
    expect(h.shareSheet!.url).toMatch(/^blob:/);
    expect(h.shareFormatPressed('post')).toBe('true');
    expect(h.sharePreviewClass()).toContain('4/5');
    h.setShareFormat('story');
    expect(h.shareSheet!.url).toBe('');
    await flush();
    expect(createShareCardImage).toHaveBeenLastCalledWith(
      sessions[0],
      sessions,
      expect.any(Function),
      'story',
    );
    expect(h.sharePreviewClass()).toContain('9/16');
  });

  it('séance inconnue : rien ne s’ouvre', () => {
    const h = host();
    h.openShareCard('zzz');
    expect(h.shareSheet).toBeNull();
  });

  it('partage puis ferme ; téléchargement annoncé', async () => {
    const h = host();
    h.openShareCard('a');
    await flush();
    shareCardImage.mockResolvedValueOnce('downloaded');
    await h.confirmShareCard();
    expect(shareCardImage).toHaveBeenCalledTimes(1);
    expect(h.shareSheet).toBeNull();
    expect(notified).toEqual([{ kind: 'success', message: 'Image enregistrée.' }]);
  });

  it('annulation : la feuille reste ouverte', async () => {
    const h = host();
    h.openShareCard('a');
    await flush();
    shareCardImage.mockResolvedValueOnce('cancelled');
    await h.confirmShareCard();
    expect(h.shareSheet).not.toBeNull();
    expect(h.shareSheet!.busy).toBe(false);
  });

  it('échec du dessin : message, pas de partage possible', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createShareCardImage.mockRejectedValueOnce(new Error('canvas'));
    const h = host();
    h.openShareCard('a');
    await flush();
    expect(h.shareSheet!.error).toMatch(/Impossible/);
    await h.confirmShareCard();
    expect(shareCardImage).not.toHaveBeenCalled();
  });

  it('carte de fin : séance qu’on vient d’enregistrer', () => {
    const h = host();
    h.justSavedSessionId = 'b';
    expect(h.justSavedName()).toBe('Pull');
    h.shareJustSaved();
    expect(h.shareSheet!.sessionId).toBe('b');
    h.closeShareCard();
    h.dismissJustSaved();
    expect(h.shareSheet).toBeNull();
    expect(h.justSavedSessionId).toBeNull();
  });
});
