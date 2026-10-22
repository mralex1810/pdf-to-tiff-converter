import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(repo, 'artifacts/html-tests');
const html = path.join(repo, 'artifacts/html/PdfToTiff.html');
const browserName = process.env.PDF_TO_TIFF_BROWSER || 'chromium';
await mkdir(output, { recursive: true });
const copiedDirectory = path.join(output, 'Проверка HTML с пробелами');
await mkdir(copiedDirectory, { recursive: true });
const copiedHtml = path.join(copiedDirectory, 'PdfToTiff.html');
await copyFile(html, copiedHtml);
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, browser: browserName,
  htmlSha256: createHash('sha256').update(await readFile(html)).digest('hex'),
  fileUrl: pathToFileURL(copiedHtml).href, offline: true, networkRequests: [],
  pageErrors: [], consoleErrors: [], tests: [], downloads: [],
};
let phase = 'startup';
let browser;

// Generate real PDFs with valid cross-reference tables. These fixtures have no
// font dependency; the form tests the stored appearance rather than text layout.
function pdfObjects(objects) {
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`;
const manyPages = count => pdfObjects([
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
  ...Array.from({ length: count }, (_, i) => [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents ${4 + i * 2} 0 R >>`,
    stream('1 0 0 rg 0 0 36 36 re f\n'),
  ]).flat(),
]);
const appearance = '1 0 0 rg 0 0 48 48 re f\n';
const formPdf = pdfObjects([
  '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>',
  stream(''),
  '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Filled field) /V (Saved answer) /Rect [12 12 60 60] /P 3 0 R /F 4 /AP << /N 7 0 R >> >>',
  '<< /Fields [5 0 R] /NeedAppearances false >>',
  `<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 48 48] /Resources << >> /Length ${Buffer.byteLength(appearance)} >>\nstream\n${appearance}endstream`,
]);
const xfaPdf = pdfObjects([
  '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>',
  stream(''),
  '<< /Fields [] /XFA 6 0 R >>',
  stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"/></template></xdp:xdp>'),
]);
// Synthetic blank 72pt PDF, encrypted with the test-only password
// "fixture-password" using pypdf. Embedded so browser tests need no Python.
const passwordPdf = Buffer.from('JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDNmYTc2ZTgzMmY+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA3MiA3MiBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1YgMgovUiAzCi9MZW5ndGggMTI4Ci9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPGM5NGJmZTY2MGE0NmIzZjlkNzVjYmMwZGQxMGQ4NTU3YzY2N2M2MTljZDYwNzYxYTg3YjQ2YTlhYzA4NGU1NjY+Ci9VIDxiOWNhOWI5Zjg3MjI0NGE3M2E5YjI3YjI3MTFmMzliZDI4YmY0ZTVlNGU3NThhNDE2NDAwNGU1NmZmZmEwMTA4Pgo+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNTkgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAowMDAwMDAwMTY3IDAwMDAwIG4gCjAwMDAwMDAyNTkgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDw2NDY2NjM2MTY2MzUzNDMyMzczOTMwMzMzMjMwMzY2NDY0MzEzMTM0MzQzMTY0MzA2MjM1NjI2MTM5MzYzMTYyPiA8NjQ2NjYzNjE2NjM1MzQzMjM3MzkzMDMzMzIzMDM2NjQ2NDMxMzEzNDM0MzE2NDMwNjIzNTYyNjEzOTM2MzE2Mj4gXQovRW5jcnlwdCA1IDAgUgo+PgpzdGFydHhyZWYKNDc0CiUlRU9GCg==', 'base64');

