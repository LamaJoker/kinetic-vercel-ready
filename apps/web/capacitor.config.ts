import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lamajoker.kinetic',
  appName: 'Kinetic',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  ios: {
    // Health Connect et le scanner Google n'existent que sur Android.
    includePlugins: [
      '@capacitor/app',
      '@capacitor/browser',
      '@capacitor/camera',
      '@capacitor/filesystem',
      '@capacitor/haptics',
      '@capacitor/local-notifications',
      '@capacitor/share',
      '@capacitor/splash-screen',
      '@capacitor/status-bar',
    ],
    contentInset: 'never',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_kinetic',
      iconColor: '#FF7A66', // corail (ACCENT_HEX, src/lib/palette.ts)
    },
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#0B0E1A', // fond bleu nuit (PAGE_BG_DARK)
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0B0E1A',
    },
  },
};

export default config;
