/**
 * Modules purs partagés des fonctions Edge (supabase/functions/_shared).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateCors,
  loadCorsConfig,
  normalizeOrigin,
  parseAllowedOrigins,
} from '../../supabase/functions/_shared/cors.ts';
import {
  envFromRecord,
  isProduction,
  readSecureFlag,
} from '../../supabase/functions/_shared/env.ts';
import {
  bearerToken,
  isJsonContentType,
  readJsonBody,
  timingSafeEqual,
} from '../../supabase/functions/_shared/http.ts';
import {
  hmacHex,
  neutralizeMentions,
  redactSensitive,
} from '../../supabase/functions/_shared/redact.ts';
import { parseQuotaResponse } from '../../supabase/functions/_shared/quota.ts';
import {
  classifyStatus,
  resolveMaxTokens,
  resolveModel,
} from '../../supabase/functions/_shared/anthropic.ts';
import { boundedString, hasControlChars } from '../../supabase/functions/_shared/validate.ts';
import { hugeStreamRequest, jsonRequest } from '../helpers/edge.ts';

describe('cors', () => {
  it('rejette *, null et les valeurs qui ne sont pas des origines', () => {
    expect(
      parseAllowedOrigins(
        '*, null, https://a.example/, https://a.example/path, capacitor://localhost',
      ),
    ).toEqual(['https://a.example', 'capacitor://localhost']);
    expect(normalizeOrigin('https://*.example')).toBeUndefined();
  });

  it('production sans liste → misconfigured (même sans Origin)', () => {
    const cfg = loadCorsConfig(envFromRecord({}));
    expect(evaluateCors(null, cfg).kind).toBe('misconfigured');
  });

  it('développement sans liste → seules les origines locales', () => {
    const cfg = loadCorsConfig(envFromRecord({ KINETIC_ENV: 'development' }));
    expect(evaluateCors('http://localhost:5173', cfg).kind).toBe('ok');
    expect(evaluateCors('https://evil.example', cfg).kind).toBe('forbidden');
    expect(evaluateCors('null', cfg).kind).toBe('forbidden');
  });

  it('jamais * dans la réponse', () => {
    const cfg = loadCorsConfig(envFromRecord({ ALLOWED_ORIGINS: 'https://a.example' }));
    const d = evaluateCors('https://a.example', cfg);
    expect(d.kind === 'ok' && d.headers['Access-Control-Allow-Origin']).toBe('https://a.example');
    expect(evaluateCors('https://a.example.evil', cfg).kind).toBe('forbidden');
  });
});

describe('env', () => {
  it('production par défaut, drapeaux de sécurité vrais par défaut', () => {
    expect(isProduction(envFromRecord({}))).toBe(true);
    expect(isProduction(envFromRecord({ KINETIC_ENV: 'local' }))).toBe(false);
    expect(readSecureFlag(envFromRecord({}), 'X')).toBe(true);
    expect(readSecureFlag(envFromRecord({ X: '' }), 'X')).toBe(true);
    expect(readSecureFlag(envFromRecord({ X: 'false' }), 'X')).toBe(false);
  });
});

describe('http', () => {
  it('Content-Type JSON strict', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/json; charset=latin1')).toBe(false);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });

  it('lecture bornée : corps de 50 Mo sans Content-Length arrêté peu après la limite', async () => {
    const { req, pulled } = hugeStreamRequest('https://x/', 50 * 1024 * 1024, {
      origin: null,
      jwt: null,
    });
    const r = await readJsonBody(req, { maxBytes: 1024, requireContentLength: false });
    expect(r).toMatchObject({ ok: false, status: 413 });
    expect(pulled()).toBeLessThan(64 * 1024);
  });

  it('UTF-8 invalide → 400', async () => {
    const req = new Request('https://x/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect(await readJsonBody(req, { maxBytes: 100, requireContentLength: false })).toMatchObject({
      status: 400,
    });
  });

  it('corps valide', async () => {
    const r = await readJsonBody(jsonRequest('https://x/', { a: 1 }), {
      maxBytes: 100,
      requireContentLength: true,
    });
    expect(r).toMatchObject({ ok: true, value: { a: 1 } });
  });

  it('bearerToken et timingSafeEqual', () => {
    expect(
      bearerToken(new Request('https://x/', { headers: { authorization: 'Bearer abcdefghijkl' } })),
    ).toBe('abcdefghijkl');
    expect(
      bearerToken(new Request('https://x/', { headers: { authorization: 'Basic abcdefghijkl' } })),
    ).toBeNull();
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});

describe('redact', () => {
  it('masque e-mails, JWT, clés, paramètres d’URL, UUID, téléphones', () => {
    const out = redactSensitive(
      'mail a.b@c.fr jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl clé sk-ant-api03-abcdefghij url https://x.fr/cb?code=SECRET&state=1 password: hunter2 id 11111111-2222-4333-8444-555555555555 tél +33 6 12 34 56 78',
    );
    for (const leaked of [
      'a.b@c.fr',
      'eyJhbGci',
      'sk-ant-api03',
      'SECRET',
      '11111111-2222',
      '12 34 56',
      'hunter2',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[e-mail]');
  });

  it('borne la longueur et retire les caractères de contrôle', () => {
    expect(redactSensitive('mot '.repeat(300), 10)).toHaveLength(10);
    expect(redactSensitive('a\u0000b')).toBe('a b');
  });

  it('neutralise les mentions', () => {
    expect(neutralizeMentions('@everyone')).not.toBe('@everyone');
  });

  it('HMAC déterministe et dépendant du secret', async () => {
    expect(await hmacHex('k', 'v')).toBe(await hmacHex('k', 'v'));
    expect(await hmacHex('k', 'v')).not.toBe(await hmacHex('k2', 'v'));
  });
});

describe('quota', () => {
  it('réponse inattendue → erreur (échec fermé)', () => {
    expect(parseQuotaResponse(null).kind).toBe('error');
    expect(parseQuotaResponse(true).kind).toBe('error');
    expect(parseQuotaResponse({ allowed: 'yes' }).kind).toBe('error');
    expect(parseQuotaResponse({ allowed: true }).kind).toBe('allowed');
    expect(
      parseQuotaResponse({ allowed: false, reason: 'user_hourly', retry_after_seconds: 12.2 }),
    ).toEqual({
      kind: 'denied',
      reason: 'user_hourly',
      retryAfterSeconds: 13,
    });
  });
});

describe('anthropic', () => {
  it('modèle en liste blanche, max_tokens borné', () => {
    expect(resolveModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(resolveModel('gpt-x')).toBe('claude-sonnet-5');
    expect(resolveMaxTokens('1')).toBe(256);
    expect(resolveMaxTokens('abc')).toBe(1024);
  });

  it('classe les statuts', () => {
    expect(classifyStatus(429)).toBe('rate_limited');
    expect(classifyStatus(529)).toBe('overloaded');
    expect(classifyStatus(503)).toBe('upstream_error');
    expect(classifyStatus(400)).toBe('config_error');
  });
});

describe('validate', () => {
  it('boundedString compte les points de code et refuse les contrôles', () => {
    expect(boundedString('😀😀', 'f', 1, 2).ok).toBe(true);
    expect(boundedString('a\u0007', 'f', 1, 10).ok).toBe(false);
    expect(hasControlChars('ligne\nsuivante\t')).toBe(false);
  });
});
