import { describe, it, expect, vi, afterEach } from 'vitest';
import { pageTemplate } from '../../apps/web/src/lib/page-template';
import { pageTemplateModule } from '../../apps/web/vite.config';

function response(body: string, status = 200, type = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'Content-Type': type } });
}

afterEach(() => vi.unstubAllGlobals());

describe('page-template : gabarits de pages en fichiers statiques', () => {
  it('télécharge le gabarit une seule fois', async () => {
    const fetchMock = vi.fn(async () => response('<div x-data="dashboard"></div>'));
    vi.stubGlobal('fetch', fetchMock);
    const load = pageTemplate('/static/assets/dashboard-abc.txt');
    await expect(load()).resolves.toBe('<div x-data="dashboard"></div>');
    await expect(load()).resolves.toBe('<div x-data="dashboard"></div>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/static/assets/dashboard-abc.txt');
  });

  it('refuse la page HTML de repli (fichier disparu après un déploiement)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('<!doctype html>', 200, 'text/html')),
    );
    await expect(pageTemplate('/static/assets/x.txt')()).rejects.toThrow(/text\/html/);
  });

  it('échoue sur une erreur HTTP puis réessaie au prochain appel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response('introuvable', 404))
      .mockResolvedValueOnce(response('<p>ok</p>'));
    vi.stubGlobal('fetch', fetchMock);
    const load = pageTemplate('/static/assets/x.txt');
    await expect(load()).rejects.toThrow(/404/);
    await expect(load()).resolves.toBe('<p>ok</p>');
  });

  it('le module généré au build exporte le chargeur du fichier émis', () => {
    const code = pageTemplateModule('import.meta.ROLLUP_FILE_URL_ref1');
    expect(code).toMatch(/import \{ pageTemplate \} from ".*page-template\.ts";/);
    expect(code).toContain('export default pageTemplate(import.meta.ROLLUP_FILE_URL_ref1);');
  });
});
