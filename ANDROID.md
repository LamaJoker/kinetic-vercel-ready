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

2. Create `apps/web/android/keystore.properties`:

   ```properties
   storeFile=../../kinetic-release.keystore
   storePassword=YOUR_PASSWORD
   keyAlias=kinetic
   keyPassword=YOUR_PASSWORD
   ```

3. Edit `apps/web/android/app/build.gradle` to load the keystore (signing config block).

4. Run:

   ```bash
   pnpm android:build:release
   ```

   APK output: `apps/web/android/app/build/outputs/apk/release/app-release.apk`

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

## Customizing the icon & splash

Replace icons in `apps/web/android/app/src/main/res/mipmap-*/` and the splash drawable in `drawable*/splash.png`. Tools like [`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets) automate this:

```bash
pnpm dlx @capacitor/assets generate --android \
  --iconBackgroundColor "#0b0f1a" \
  --splashBackgroundColor "#0b0f1a"
```

(Place a `1024x1024` icon and `2732x2732` splash in `apps/web/assets/` first.)
