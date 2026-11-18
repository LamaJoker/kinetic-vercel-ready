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
`9.8.0` becomes `versionName 9.8.0` / `versionCode 90800`. Bump it before every
upload — Play refuses a `versionCode` it has already seen.

### Signed APKs from GitHub Actions

The `Applications` workflow signs the APK with a fixed key when two repository
secrets exist (Settings → Secrets and variables → Actions):

| Secret                      | Value                                    |
| --------------------------- | ---------------------------------------- |
| `KINETIC_KEYSTORE_BASE64`   | `base64 -w0 kinetic-release.jks` output  |
| `KINETIC_KEYSTORE_PASSWORD` | store and key password (alias `kinetic`) |

Every APK is then signed with the same certificate, so a new version installs
over the previous one and keeps the data. Without the secrets the workflow falls
back to a debug APK signed with a throwaway key (warning in the run summary).
Keep a copy of the `.jks` file and its password outside the repository.

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

## Health Connect, barcode camera, backups

- **Health Connect** (`src/lib/health.ts`, plugin `@capgo/capacitor-health`):
  opt-in from Profile → Santé. Writes weigh-ins (weight, body fat) and reads
  today's steps and last night's sleep to tick the "8 000 pas" and "Dormir 7 h"
  routine tasks. Requires Android 8+ (minSdk 26) and the Health Connect app
  (built in from Android 14). Health Connect shows the privacy policy from
  `health_connect_privacy_policy_url` in `res/values/strings.xml`.
- **Barcode camera** (`src/lib/barcode-camera.ts`, plugin
  `@capacitor-mlkit/barcode-scanning`): Google code scanner from Play services;
  the module downloads on first use.
- **Full backup**: the JSON export (version 2) now carries every app key
  (`src/lib/backup.ts`); importing it restores everything. Without a synced
  account, a reminder fires 30 days after the last backup.
- **Session reminder**: on the training days chosen in Profile (prefilled from
  the active program), skipped once a session is logged that day.

## Customizing the icon & splash

The launcher icon is vector (`res/drawable/ic_launcher_foreground.xml`, plus
`ic_launcher_monochrome.xml` for Android 13 themed icons). Legacy PNG icons and
splash screens are rendered from the same logo:

```bash
pnpm assets
```

Edit the SVG at the top of `scripts/generate-native-assets.mjs` to change the logo.

## Publishing

See [`docs/play-store.md`](docs/play-store.md) for the store listing text and the
release checklist.