// An independent metadata reader; it does not import the application's encoder.
function tiffDirectories(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(0, true), 0x4949, 'little-endian TIFF header');
  assert.equal(view.getUint16(2, true), 42, 'classic TIFF magic');
  const directories = [];
  const visited = new Set();
  for (let offset = view.getUint32(4, true); offset;) {
    assert.ok(!visited.has(offset), 'TIFF directory chain must not loop');
    visited.add(offset);
    assert.ok(offset + 6 <= bytes.byteLength, 'TIFF directory is within the file');
    const count = view.getUint16(offset, true);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = view.getUint16(entry, true);
      const type = view.getUint16(entry + 2, true);
      const length = view.getUint32(entry + 4, true);
      const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type];
      assert.ok(size, `known TIFF type ${type}`);
      const start = length * size > 4 ? view.getUint32(entry + 8, true) : entry + 8;
      assert.ok(start + length * size <= bytes.byteLength, `tag ${tag} is within the file`);
      tags[tag] = Array.from({ length: type === 5 ? length * 2 : length }, (_, j) =>
        type === 3 ? view.getUint16(start + j * 2, true) : type === 4 || type === 5
          ? view.getUint32(start + j * 4, true) : view.getUint8(start + j));
    }
    directories.push(tags);
    offset = view.getUint32(offset + 2 + count * 12, true);
  }
  return directories;
}

function checkTags(tags, { width, height, bits, samples, compression, dpi, photometric }) {
  assert.deepEqual(tags[256], [width]);
  assert.deepEqual(tags[257], [height]);
  assert.deepEqual(tags[258], Array(samples).fill(bits));
  assert.deepEqual(tags[259], [compression]);
  assert.deepEqual(tags[262], [photometric]);
  assert.deepEqual(tags[277], [samples]);
  assert.deepEqual(tags[282], [dpi, 1]);
  assert.deepEqual(tags[283], [dpi, 1]);
  assert.deepEqual(tags[296], [2]);
  assert.equal(tags[273].length, tags[279].length);
}

function uncompressedPixel(bytes, tags, x, y) {
  assert.deepEqual(tags[259], [1]);
  assert.deepEqual(tags[258], Array(tags[277][0]).fill(8));
  const strip = Math.floor(y / tags[278][0]);
  const start = tags[273][strip] + ((y % tags[278][0]) * tags[256][0] + x) * tags[277][0];
  return [...bytes.slice(start, start + tags[277][0])];
}

async function test(name, run) {
  phase = name;
  const started = Date.now();
  try { await run(); report.tests.push({ name, passed: true, milliseconds: Date.now() - started }); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack, milliseconds: Date.now() - started }); throw error; }
}

