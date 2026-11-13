# Kinetic — Android Build Guide

Kinetic is wrapped as a native Android app via [Capacitor](https://capacitorjs.com/). The web app (Vite + Alpine.js) runs inside a `WebView`, with native plugins for status bar, splash screen, haptics, and back-button handling.

## Prerequisites

1. **Node.js ≥ 20** and **pnpm ≥ 9**
2. **Java JDK 21** (required by Capacitor 8 / AGP 8)
   - Windows: `winget install EclipseAdoptium.Temurin.21.JDK`
3. **Android Studio** (latest stable)
   - Install Android SDK Platform 34+
   - Install Android SDK Build-Tools
   - Accept all SDK licenses
4. Set environment variables:
   - `ANDROID_HOME` = `C:\Users\<you>\AppData\Local\Android\Sdk`
   - `JAVA_HOME` = JDK 21 install path
   - Add `%ANDROID_HOME%\platform-tools` to `PATH`

## First-time setup

```bash
pnpm install
pnpm build
```

The Android project lives at `apps/web/android/`.

## Building a debug APK

```bash
pnpm android:build
```

The APK is generated at:

```
apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on a connected device (USB debugging on):

```bash
adb install apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

## Building a release APK (signed)

1. Generate a keystore (one-time):

   ```bash
   keytool -genkey -v -keystore kinetic-release.keystore \
     -alias kinetic -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Move `kinetic-release.keystore` into `apps/web/android/` and create
   `apps/web/android/keystore.properties` (both are git-ignored — never commit them,
   and keep a backup: a lost keystore means you can no longer update the app):

   ```properties
   storeFile=kinetic-release.keystore
   storePassword=YOUR_PASSWORD
   keyAlias=kinetic
   keyPassword=YOUR_PASSWORD
   ```

   `app/build.gradle` picks this file up automatically; without it the release
   build is left unsigned.

3. Build:

   ```bash
   pnpm android:build:release   # signed APK  → app/build/outputs/apk/release/
   pnpm android:bundle          # signed AAB  → app/build/outputs/bundle/release/ (Play Store)
   ```

The version shown in the store comes from `apps/web/package.json` (`version`):
`9.1.0` becomes `versionName 9.1.0` / `versionCode 90100`. Bump it before every
upload — Play refuses a `versionCode` it has already seen.

## Open in Android Studio

```bash
pnpm android:open
```

From there: **Build → Build Bundle(s)/APK(s) → Build APK(s)** for an APK, or **Build → Generate Signed Bundle/APK** for a Play Store `.aab`.

## Run on connected device / emulator

```bash
pnpm android:run
```

## After modifying web code

```bash
pnpm build              # rebuilds Vite dist/
pnpm android:sync       # copies dist/ into the Android project
```

`android:build` does both automatically.

## App identity

Defined in [`apps/web/capacitor.config.ts`](apps/web/capacitor.config.ts):

- **App ID** : `com.lamajoker.kinetic`
- **App Name** : `Kinetic`

To rename or change the package: edit `capacitor.config.ts`, then `npx cap sync android`. For an existing build you'll need to re-run `cap add android` or manually update `applicationId` in `app/build.gradle` and the package folders under `app/src/main/java/`.

## Home-screen widget

The app ships a "streak + daily routine" widget
(`app/src/main/java/com/lamajoker/kinetic/KineticWidgetProvider.java`, layouts in
`res/layout/widget_kinetic*.xml`). The web app pushes its state through the
`KineticWidget` Capacitor plugin (`KineticWidgetPlugin.java` ↔ `src/lib/widget.ts`)
every time a routine task changes; the widget re-reads it every 30 minutes so the
day rolls over even if the app stays closed. Tapping it opens the routine
(`com.lamajoker.kinetic://open/vitalite`).

Users add it from Profile → "Ajouter le widget", or by long-pressing the home screen.

## Reminders

`src/lib/reminders.ts` schedules two system notifications with
`@capacitor/local-notifications`: the daily routine reminder (time chosen in
Profile, skipped once the routine is done) and the Sunday 6 pm weekly recap.
They fire with the app closed. Android 13+ asks for the notification permission
the first time a reminder is enabled.

## Customizing the icon & splash

The launcher icon is vector (`res/drawable/ic_launcher_foreground.xml`, plus
`ic_launcher_monochrome.xml` for Android 13 themed icons). Legacy PNG icons and
splash screens are rendered from the same logo:

```bash
pnpm android:assets
```

Edit the SVG at the top of `scripts/generate-android-assets.mjs` to change the logo.

## Publishing

See [`docs/play-store.md`](docs/play-store.md) for the store listing text and the
release checklist.
