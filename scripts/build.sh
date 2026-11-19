#!/usr/bin/env bash
# Build APK dengan beberapa kombinasi toolchain (sesuai tabel kompatibilitas resmi
# developer.android.com/build/releases/gradle-plugin) sampai ada yang berhasil.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p build-logs

#         Gradle | AGP    | Kotlin | mirror Maven
PROFILES=(
  "8.7|8.5.2|1.9.24|false"
  "8.9|8.7.3|2.0.21|false"
  "8.13|8.13.0|2.1.21|false"
  "8.7|8.5.2|1.9.24|true"
)
OUTAPK="app/build/outputs/apk/debug/app-debug.apk"
BT='```'
ok=0
n=0

summarize() {
  {
    echo "### ❌ Build APK gagal"
    echo "Berikut baris error dari tiap percobaan (log lengkap ada di Artifacts → build-logs)."
    for f in build-logs/*.log; do
      [ -f "$f" ] || continue
      echo "**$(basename "$f")**"
      echo "$BT"
      grep -E "^e: |error:|FAILURE:|What went wrong|Execution failed|Caused by:|AAPT|Could not |Unresolved|Failed to install|licen[cs]e|Unsupported|not found|gagal" "$f" | head -25
      echo "$BT"
    done
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  last="$(ls -1 build-logs/*.log 2>/dev/null | tail -n 1)"
  [ -n "$last" ] && grep -E "^e: |error:|What went wrong|Execution failed|Caused by:" "$last" | head -6 | while IFS= read -r l; do echo "::error::${l:0:300}"; done
}

for p in "${PROFILES[@]}"; do
  n=$((n+1))
  IFS='|' read -r GV AGP KT MIRROR <<< "$p"
  LOG="build-logs/attempt-$n-gradle$GV-agp$AGP.log"
  echo "::group::Percobaan $n: Gradle $GV | AGP $AGP | Kotlin $KT | mirror=$MIRROR"
  if ! GRADLE="$(bash scripts/get-gradle.sh "$GV")"; then
    echo "Gradle $GV gagal diunduh dari semua sumber" | tee "$LOG"
    echo "::endgroup::"
    continue
  fi
  if [ "$n" -ge 3 ] && [ -n "${SDKMANAGER:-}" ]; then
    "$SDKMANAGER" "build-tools;35.0.0" "platforms;android-36" >/dev/null 2>&1 || true
  fi
  EXTRA=()
  [ "$n" -gt 1 ] && EXTRA+=(--refresh-dependencies)
  rm -rf app/build build
  "$GRADLE" assembleDebug --no-daemon --stacktrace --console=plain ${EXTRA[@]+"${EXTRA[@]}"} \
    -PagpVersion="$AGP" -PkotlinVersion="$KT" -PuseMirrors="$MIRROR" \
    -PappName="$APP_NAME" -PappPackage="$PACKAGE_NAME" -PappVersion="$VERSION_NAME" \
    -PappCode="$VERSION_CODE" -PiconColor="${ICON_COLOR#\#}" 2>&1 | tee "$LOG"
  rc=${PIPESTATUS[0]}
  echo "::endgroup::"
  if [ "$rc" -eq 0 ] && [ -f "$OUTAPK" ]; then
    ok=1
    echo "✅ Berhasil pada percobaan $n (Gradle $GV, AGP $AGP, Kotlin $KT)"
    echo "### ✅ APK berhasil dibuat (percobaan $n: Gradle $GV, AGP $AGP, Kotlin $KT)" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    break
  fi
  echo "⚠️ Percobaan $n gagal (kode $rc), lanjut ke cadangan berikutnya"
  "$GRADLE" --stop >/dev/null 2>&1 || true
done

if [ "$ok" -ne 1 ]; then
  summarize
  exit 1
fi
