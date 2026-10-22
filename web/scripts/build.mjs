import { build, transform } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.dirname(root);
const pdf = path.join(root, 'node_modules/pdfjs-dist');
const out = path.join(repo, 'artifacts/html');
await mkdir(out, {recursive: true});
const assets = {};
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  for (const name of (await readdir(path.join(pdf, dir))).sort()) {
    if (!/\.(bcmap|pfb|ttf|wasm|icc|js)$/.test(name) || name.startsWith('quickjs')) continue;
    assets[`offline:/${dir}/${name}`] = (await readFile(path.join(pdf, dir, name))).toString('base64');
  }
}
let worker = await readFile(path.join(pdf, 'build/pdf.worker.mjs'), 'utf8');
// Small, checked patch of the two resource readers: all bytes come from this HTML.
// PDF.js uses a synchronous reader for ICC; Blob directory URLs cannot represent it.
function patch(needle, replacement) {
  if (worker.split(needle).length !== 2) throw new Error('PDF.js changed: resource patch needs review: ' + needle);
  worker = worker.replace(needle, replacement);
}
patch('src.push(`url(${localFontPath}${path})`);', 'src.push(`url(data:font/ttf;base64,${offlineAssets[`${localFontPath}${path}`]})`);');
patch('async function fetchBinaryData(url) {', 'async function fetchBinaryData(url) { return offlineBytes(url);');
patch('function fetchSync(url) {', 'function fetchSync(url) { return offlineBytes(url).buffer;');
patch('`${WasmImage.#wasmUrl}${this._noWasmFilename}`);', 'offlineModuleUrl(`${WasmImage.#wasmUrl}${this._noWasmFilename}`));');
worker = `const offlineAssets=${JSON.stringify(assets)};
function offlineBytes(url) {
 const data=offlineAssets[url]; if(!data) throw new Error('Embedded PDF resource missing: '+url);
 return Uint8Array.from(atob(data),c=>c.charCodeAt(0));
}
const moduleUrls=new Map();
function offlineModuleUrl(url) {
 if(!moduleUrls.has(url)) moduleUrls.set(url,URL.createObjectURL(new Blob([offlineBytes(url)],{type:url.endsWith('.ttf')?'font/ttf':'text/javascript'})));
 return moduleUrls.get(url);
}
` + worker;
worker = (await transform(worker, {minify: true, target: 'es2022', format: 'iife', legalComments: 'none'})).code;
const result = await build({entryPoints: [path.join(root, 'src/main.js')], bundle: true, write: false,
  format: 'iife', target: 'es2022', minify: true, legalComments: 'none'});
const app = result.outputFiles[0].text;
const css = await readFile(path.join(root, 'src/style.css'), 'utf8');
const scriptSafe = text => text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; font-src blob: data:; img-src blob: data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>PDF → TIFF · офлайн</title><style>${css}</style></head>
<body><div id="app"></div><noscript>Включите JavaScript в браузере для локальной конвертации.</noscript>
<script id="pdf-worker" type="text/plain">${scriptSafe(worker)}</script>
<script>${scriptSafe(app)}</script></body></html>`;
const name = 'PdfToTiff.html';
await writeFile(path.join(out, name), html);
const files = {[name]: Buffer.from(html)};
const notices = await readFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'));
files['THIRD-PARTY-NOTICES.txt'] = notices;
files['README.txt'] = await readFile(path.join(root, 'USER-GUIDE.txt'));
for (const file of ['LICENSE', 'wasm/LICENSE_JBIG2', 'wasm/LICENSE_OPENJPEG', 'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG', 'wasm/LICENSE_PDFJS_QCMS', 'wasm/LICENSE_QCMS', 'iccs/LICENSE',
  'standard_fonts/LICENSE_FOXIT', 'standard_fonts/LICENSE_LIBERATION', 'cmaps/LICENSE']) {
  files['licenses/pdfjs-' + file.replaceAll('/', '-')] = await readFile(path.join(pdf, file));
}
files['licenses/fflate-LICENSE'] = await readFile(path.join(root, 'node_modules/fflate/LICENSE'));
// Keep copyright notices available even when users copy only the HTML file.
const licenseText = Object.entries(files).filter(([n]) => n.includes('LICENSE') || n === 'THIRD-PARTY-NOTICES.txt')
  .map(([n, bytes]) => `\n${n}\n${bytes.toString()}`).join('\n');
const withLicenses = html.replace('</body>', `<script type="text/plain" id="third-party-licenses">${scriptSafe(licenseText)}</script></body>`);
files[name] = Buffer.from(withLicenses);
await writeFile(path.join(out, name), withLicenses);
for (const [filename, bytes] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(out, filename)), {recursive: true});
  await writeFile(path.join(out, filename), bytes);
}
const zipName = 'PdfToTiff-html.zip';
await writeFile(path.join(out, zipName), zipSync(files, {level: 6}));
for (const filename of [name, zipName]) {
 const bytes=await readFile(path.join(out, filename));
 await writeFile(path.join(out, filename+'.sha256'), createHash('sha256').update(bytes).digest('hex')+'  '+filename+'\n');
 console.log(`${filename}: ${bytes.length} bytes`);
}
