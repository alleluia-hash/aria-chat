#!/usr/bin/env bash
# Builds Aria.apk with the Android build-tools directly: no Gradle, no Android
# Studio, nothing to download beyond the SDK packages CI runners already have.
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$SDK" ]; then echo "ANDROID_SDK_ROOT is not set" >&2; exit 1; fi

BUILD_TOOLS="${BUILD_TOOLS:-34.0.0}"
PLATFORM="${PLATFORM:-android-34}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
OUT="${OUT:-$ROOT/package/out}"
mkdir -p "$OUT"

# The version lives in package/VERSION: "1.0.1" becomes versionName 1.0.1 and
# versionCode 10001, so each release sorts higher than the one before it.
VERSION_FILE="$ROOT/package/VERSION"
[ -f "$VERSION_FILE" ] || { echo "package/VERSION is missing" >&2; exit 1; }
VERSION_NAME="${VERSION_NAME:-$(tr -d ' \t\r\n' < "$VERSION_FILE")}"
IFS=. read -r V_MAJOR V_MINOR V_PATCH <<< "$VERSION_NAME" || true
V_MAJOR="${V_MAJOR:-0}"; V_MINOR="${V_MINOR:-0}"; V_PATCH="${V_PATCH:-0}"
VERSION_CODE="${VERSION_CODE:-$((10#$V_MAJOR * 10000 + 10#$V_MINOR * 100 + 10#$V_PATCH))}"
echo "Building Aria $VERSION_NAME (versionCode $VERSION_CODE)"

SDKMANAGER="$(ls -d "$SDK"/cmdline-tools/*/bin/sdkmanager 2>/dev/null | head -1 || true)"
if [ -n "$SDKMANAGER" ]; then
  yes | "$SDKMANAGER" --sdk_root="$SDK" "build-tools;${BUILD_TOOLS}" "platforms;${PLATFORM}" >/dev/null || true
fi

BT="$SDK/build-tools/$BUILD_TOOLS"
AJ="$SDK/platforms/$PLATFORM/android.jar"
[ -x "$BT/aapt2" ] || { echo "aapt2 not found in $BT" >&2; exit 1; }
[ -f "$AJ" ] || { echo "android.jar not found at $AJ" >&2; exit 1; }

mkdir -p "$WORK/res" "$WORK/assets/web" "$WORK/src" "$WORK/classes" "$WORK/dex" "$WORK/flat"
node "$ROOT/package/android/icon.js" "$WORK/res"

cp "$ROOT/index.html" "$ROOT/app.js" "$ROOT/styles.css" "$WORK/assets/web/"
cp "$ROOT/package/android/MainActivity.java" "$WORK/src/"
cp "$ROOT/package/android/AndroidManifest.xml" "$WORK/AndroidManifest.xml"

javac -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$AJ" -classpath "$AJ" \
  -d "$WORK/classes" "$WORK/src/MainActivity.java" 2>&1 | grep -v '^warning:' || true

java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --min-api 24 --lib "$AJ" \
  --output "$WORK/dex" $(find "$WORK/classes" -name '*.class')

"$BT/aapt2" compile --dir "$WORK/res" -o "$WORK/res.zip"
unzip -q -o "$WORK/res.zip" -d "$WORK/flat"
"$BT/aapt2" link -o "$WORK/base.apk" -I "$AJ" \
  --manifest "$WORK/AndroidManifest.xml" -A "$WORK/assets" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  $(find "$WORK/flat" -name '*.flat')

(cd "$WORK/dex" && zip -q -X "$WORK/base.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$WORK/base.apk" "$WORK/aligned.apk"

PASS="${APKSIGNER_PASS:-aria-chat-2026}"
KS="$ROOT/package/android/aria-upload.jks"
if [ ! -f "$KS" ]; then
  KS="$WORK/aria.jks"
  keytool -genkeypair -keystore "$KS" -alias aria -keyalg RSA -keysize 2048 \
    -validity 10950 -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=Aria, O=Aria, C=IT" >/dev/null 2>&1
fi

"$BT/apksigner" sign --ks "$KS" --ks-key-alias aria \
  --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --out "$OUT/Aria.apk" "$WORK/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/Aria.apk" | head -3
ls -lh "$OUT/Aria.apk"
echo "Built Aria $VERSION_NAME (versionCode $VERSION_CODE)"
