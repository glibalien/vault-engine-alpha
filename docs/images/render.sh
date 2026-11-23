#!/usr/bin/env bash
# Render architecture.html to the dark + light PNGs used by the root README.
#
#   ./docs/images/render.sh
#
# Firefox headless, full-page capture. The page sets `zoom: 2` and is authored
# at 1440 CSS px, so a 2880-wide window yields a 2880-wide 2x PNG.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

command -v firefox >/dev/null || { echo "firefox not found" >&2; exit 1; }

# architecture.html self-hosts Geist from ./fonts; the themed copies below live
# in $work, so the font directory has to come with them.
cp -r "$here/fonts" "$work/fonts"

# Software rendering: headless Firefox can't map a GPU framebuffer here.
export MOZ_ENABLE_WAYLAND=0 LIBGL_ALWAYS_SOFTWARE=1 MOZ_ACCELERATED=0 MOZ_WEBRENDER=0

shot() {
  local theme="$1" out="$2" src="$work/$1.html"
  if [ "$theme" = light ]; then
    sed 's/<html lang="en">/<html lang="en" data-theme="light">/' "$here/architecture.html" > "$src"
  else
    cp "$here/architecture.html" "$src"
  fi
  rm -rf "$work/prof-$theme" && mkdir -p "$work/prof-$theme"
  firefox --headless --profile "$work/prof-$theme" \
          --window-size=2880 --screenshot "$out" "file://$src" >/dev/null 2>&1
  echo "  $(basename "$out")  $(python3 -c "from PIL import Image;print('x'.join(map(str,Image.open('$out').size)))" 2>/dev/null || echo '?')"
}

echo "rendering:"
shot dark  "$here/architecture-dark.png"
shot light "$here/architecture-light.png"

# Strip metadata and recompress; these ship in git. The page is fully opaque, so
# dropping the alpha channel is free. Whichever tool is on hand wins — if none is,
# the renders are still correct, just fatter.
optimize() {
  local f="$1"
  if command -v magick >/dev/null; then
    magick "$f" -strip -alpha off -define png:compression-level=9 "$f"
  elif command -v convert >/dev/null; then
    convert "$f" -strip -alpha off -define png:compression-level=9 "$f"
  elif command -v ffmpeg >/dev/null; then
    # ffmpeg picks the muxer from the extension, so the temp name must end in .png
    ffmpeg -loglevel error -y -i "$f" -pix_fmt rgb24 -compression_level 100 "${f%.png}.opt.png" \
      && mv "${f%.png}.opt.png" "$f"
  else
    return 0
  fi
  command -v oxipng >/dev/null && oxipng -q -o max --strip safe "$f"
  return 0
}

echo "optimizing:"
for f in "$here/architecture-dark.png" "$here/architecture-light.png"; do
  before=$(stat -c%s "$f"); optimize "$f"; after=$(stat -c%s "$f")
  echo "  $(basename "$f")  $((before/1024))K -> $((after/1024))K"
done

echo "done."
