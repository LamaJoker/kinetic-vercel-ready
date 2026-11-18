import { describe, it, expect, vi } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/camera', () => ({ Camera: {}, CameraResultType: {}, CameraSource: {} }));

import { smoothLine } from '../../apps/web/src/pages/mensurations.page.js';

describe('mensurations smoothLine', () => {
  it('draws straight segments under 3 points', () => {
    expect(smoothLine([])).toBe('');
    expect(
      smoothLine([
        [0, 1],
        [4, 2],
      ]),
    ).toBe('M 0.0 1.0 L 4.0 2.0');
  });

  it('uses one cubic per segment and ends on the last point', () => {
    const d = smoothLine([
      [0, 100],
      [50, 80],
      [100, 90],
    ]);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d.endsWith('100.0 90.0')).toBe(true);
  });
});
