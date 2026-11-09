#!/bin/sh
# Build the web app, sync Capacitor, build the debug APK and install it on the Pixel.
set -e
cd "$(dirname "$0")/.."
ADB="/c/Users/lilia/AppData/Local/Android/Sdk/platform-tools/adb.exe"
DEV="${DEV:-192.168.4.39:39227}"
npm run build >/dev/null
npx cap sync android >/dev/null
# Optimized (release) build: the native audio engine runs much faster than in a debuggable build.
# Fail loudly if the build fails (never reinstall a stale APK).
(cd android && ./gradlew.bat assembleRelease -q > ../build-android.log 2>&1) || { grep -E "error:|FAILURE|What went wrong" -A3 build-android.log | head -20; exit 1; }
APK=android/app/build/outputs/apk/release/app-release.apk
"$ADB" -s "$DEV" install -r "$APK" 2>/dev/null || {
  # switching from a debug-installed copy: same key, but reinstall if Android refuses
  "$ADB" -s "$DEV" install -r -d "$APK"
}
"$ADB" -s "$DEV" logcat -c
"$ADB" -s "$DEV" shell monkey -p com.oursound.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "installed + launched"
