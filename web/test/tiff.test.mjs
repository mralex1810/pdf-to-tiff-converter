import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeTiff } from '../src/tiff.js';

function page(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

function directories(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let offset = view.getUint32(4, true); offset;) {
    const count = view.getUint16(offset, true);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = view.getUint16(entry, true);
      const type = view.getUint16(entry + 2, true);
      const length = view.getUint32(entry + 4, true);
      const elementSize = type === 3 ? 2 : 4;
      const byteLength = length * (type === 5 ? 8 : elementSize);
      const valueOffset = byteLength > 4 ? view.getUint32(entry + 8, true) : entry + 8;
      tags[tag] = Array.from({ length: length * (type === 5 ? 2 : 1) }, (_, j) => type === 3 ? view.getUint16(valueOffset + j * 2, true) : view.getUint32(valueOffset + j * 4, true));
    }
    result.push(tags);
    offset = view.getUint32(offset + 2 + count * 12, true);
    assert.ok(result.length < 100, 'IFD chain must terminate');
  }
  return result;
}

test('writes TIFF metadata, page chain, strip tables, and rational DPI', () => {
  const first = page(1654, 40, () => [0, 0, 0, 255]);
  const second = page(13, 9, () => [255, 255, 255, 255]);
  const encoded = encodeTiff([first, second], { dpi: 300 });
  assert.deepEqual([...encoded.slice(0, 4)], [73, 73, 42, 0]);
  const [a, b] = directories(encoded);
  assert.deepEqual(a[256], [1654]);
  assert.deepEqual(a[257], [40]);
  assert.deepEqual(a[258], [8, 8, 8]);
  assert.deepEqual(a[259], [5]);
  assert.deepEqual(a[282], [300, 1]);
  assert.deepEqual(a[283], [300, 1]);
  assert.deepEqual(a[296], [2]);
  assert.deepEqual(a[297], [0, 2]);
  assert.deepEqual(b[297], [1, 2]);
  assert.ok(a[273].length > 1);
  assert.equal(a[273].length, a[279].length);
  assert.ok(encoded.length < 3000, 'LZW must compress repeated pixels');
});

test('bitonal packs odd-width rows MSB-first with white padding', () => {
  const encoded = encodeTiff([page(13, 2, (x, y) => x === y || x === 12 ? [0, 0, 0, 255] : [255, 255, 255, 255])], { colorMode: 'blackAndWhite', compression: 'none' });
  const [tags] = directories(encoded);
  assert.deepEqual(tags[258], [1]);
  assert.deepEqual(tags[262], [0]);
  assert.deepEqual([...encoded.slice(tags[273][0])], [0x80, 0x08, 0x40, 0x08]);
});

test('composites alpha against white and applies grayscale and threshold', () => {
  const input = page(3, 1, x => [[0, 0, 0, 0], [0, 0, 0, 128], [255, 0, 0, 255]][x]);
  const gray = encodeTiff([input], { colorMode: 'grayscale', compression: 'none' });
  assert.deepEqual([...gray.slice(directories(gray)[0][273][0])], [255, 127, 76]);
  const bitonal = encodeTiff([input], { colorMode: 'bitonal', compression: 'none', threshold: 127 });
  assert.deepEqual([...bitonal.slice(directories(bitonal)[0][273][0])], [0x20]);
});

test('rejects invalid inputs instead of writing a misleading TIFF', () => {
  const valid = page(1, 1, () => [0, 0, 0, 255]);
  assert.throws(() => encodeTiff([]), /At least one/);
  assert.throws(() => encodeTiff([{ width: 0, height: 1, data: new Uint8Array() }]), /Width/);
  assert.throws(() => encodeTiff([{ ...valid, data: new Uint8Array(3) }]), /RGBA/);
  assert.throws(() => encodeTiff([valid], { dpi: 1.5 }), /DPI/);
  assert.throws(() => encodeTiff([valid], { compression: 'group4' }), /compression/);
  assert.throws(() => encodeTiff([valid], { threshold: 256 }), /Threshold/);
});

const pythonCandidates = [process.env.TIFF_TEST_PYTHON, 'python3', 'python'].filter(Boolean);
const python = pythonCandidates.find(command => spawnSync(command, ['-c', 'from PIL import Image'], { encoding: 'utf8' }).status === 0);

test('independent Pillow/libtiff decode matches every pixel for LZW/None, modes, strips, and multiple pages', { skip: python ? false : 'Install Python Pillow or set TIFF_TEST_PYTHON to enable independent decoding' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-tiff-test-'));
  try {
    let random = 0x12345678;
    const next = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return random & 255;
    };
    // Noise fills and clears all 9/10/11/12-bit dictionaries within a strip.
    const noisy = page(369, 257, () => [next(), next(), next(), 255]);
    const odd = page(13, 71, (x, y) => [(x * 19 + y * 7) & 255, (x * 31 + y * 17) & 255, (x * 11 + y * 23) & 255, 255]);
    const manifest = [];
    for (const colorMode of ['color', 'grayscale', 'bitonal']) {
      for (const compression of ['lzw', 'none']) {
        const name = `${colorMode}-${compression}`;
        const pages = [noisy, odd];
        if (colorMode === 'grayscale' && compression === 'lzw') {
          // Vary the final-code position around width transitions and resets;
          // EOI can need a wider code even when the final data code did not.
          for (const start of [245, 760, 1780, 3820]) {
            for (let width = start; width < start + 40; width++) {
              pages.push(page(width, 1, () => {
                const value = next();
                return [value, value, value, 255];
              }));
            }
          }
        }
        writeFileSync(join(directory, `${name}.tiff`), encodeTiff(pages, { colorMode, compression, dpi: 200, threshold: 180 }));
        const expected = pages.map((input, index) => {
          const data = new Uint8Array(input.width * input.height * (colorMode === 'color' ? 3 : 1));
          let out = 0;
          for (let i = 0; i < input.data.length; i += 4) {
            const rgb = [...input.data.slice(i, i + 3)];
            if (colorMode === 'color') for (const value of rgb) data[out++] = value;
            else {
              const gray = Math.round((rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000);
              data[out++] = colorMode === 'grayscale' ? gray : gray < 180 ? 0 : 255;
            }
          }
          const path = `${name}-${index}.raw`;
          writeFileSync(join(directory, path), data);
          return { path, width: input.width, height: input.height };
        });
        manifest.push({ path: `${name}.tiff`, mode: colorMode === 'color' ? 'RGB' : 'L', pages: expected });
      }
    }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const script = `
import json, os, sys
from PIL import Image
root = sys.argv[1]
manifest = json.load(open(os.path.join(root, 'manifest.json')))
for case in manifest:
    image = Image.open(os.path.join(root, case['path']))
    assert image.n_frames == len(case['pages']), case['path']
    assert tuple(image.info['dpi']) == (200, 200), image.info
    for index, page in enumerate(case['pages']):
        image.seek(index)
        assert image.size == (page['width'], page['height'])
        actual = image.convert(case['mode']).tobytes()
        expected = open(os.path.join(root, page['path']), 'rb').read()
        assert actual == expected, (case['path'], index, len(actual), len(expected))
print('Pillow decoded all modes, compressions and pages with exact pixel equality')
`;
    const result = spawnSync(python, ['-c', script, directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
