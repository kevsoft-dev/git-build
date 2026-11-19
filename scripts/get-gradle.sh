#!/usr/bin/env bash
# Unduh Gradle $1 dari beberapa sumber (resmi dulu, lalu mirror), verifikasi sha256 resmi.
# Cetak path binary gradle ke stdout; log ke stderr.
set -uo pipefail
V="$1"
DEST="${RUNNER_TEMP:-/tmp}/gradle-dist"
BIN="$DEST/gradle-$V/bin/gradle"
[ -x "$BIN" ] && { echo "$BIN"; exit 0; }
mkdir -p "$DEST"
ZIP="$DEST/gradle-$V-bin.zip"
URLS=(
  "https://services.gradle.org/distributions/gradle-$V-bin.zip"
  "https://downloads.gradle.org/distributions/gradle-$V-bin.zip"
  "https://github.com/gradle/gradle-distributions/releases/download/v$V.0/gradle-$V-bin.zip"
  "https://mirrors.cloud.tencent.com/gradle/gradle-$V-bin.zip"
  "https://mirrors.huaweicloud.com/gradle/gradle-$V-bin.zip"
)
SHA="$(curl -fsSL --retry 2 --connect-timeout 20 "https://services.gradle.org/distributions/gradle-$V-bin.zip.sha256" 2>/dev/null | tr -d '[:space:]')"
[ -z "$SHA" ] && echo "⚠️ sha256 resmi tidak bisa diambil, verifikasi dilewati" >&2
for u in "${URLS[@]}"; do
  echo "↓ $u" >&2
  rm -f "$ZIP"
  if curl -fsSL --retry 2 --connect-timeout 20 -o "$ZIP" "$u"; then
    if [ -n "$SHA" ] && ! echo "$SHA  $ZIP" | sha256sum -c --quiet - >/dev/null 2>&1; then
      echo "✗ checksum tidak cocok, coba sumber lain" >&2
      continue
    fi
    if unzip -q -o "$ZIP" -d "$DEST" && [ -x "$BIN" ]; then
      echo "$BIN"
      exit 0
    fi
  fi
done
echo "✗ Semua sumber Gradle $V gagal" >&2
exit 1
