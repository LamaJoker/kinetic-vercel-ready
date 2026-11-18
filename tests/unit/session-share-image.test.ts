import { describe, it, expect, vi } from 'vitest';
import {
  accentFromCssVar,
  fitWithEllipsis,
  isShareCancel,
  rowsThatFit,
  shareCardImage,
  wrapText,
  type ShareEnv,
} from '../../apps/web/src/lib/session-share-image';

/** Police fictive : 10 px par caractère. */
const measure = (t: string) => t.length * 10;

describe('carte de séance : mise en page', () => {
  it('coupe un titre en lignes sans dépasser la largeur', () => {
    expect(wrapText('Jambes et fessiers lourds', 120, 3, measure)).toEqual([
      'Jambes et',
      'fessiers',
      'lourds',
    ]);
  });

  it('termine par « … » quand le texte dépasse le nombre de lignes', () => {
    const lines = wrapText('Push A force maximale semaine trois', 110, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect(measure(lines[1]!)).toBeLessThanOrEqual(110);
  });

  it('un mot trop long est raccourci', () => {
    const [line] = wrapText('Supercalifragilistique', 80, 1, measure);
    expect(line).toBe('Superca…');
  });

  it('texte vide : aucune ligne', () => {
    expect(wrapText('   ', 100, 2, measure)).toEqual([]);
  });

  it('raccourcit avec « … » seulement si nécessaire', () => {
    expect(fitWithEllipsis('Squat', 100, measure)).toBe('Squat');
    expect(fitWithEllipsis('Développé couché', 80, measure)).toBe('Dévelop…');
  });

  it('nombre de rangées qui tiennent', () => {
    expect(rowsThatFit(500, 108, 6)).toBe(4);
    expect(rowsThatFit(1000, 108, 6)).toBe(6);
    expect(rowsThatFit(-10, 108, 6)).toBe(0);
  });

  it('couleur d’accent lue dans la variable CSS du thème', () => {
    expect(accentFromCssVar(' 255 122 102')).toEqual({
      accent: 'rgb(255, 122, 102)',
      accentRgb: '255, 122, 102',
    });
    expect(accentFromCssVar('100 210 255').accentRgb).toBe('100, 210, 255');
    expect(accentFromCssVar('').accentRgb).toBe('255, 122, 102');
    expect(accentFromCssVar('rouge').accentRgb).toBe('255, 122, 102');
  });
});

describe('carte de séance : partage', () => {
  const image = {
    blob: new Blob(['png'], { type: 'image/png' }),
    fileName: 'k.png',
    title: 'Push',
  };

  function env(over: Partial<ShareEnv> = {}): ShareEnv {
    return {
      isNative: () => false,
      shareNative: vi.fn(async () => undefined),
      canShareFiles: () => false,
      shareWeb: vi.fn(async () => undefined),
      download: vi.fn(),
      ...over,
    };
  }

  it('app native : feuille de partage système', async () => {
    const e = env({ isNative: () => true });
    await expect(shareCardImage(image, e)).resolves.toBe('shared');
    expect(e.shareNative).toHaveBeenCalledWith(image);
    expect(e.download).not.toHaveBeenCalled();
  });

  it('web avec partage de fichiers : navigator.share', async () => {
    const e = env({ canShareFiles: () => true });
    await expect(shareCardImage(image, e)).resolves.toBe('shared');
    const [file, title] = (e.shareWeb as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((file as File).name).toBe('k.png');
    expect((file as File).type).toBe('image/png');
    expect(title).toBe('Push');
  });

  it('web sans partage de fichiers : téléchargement', async () => {
    const e = env();
    await expect(shareCardImage(image, e)).resolves.toBe('downloaded');
    expect(e.download).toHaveBeenCalledWith(image.blob, 'k.png');
  });

  it('annulation par l’utilisateur : ni erreur ni téléchargement', async () => {
    const abort = Object.assign(new Error('Share canceled'), { name: 'AbortError' });
    const e = env({
      canShareFiles: () => true,
      shareWeb: vi.fn(async () => Promise.reject(abort)),
    });
    await expect(shareCardImage(image, e)).resolves.toBe('cancelled');
    expect(e.download).not.toHaveBeenCalled();
    const n = env({
      isNative: () => true,
      shareNative: vi.fn(async () => Promise.reject(new Error('Share canceled'))),
    });
    await expect(shareCardImage(image, n)).resolves.toBe('cancelled');
  });

  it('autre échec : remonté à l’appelant', async () => {
    const e = env({
      isNative: () => true,
      shareNative: vi.fn(async () => Promise.reject(new Error('disque plein'))),
    });
    await expect(shareCardImage(image, e)).rejects.toThrow('disque plein');
  });

  it('reconnaît une annulation', () => {
    expect(isShareCancel(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isShareCancel(new Error('Share canceled'))).toBe(true);
    expect(isShareCancel(new Error('Network'))).toBe(false);
    expect(isShareCancel(null)).toBe(false);
  });
});
