#!/bin/sh
# Rebuilds resources/iconset, icon.icns and icon.png from the two source SVGs.
#
# Two sources on purpose: resources/icon.svg carries the detailed mark for
# 128px and up, resources/icon-small.svg a bolder simplified one for 64px and
# below. One Electron process per source — a second offscreen load in the same
# process fails with ERR_FAILED.
set -e
cd "$(dirname "$0")/.."
PROJ="$PWD"; export PROJ

PROJ="$PROJ" SVG=icon.svg       SIZES=128,256,512,1024 npx electron scripts/render-icon.js
PROJ="$PROJ" SVG=icon-small.svg SIZES=16,32,64         npx electron scripts/render-icon.js

rm -rf resources/icon.iconset
mkdir -p resources/icon.iconset
set -- "16x16:icon_16x16" "32x32:icon_16x16@2x" "32x32:icon_32x32" "64x64:icon_32x32@2x" \
       "128x128:icon_128x128" "256x256:icon_128x128@2x" "256x256:icon_256x256" \
       "512x512:icon_256x256@2x" "512x512:icon_512x512" "1024x1024:icon_512x512@2x"
for pair in "$@"; do
  src=$(echo "$pair" | cut -d: -f1)
  dst=$(echo "$pair" | cut -d: -f2)
  cp "resources/iconset/icon_${src}.png" "resources/icon.iconset/${dst}.png"
done

if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns resources/icon.iconset -o resources/icon.icns
  echo "wrote resources/icon.icns"
else
  echo "iconutil not available (macOS only); skipped icon.icns" >&2
fi
cp resources/iconset/icon_512x512.png resources/icon.png
echo "wrote resources/icon.png"