try {
  assert.ok(['chromium', 'chrome', 'msedge'].includes(browserName), 'PDF_TO_TIFF_BROWSER must be chromium, chrome or msedge');
  browser = await chromium.launch({ headless: true, ...(browserName === 'chromium' ? {} : { channel: browserName }) });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1100, height: 1100 } });
  context.on('request', request => {
    if (/^https?:/i.test(request.url())) report.networkRequests.push({ phase, url: request.url(), resourceType: request.resourceType() });
  });
  await context.route(/^https?:/i, route => route.abort('internetdisconnected'));
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text() });
  });
  let downloadEvents = 0;
  page.on('download', () => downloadEvents++);
  await page.goto(report.fileUrl, { waitUntil: 'load' });
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  await page.locator('#convert').waitFor();

  async function selectPdf(file) {
    await page.locator('#pdf-file').setInputFiles(file);
    await page.waitForFunction(() => !document.getElementById('convert').disabled);
  }
  async function settings({ dpi = '200', color = 'color', compression = 'lzw', outputMode = 'separate' } = {}) {
    await page.locator('#dpi').selectOption(dpi);
    await page.locator('#color-mode').selectOption(color);
    await page.locator('#compression').selectOption(compression);
    await page.locator('#output-mode').selectOption(outputMode);
  }
  async function convertAndSave(label) {
    const before = downloadEvents;
    await page.locator('#convert').click();
    await page.locator('#download').waitFor({ state: 'visible', timeout: 120_000 });
    await page.waitForFunction(() => !document.getElementById('convert').disabled);
    assert.equal(downloadEvents, before, 'saving must require the explicit download button');
    assert.match(await page.locator('#status').textContent(), /^Готово\./);
    const pending = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    const destination = path.join(output, `${label}-${download.suggestedFilename()}`);
    await download.saveAs(destination);
    const bytes = new Uint8Array(await readFile(destination));
    report.downloads.push({ test: phase, path: path.relative(repo, destination), name: download.suggestedFilename(), bytes: bytes.byteLength });
    return bytes;
  }

  await test('defaults-and-separate-tiffs', async () => {
    assert.equal(await page.locator('#dpi').inputValue(), '400');
    assert.equal(await page.locator('#color-mode').inputValue(), 'bw');
    assert.equal(await page.locator('#compression').inputValue(), 'packbits');
    assert.ok(await page.locator('#threshold').isVisible());
    assert.ok(await page.locator('#threshold').isEnabled());
    assert.equal(await page.locator('#output-mode').inputValue(), 'separate');
    assert.ok(await page.locator('#convert').isDisabled());
    await selectPdf(path.join(repo, 'tests/fixtures/two-pages.pdf'));
    const files = unzipSync(await convertAndSave('defaults'));
    const names = Object.keys(files).sort();
    assert.deepEqual(names, ['two-pages_page_001.tiff', 'two-pages_page_002.tiff']);
    for (let index = 0; index < names.length; index++) {
      const directories = tiffDirectories(files[names[index]]);
      assert.equal(directories.length, 1, 'each downloaded TIFF is single-page');
      checkTags(directories[0], { width: 800, height: 1200, bits: 1, samples: 1, compression: 32773, dpi: 400, photometric: 0 });
    }
  });

  await test('multipage-bitonal-400dpi-packbits', async () => {
    await settings({ dpi: '400', color: 'bw', compression: 'packbits', outputMode: 'multi' });
    const directories = tiffDirectories(await convertAndSave('multipage-packbits'));
    assert.equal(directories.length, 2);
    for (const tags of directories) checkTags(tags, { width: 800, height: 1200, bits: 1, samples: 1, compression: 32773, dpi: 400, photometric: 0 });
  });

  await test('multipage-grayscale-300dpi-uncompressed', async () => {
    await settings({ dpi: '300', color: 'grayscale', compression: 'none', outputMode: 'multi' });
    const bytes = await convertAndSave('grayscale');
    const directories = tiffDirectories(bytes);
    assert.equal(directories.length, 2);
    for (let index = 0; index < directories.length; index++) {
      checkTags(directories[index], { width: 600, height: 900, bits: 8, samples: 1, compression: 1, dpi: 300, photometric: 1 });
      assert.deepEqual(directories[index][297], [index, 2]);
    }
    assert.deepEqual(uncompressedPixel(bytes, directories[0], 100, 100), [98], 'RGB(51,102,204) rectangle becomes luminance 98');
    assert.deepEqual(uncompressedPixel(bytes, directories[0], 30, 30), [255], 'empty background is white');
  });

  await test('bitonal-600dpi-lzw', async () => {
    await settings({ dpi: '600', color: 'bw', outputMode: 'multi' });
    assert.ok(await page.locator('#threshold').isVisible());
    assert.equal(await page.locator('#threshold').inputValue(), '180');
    await page.locator('#threshold').focus();
    await page.locator('#threshold').press('ArrowLeft');
    assert.equal(await page.locator('#threshold-value').textContent(), '179');
    const directories = tiffDirectories(await convertAndSave('bitonal'));
    assert.equal(directories.length, 2);
    for (let index = 0; index < directories.length; index++) {
      checkTags(directories[index], { width: 1200, height: 1800, bits: 1, samples: 1, compression: 5, dpi: 600, photometric: 0 });
    }
  });

  await test('saved-acroform-appearance', async () => {
    const fixture = path.join(output, 'saved-form.pdf');
    await writeFile(fixture, formPdf);
    await selectPdf(fixture);
    await settings({ compression: 'none', outputMode: 'multi' });
    const bytes = await convertAndSave('acroform');
    const directories = tiffDirectories(bytes);
    assert.equal(directories.length, 1);
    checkTags(directories[0], { width: 200, height: 200, bits: 8, samples: 3, compression: 1, dpi: 200, photometric: 2 });
    assert.deepEqual(uncompressedPixel(bytes, directories[0], 100, 100), [255, 0, 0], 'stored annotation appearance must render');
    assert.deepEqual(uncompressedPixel(bytes, directories[0], 5, 5), [255, 255, 255]);
  });

  await test('unembedded-font-offline-fallback', async () => {
    const fontPdf = pdfObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 216 72] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      stream('BT /F1 16 Tf 12 30 Td (Offline font rendering) Tj ET\n'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Arial /Encoding /WinAnsiEncoding >>',
    ]);
    // Model a computer without Arial even when CI has the font installed.
    // The production application has no test hook: only this browser's standard
    // FontFace API is wrapped, and restored immediately after the conversion.
    await page.evaluate(() => {
      window.originalTestFontFace = window.FontFace;
      window.testFallbackFonts = 0;
      window.FontFace = class extends window.originalTestFontFace {
        constructor(family, source, descriptors) {
          if (typeof source === 'string') {
            const withoutLocal = source.replace(/local\([^)]*\)\s*,?\s*/g, '');
            if (withoutLocal.includes('data:font/ttf;base64,')) {
              source = withoutLocal;
              window.testFallbackFonts++;
            }
          }
          super(family, source, descriptors);
        }
      };
    });
    try {
      await selectPdf({ name: 'unembedded-arial.pdf', mimeType: 'application/pdf', buffer: fontPdf });
      await settings({ color: 'grayscale', compression: 'none', outputMode: 'multi' });
      const bytes = await convertAndSave('font-fallback');
      const [tags] = tiffDirectories(bytes);
      checkTags(tags, { width: 600, height: 200, bits: 8, samples: 1, compression: 1, dpi: 200, photometric: 1 });
      let darkPixels = 0;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 600; x++) {
        if (uncompressedPixel(bytes, tags, x, y)[0] < 128) darkPixels++;
      }
      assert.ok(darkPixels > 500, 'the text must render as visible dark pixels');
      assert.ok(await page.evaluate(() => window.testFallbackFonts > 0), 'the embedded font fallback must be exercised');
    } finally {
      await page.evaluate(() => {
        window.FontFace = window.originalTestFontFace;
        delete window.originalTestFontFace;
        delete window.testFallbackFonts;
      });
    }
  });

  await test('page-rotation', async () => {
    const rotated = pdfObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 72] /Rotate 90 /Resources << >> /Contents 4 0 R >>',
      stream('1 0 0 rg 0 0 72 72 re f\n'),
    ]);
    await selectPdf({ name: 'rotated.pdf', mimeType: 'application/pdf', buffer: rotated });
    await settings({ compression: 'none', outputMode: 'multi' });
    const bytes = await convertAndSave('rotation');
    const [tags] = tiffDirectories(bytes);
    checkTags(tags, { width: 200, height: 400, bits: 8, samples: 3, compression: 1, dpi: 200, photometric: 2 });
    assert.deepEqual(uncompressedPixel(bytes, tags, 100, 100), [255, 0, 0]);
    assert.deepEqual(uncompressedPixel(bytes, tags, 100, 300), [255, 255, 255]);
  });

  await test('jpeg2000-and-ccitt-image-codecs', async () => {
    await selectPdf(path.join(repo, 'tests/fixtures/codec-images.pdf'));
    await settings({ compression: 'none', outputMode: 'multi' });
    const bytes = await convertAndSave('image-codecs');
    const directories = tiffDirectories(bytes);
    assert.equal(directories.length, 2);
    for (const tags of directories) checkTags(tags, { width: 200, height: 200, bits: 8, samples: 3, compression: 1, dpi: 200, photometric: 2 });
    const points = [[50, 50], [150, 50], [50, 150], [150, 150]];
    const expected = [
      [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]],
      [[0, 0, 0], [255, 255, 255], [255, 255, 255], [0, 0, 0]],
    ];
    for (let p = 0; p < 2; p++) for (let i = 0; i < points.length; i++) {
      assert.deepEqual(uncompressedPixel(bytes, directories[p], ...points[i]), expected[p][i], `decoded image page ${p + 1}, quadrant ${i + 1}`);
    }
  });

  await test('invalid-pdf', async () => {
    await selectPdf({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nthis is invalid\n') });
    await page.locator('#convert').click();
    await page.waitForFunction(() => !document.getElementById('convert').disabled && !document.getElementById('feedback').hidden && document.getElementById('feedback').classList.contains('error'));
    assert.match(await page.locator('#status').textContent(), /Не удалось прочитать PDF/);
    assert.ok(await page.locator('#download').isHidden());
  });

  await test('password-rejection', async () => {
    await selectPdf({ name: 'password.pdf', mimeType: 'application/pdf', buffer: passwordPdf });
    await page.locator('#convert').click();
    await page.waitForFunction(() => !document.getElementById('convert').disabled && document.getElementById('feedback').classList.contains('error'));
    assert.match(await page.locator('#status').textContent(), /паролем/);
    assert.ok(await page.locator('#download').isHidden());
  });

  await test('xfa-rejection', async () => {
    await selectPdf({ name: 'unsupported-xfa.pdf', mimeType: 'application/pdf', buffer: xfaPdf });
    await page.locator('#convert').click();
    await page.waitForFunction(() => !document.getElementById('convert').disabled && document.getElementById('feedback').classList.contains('error'));
    assert.match(await page.locator('#status').textContent(), /XFA/);
    assert.ok(await page.locator('#download').isHidden());
  });

  await test('cancellation-and-recovery', async () => {
    const fixture = path.join(output, 'many-pages.pdf');
    await writeFile(fixture, manyPages(100));
    await selectPdf(fixture);
    await settings({ dpi: '600' });
    await page.locator('#convert').click();
    await page.waitForFunction(() => {
      const progress = document.getElementById('progress');
      return progress.value > 0 && progress.value < 90 && !document.getElementById('cancel').hidden;
    });
    await page.locator('#cancel').click();
    await page.waitForFunction(() => !document.getElementById('convert').disabled);
    assert.match(await page.locator('#status').textContent(), /^Конвертация отменена/);
    assert.ok(await page.locator('#download').isHidden());
    await selectPdf(path.join(repo, 'tests/fixtures/two-pages.pdf'));
    await settings();
    assert.equal(Object.keys(unzipSync(await convertAndSave('recovery'))).length, 2);
  });

  if (process.env.PDF_TO_TIFF_SAMPLE) await test('user-sample-offline', async () => {
    await selectPdf(path.resolve(process.env.PDF_TO_TIFF_SAMPLE));
    await settings({ dpi: '400', color: 'bw', compression: 'packbits' });
    const files = unzipSync(await convertAndSave('sample'));
    assert.ok(Object.keys(files).length > 0);
    report.samplePages = Object.values(files).map(bytes => {
      const directories = tiffDirectories(bytes);
      assert.equal(directories.length, 1);
      const tags = directories[0];
      assert.deepEqual(tags[259], [32773]);
      assert.deepEqual(tags[258], [1]);
      assert.deepEqual(tags[282], [400, 1]);
      return { width: tags[256][0], height: tags[257][0], bytes: bytes.byteLength };
    });
  });

  await page.screenshot({ path: path.join(output, 'browser.png'), fullPage: true });
  assert.deepEqual(report.networkRequests, [], 'no HTTP(S) request may be attempted');
  assert.deepEqual(report.pageErrors, [], 'no uncaught browser error');
  assert.deepEqual(report.consoleErrors.filter(item => item.phase !== 'invalid-pdf'), [], 'no unexpected browser console error');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (browser) await browser.close();
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, tests: report.tests.map(({ name, passed }) => ({ name, passed })), networkRequests: report.networkRequests.length, pageErrors: report.pageErrors.length, consoleErrors: report.consoleErrors.length, report: path.join(output, 'report.json') }, null, 2));
}
