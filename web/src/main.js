import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { zipSync } from 'fflate';
import { encodeTiff, createTiffEncoder } from './tiff.js';
import { initUi } from './ui.js';

// The worker, fonts, CMaps, image codecs and ICC profile are embedded by build.mjs.
const workerSource = document.getElementById('pdf-worker').textContent;
async function openPdf(file) {
  if (file.size > 128 * 1024 * 1024) throw new Error('PDF больше 128 МиБ. Используйте Windows-версию.');
  const data = new Uint8Array(await file.arrayBuffer());
  const workerUrl = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}));
  const port = new Worker(workerUrl);
  let rejectWorker;
  let workerFailed = false;
  const workerFailure = new Promise((_, reject) => { rejectWorker = reject; });
  port.addEventListener('error', event => {
    event.preventDefault();
    workerFailed = true;
    rejectWorker(new Error('Не удалось запустить обработчик PDF: ' + (event.message || 'обновите Edge или Chrome.')));
  });
  const worker = new pdfjs.PDFWorker({port});
  const task = pdfjs.getDocument({
    data, worker,
    cMapUrl: 'offline:/cmaps/', standardFontDataUrl: 'offline:/standard_fonts/',
    wasmUrl: 'offline:/wasm/', iccUrl: 'offline:/iccs/', cMapPacked: true,
    useWorkerFetch: true, isEvalSupported: false, enableXfa: false,
    useSystemFonts: true, stopAtErrors: true,
  });
  task.onPassword = () => task.destroy();
  const dispose = async () => {
    try {
      if (workerFailed) task.destroy().catch(() => {});
      else await task.destroy();
    } finally { worker.destroy(); port.terminate(); URL.revokeObjectURL(workerUrl); }
  };
  try {
    const doc = await Promise.race([task.promise, workerFailure]);
    const metadata = await Promise.race([doc.getMetadata(), workerFailure]);
    if (metadata.info.IsXFAPresent || doc.isPureXfa) throw new Error('XFA-формы не поддерживаются. Сначала сохраните PDF с обычными страницами.');
    return {
      numPages: doc.numPages,
      async renderPage(number, dpi, maxPageBytes = 256 * 1024 * 1024) {
        const page = await doc.getPage(number);
        const viewport = page.getViewport({scale: dpi / 72});
        const width = Math.ceil(viewport.width - 1e-7), height = Math.ceil(viewport.height - 1e-7);
        if (width * height > 80_000_000 || width > 32767 || height > 32767) {
          page.cleanup(); throw new Error(`Страница ${number}: ${width} × ${height} пикселей при ${dpi} DPI превышает допустимый размер страницы. Уменьшите DPI или используйте Windows-версию.`);
        }
        if (width * height * 4 > maxPageBytes) {
          page.cleanup(); throw new Error(`Страница ${number}: для изображения ${width} × ${height} при ${dpi} DPI нужно ${Math.ceil(width * height * 4 / 1024 / 1024)} МиБ, лимит одной страницы — ${Math.floor(maxPageBytes / 1024 / 1024)} МиБ. Уменьшите DPI или используйте Windows-версию.`);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        try {
          const context = canvas.getContext('2d', {willReadFrequently: true});
          if (!context) throw new Error('Браузер не смог создать изображение страницы.');
          await Promise.race([page.render({canvasContext: context, viewport, background: 'rgb(255,255,255)',
            intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE}).promise, workerFailure]);
          return {width, height, data: context.getImageData(0, 0, width, height).data};
        } finally { canvas.width = canvas.height = 0; page.cleanup(); }
      },
      destroy: dispose,
    };
  } catch (error) {
    await dispose();
    if (error?.name === 'PasswordException' || /destroyed/i.test(error?.message)) {
      throw new Error('PDF защищён паролем. Сначала сохраните копию без пароля.');
    }
    throw error;
  }
}
initUi({openPdf, encodeTiff, createTiffEncoder, zipSync});
