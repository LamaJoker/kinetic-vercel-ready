/**
 * Scan de code-barres à l'appareil photo (application Android), via le scanner
 * Google des services Play : aucune autorisation caméra à demander.
 */
import { Capacitor } from '@capacitor/core';

export function cameraScanSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export type CameraScanResult =
  | { status: 'ok'; code: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' };

export async function scanBarcodeWithCamera(): Promise<CameraScanResult> {
  if (!cameraScanSupported()) return { status: 'unavailable' };
  try {
    const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      return { status: 'unavailable' };
    }
    const { barcodes } = await BarcodeScanner.scan({
      formats: [BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.UpcA, BarcodeFormat.UpcE],
    });
    const code = barcodes[0]?.rawValue?.trim();
    return code ? { status: 'ok', code } : { status: 'cancelled' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/cancel/i.test(message)) return { status: 'cancelled' };
    console.warn('[barcode] camera scan failed:', err);
    return { status: 'unavailable' };
  }
}
