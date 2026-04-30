import { Capacitor } from '@capacitor/core';

/**
 * initMobile — initialise les plugins Capacitor natifs.
 *
 * Les imports @capacitor/* sont dynamiques pour éviter qu'ils finissent
 * dans le bundle web. Ces modules ne servent que sur Android/iOS et
 * représentent ~50 kB inutiles pour les utilisateurs PWA.
 *
 * Capacitor.isNativePlatform() est évalué avant tout import dynamique,
 * donc aucun chunk Capacitor n'est chargé dans le contexte web.
 */
export async function initMobile(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0b0f1a' });
  } catch { /* plugin absent en dev ou permissions manquantes */ }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch { /* ignore */ }

  try {
    const { App: CapApp } = await import('@capacitor/app');
    CapApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack && window.history.length > 1) {
        window.history.back();
      } else {
        CapApp.exitApp();
      }
    });
  } catch { /* ignore */ }
}
