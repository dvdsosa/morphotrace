#!/usr/bin/env bash
# Rebuilds the README media from scratch: synthetic specimens, the demo GIF and the still screenshots.
#   docs/media/build.sh
# Needs uv, ffmpeg, Python 3 and playwright-cli (Chromium). Output: docs/media/{demo.gif, overview.png,
# edit.png, subtract.png, exports.png}. Re-run it whenever the interface changes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MEDIA="$ROOT/docs/media"
WORK=$(mktemp -d)
PORT=$((20000 + RANDOM % 20000))

uv run --quiet "$MEDIA/make_specimens.py" >/dev/null
(cd "$ROOT" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; (cd "$WORK" && playwright-cli -s=media close >/dev/null 2>&1); rm -rf "$WORK"' EXIT
sleep 1
cd "$WORK"
playwright-cli -s=media open "http://127.0.0.1:$PORT/" >/dev/null
playwright-cli -s=media resize 1280 720 >/dev/null

echo "recording the demo…"
playwright-cli -s=media video-start "$WORK/demo.webm" --size 1280x720 >/dev/null
playwright-cli -s=media --raw run-code --filename="$MEDIA/record.e2e.js" >/dev/null
playwright-cli -s=media video-stop >/dev/null
ffmpeg -v error -i demo.webm -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 "$MEDIA/demo.gif" -y

echo "taking screenshots…"
playwright-cli -s=media goto "http://127.0.0.1:$PORT/" >/dev/null
playwright-cli -s=media --raw run-code --filename="$MEDIA/screens.e2e.js" >/dev/null
for f in overview edit subtract; do mv "$f.png" "$MEDIA/$f.png"; done

# image → exported mask, side by side
uv run --quiet --with pillow python - "$WORK/export.zip" "$MEDIA/specimens/Copepoda/copepod_01.png" "$MEDIA/exports.png" <<'EOF'
import io, sys, zipfile
from PIL import Image, ImageDraw, ImageFont
z = zipfile.ZipFile(sys.argv[1])
mask = Image.open(io.BytesIO(z.read("masks/Copepoda/copepod_01_mask.png"))).convert("RGB")
img = Image.open(sys.argv[2]).convert("RGB")
w, h, gap, top = img.width, img.height, 70, 34
out = Image.new("RGB", (2 * w + gap, h + top), "white")
out.paste(img, (0, top)); out.paste(mask, (w + gap, top))
d = ImageDraw.Draw(out)
try: font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
except OSError: font = ImageFont.load_default()
d.text((4, 4), "copepod_01.png", fill=(40, 40, 40), font=font)
d.text((w + gap + 4, 4), "masks/…/copepod_01_mask.png", fill=(40, 40, 40), font=font)
y = top + h // 2
d.line([(w + 14, y), (w + gap - 14, y)], fill=(255, 138, 0), width=5)
d.polygon([(w + gap - 10, y), (w + gap - 24, y - 10), (w + gap - 24, y + 10)], fill=(255, 138, 0))
out.save(sys.argv[3], optimize=True)
EOF
ls -la "$MEDIA"/*.gif "$MEDIA"/*.png | awk '{printf "%7.0f KB  %s\n", $5/1024, $9}'
