"""Download the full-body portrait (skin/<id>b.png) of every skin in data/skins-catalog.json,
resize it to 720 px wide and store it as public/assets/char/skin_portrait/<id>.png.

The catalogue's skins only carry a 180x180 avatar, so the 1:2 tile of the skin picker had no picture to
fill it. Source: yuanyan3060/ArknightsGameResource, file name = skin id with '@' -> '_' plus 'b.png'.

Usage:
  python tools/fetch-skin-portraits.py [--dry-run] [--workers=8] [--width=720]
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow is required: pip install pillow')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, 'data', 'skins-catalog.json')
OUT_DIR = os.path.join(ROOT, 'public', 'assets', 'char', 'skin_portrait')
TMP_DIR = os.path.join(ROOT, '.cache', 'skin-portrait-raw')
BASE = 'https://gh-proxy.com/https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/skin/'

DRY = '--dry-run' in sys.argv
WORKERS = 8
WIDTH = 720
for a in sys.argv:
    if a.startswith('--workers='):
        WORKERS = int(a.split('=', 1)[1])
    if a.startswith('--width='):
        WIDTH = int(a.split('=', 1)[1])

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch(skin_id):
    """skin_id like char_1014_nearl2@epoque#17 -> (skin_id, saved path or None, reason)"""
    # '@' and '#' both become '_' in the stored name: '#' would start a URL fragment, so the browser
    # would request a truncated path and get a 404
    out_name = skin_id.replace('@', '_').replace('#', '_') + '.png'
    dest = os.path.join(OUT_DIR, out_name)
    if os.path.isfile(dest):
        return (skin_id, dest, 'skip')
    raw_name = skin_id.replace('@', '_') + 'b.png'
    url = BASE + urllib.parse.quote(raw_name)
    try:
        # keep the download in memory: writing it out first and deleting it trips the sandbox's
        # bulk-delete guard once a run has removed a few dozen files
        req = urllib.request.Request(url, headers={'User-Agent': 'curl'})
        data = opener.open(req, timeout=120).read()
        im = Image.open(io.BytesIO(data))
        im.load()
        w, h = im.size
        if w > WIDTH:
            im = im.resize((WIDTH, max(1, round(h * WIDTH / w))), Image.LANCZOS)
        if im.mode not in ('RGB', 'RGBA'):
            im = im.convert('RGBA')
        os.makedirs(OUT_DIR, exist_ok=True)
        im.save(dest, 'PNG', optimize=True)
        return (skin_id, dest, '%dx%d -> %d KB' % (w, h, os.path.getsize(dest) // 1024))
    except Exception as exc:  # 404, decode error, timeout
        return (skin_id, None, type(exc).__name__ + ': ' + str(exc)[:80])


def main():
    cat = json.load(open(CATALOG, encoding='utf-8'))
    ids = [sid for rec in cat['chars'].values() for sid in rec]
    print('skins: %d, output %d px wide, workers %d' % (len(ids), WIDTH, WORKERS))
    if DRY:
        for sid in ids[:5]:
            print('  ', BASE + urllib.parse.quote(sid.replace('@', '_') + 'b.png'))
        print('dry run: nothing written')
        return
    ok = skip = fail = 0
    total = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for i, (sid, dest, info) in enumerate(pool.map(fetch, ids), 1):
            if dest is None:
                fail += 1
                print('  FAIL %-40s %s' % (sid, info))
            elif info == 'skip':
                skip += 1
            else:
                ok += 1
                total += os.path.getsize(dest)
            if i % 25 == 0:
                print('  %d/%d ok=%d skip=%d fail=%d %.1f MB' % (i, len(ids), ok, skip, fail, total / 1048576))
    print('done: %d saved, %d skipped, %d failed, %.1f MB total' % (ok, skip, fail, total / 1048576))


main()
