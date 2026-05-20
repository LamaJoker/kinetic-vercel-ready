/**
 * tests/unit/core-validation.test.ts
 *
 * Unit tests for packages/core/src/validation.ts.
 * Both functions are pure — no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import { validateStorageKey, validateStorageValue } from '../../packages/core/src/validation.js';

describe('validateStorageKey', () => {
  it('accepts simple alphanumeric key', () => {
    expect(validateStorageKey('user123')).toBe(true);
  });

  it('accepts key with colon separator', () => {
    expect(validateStorageKey('user:profile')).toBe(true);
  });

  it('accepts key with hyphen', () => {
    expect(validateStorageKey('user-profile-v2')).toBe(true);
  });

  it('accepts key with underscore', () => {
    expect(validateStorageKey('daily_log_2026')).toBe(true);
  });

  it('accepts key with all allowed chars combined', () => {
    expect(validateStorageKey('streak:daily_log-v2')).toBe(true);
  });

  it('accepts a single character key', () => {
    expect(validateStorageKey('a')).toBe(true);
  });

  it('accepts a key of exactly 200 characters', () => {
    expect(validateStorageKey('a'.repeat(200))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateStorageKey('')).toBe(false);
  });

  it('rejects key with a space', () => {
    expect(validateStorageKey('user profile')).toBe(false);
  });

  it('rejects key with @ symbol', () => {
    expect(validateStorageKey('user@domain')).toBe(false);
  });

  it('rejects key with a dot', () => {
    expect(validateStorageKey('user.key')).toBe(false);
  });

  it('rejects key with slash', () => {
    expect(validateStorageKey('path/key')).toBe(false);
  });

  it('rejects key exceeding 200 characters', () => {
    expect(validateStorageKey('a'.repeat(201))).toBe(false);
  });
});

describe('validateStorageValue', () => {
  it('accepts null', () => {
    expect(validateStorageValue(null)).toBe(true);
  });

  it('rejects undefined (JSON.stringify returns undefined, .length throws → catch → false)', () => {
    expect(validateStorageValue(undefined)).toBe(false);
  });

  it('accepts plain string', () => {
    expect(validateStorageValue('hello world')).toBe(true);
  });

  it('accepts number', () => {
    expect(validateStorageValue(42)).toBe(true);
  });

  it('accepts boolean', () => {
    expect(validateStorageValue(true)).toBe(true);
  });

  it('accepts plain object', () => {
    expect(validateStorageValue({ a: 1, b: 'hello', c: true })).toBe(true);
  });

  it('accepts array', () => {
    expect(validateStorageValue([1, 'two', { three: 3 }])).toBe(true);
  });

  it('accepts empty object', () => {
    expect(validateStorageValue({})).toBe(true);
  });

  it('accepts empty array', () => {
    expect(validateStorageValue([])).toBe(true);
  });

  it('rejects a string longer than 1 MB', () => {
    const big = 'x'.repeat(1_024 * 1_024 + 1);
    expect(validateStorageValue(big)).toBe(false);
  });

  it('accepts a string whose JSON form is exactly 1 MB (content = 1MB - 2 quote chars)', () => {
    // JSON.stringify("x".repeat(N)) produces `"xxx..."` — adds 2 surrounding quotes.
    // For the serialized length to equal exactly 1_024*1_024, the raw string must be 1MB-2.
    const exact = 'x'.repeat(1_024 * 1_024 - 2);
    expect(validateStorageValue(exact)).toBe(true);
  });

  it('rejects a value with circular references', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(validateStorageValue(obj)).toBe(false);
  });
});
