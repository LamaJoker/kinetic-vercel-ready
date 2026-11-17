import { describe, it, expect, vi, beforeEach } from 'vitest';

const scanner = vi.hoisted(() => ({
  isGoogleBarcodeScannerModuleAvailable: vi.fn(),
  installGoogleBarcodeScannerModule: vi.fn(),
  scan: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true), getPlatform: vi.fn(() => 'android') },
}));
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
  BarcodeScanner: scanner,
  BarcodeFormat: { Ean13: 'EAN_13', Ean8: 'EAN_8', UpcA: 'UPC_A', UpcE: 'UPC_E' },
}));

import { Capacitor } from '@capacitor/core';
import {
  cameraScanSupported,
  scanBarcodeWithCamera,
} from '../../apps/web/src/lib/barcode-camera.js';

beforeEach(() => {
  for (const fn of Object.values(scanner)) fn.mockReset();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  scanner.isGoogleBarcodeScannerModuleAvailable.mockResolvedValue({ available: true });
});

describe('scanBarcodeWithCamera', () => {
  it('renvoie le code lu', async () => {
    scanner.scan.mockResolvedValue({ barcodes: [{ rawValue: ' 3017620422003 ' }] });
    expect(await scanBarcodeWithCamera()).toEqual({ status: 'ok', code: '3017620422003' });
  });

  it('installe le scanner à la première utilisation', async () => {
    scanner.isGoogleBarcodeScannerModuleAvailable.mockResolvedValue({ available: false });
    expect(await scanBarcodeWithCamera()).toEqual({ status: 'unavailable' });
    expect(scanner.installGoogleBarcodeScannerModule).toHaveBeenCalled();
  });

  it("distingue l'annulation d'une panne", async () => {
    scanner.scan.mockResolvedValueOnce({ barcodes: [] });
    expect(await scanBarcodeWithCamera()).toEqual({ status: 'cancelled' });
    scanner.scan.mockRejectedValueOnce(new Error('scan canceled.'));
    expect(await scanBarcodeWithCamera()).toEqual({ status: 'cancelled' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    scanner.scan.mockRejectedValueOnce(new Error('play services missing'));
    expect(await scanBarcodeWithCamera()).toEqual({ status: 'unavailable' });
    warn.mockRestore();
  });

  it('est indisponible sur le web', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(cameraScanSupported()).toBe(false);
    expect(await scanBarcodeWithCamera()).toEqual({ status: 'unavailable' });
  });
});
