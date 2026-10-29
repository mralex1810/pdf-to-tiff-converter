"""Independently verify the marked stress-test ZIP using Pillow/libtiff."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import time
import zipfile
from PIL import Image, __version__ as pillow_version

parser = argparse.ArgumentParser()
parser.add_argument('zip_path', type=Path)
parser.add_argument('--report', type=Path)
args = parser.parse_args()
started = time.perf_counter()
results = []
with zipfile.ZipFile(args.zip_path) as archive:
    assert archive.testzip() is None, 'ZIP CRC failure'
    names = sorted(archive.namelist())
    assert len(names) == 100 and all(n.endswith('.tiff') for n in names)
    for number, name in enumerate(names, 1):
        match = re.search(r'_page_(\d+)\.tiff$', name)
        assert match and int(match[1]) == number, (number, name)
        data = archive.read(name)
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            assert image.n_frames == 1 and image.size == (3308, 4678)
            assert image.mode == '1' and image.tag_v2[258] == (1,)
            assert image.tag_v2[259] == 32773 and image.tag_v2[262] == 0
            assert tuple(map(float, image.info['dpi'])) == (400.0, 400.0)
            marker = 0
            for bit in range(8):
                point = (math.floor((21.5 + bit * 5) * 400 / 72), math.floor((841.89 - 8.5) * 400 / 72))
                black = image.getpixel(point) == 0
                if bit == 7:
                    assert black, ('marker sentinel', number)
                elif black:
                    marker |= 1 << bit
            assert marker == number, ('page order/content', number, marker)
            histogram = image.histogram()
            black_fraction = histogram[0] / (image.width * image.height)
            assert 0.01 < black_fraction < 0.5, ('blank/black page', number, black_fraction)
            results.append({'page': number, 'filename': name, 'width': image.width, 'height': image.height,
                            'bits': 1, 'compression': 32773, 'dpi': 400, 'marker': marker,
                            'blackPercent': round(black_fraction * 100, 3), 'sha256': hashlib.sha256(data).hexdigest()})
report = {'passed': True, 'decoder': 'Pillow/libtiff', 'pillowVersion': pillow_version,
          'libtiffVersion': Image.core.libtiff_version, 'verifiedPages': len(results),
          'zipBytes': args.zip_path.stat().st_size, 'zipSha256': hashlib.sha256(args.zip_path.read_bytes()).hexdigest(),
          'verificationMilliseconds': round((time.perf_counter() - started) * 1000), 'pages': results}
target = args.report or args.zip_path.parent / 'independent-verification.json'
target.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'pages'}, indent=2))
