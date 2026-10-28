const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_PAGE_PIXELS = 80_000_000;
const MAX_PAGE_BYTES = 256 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024 * 1024;

const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));
const formatSize = bytes => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes < 1024 * 1024 ? bytes / 1024 : bytes / 1024 / 1024) + (bytes < 1024 * 1024 ? ' КиБ' : ' МиБ');

function outputBase(name) {
  const cleaned = name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  return cleaned && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) ? cleaned : 'document';
}

function readableError(error) {
  if (error?.code === 'TIFF_SIZE_LIMIT') return 'Размер готовых TIFF превышает 256 МиБ. Уменьшите DPI, включите сжатие или разделите PDF.';
  if (error?.name === 'PasswordException') return 'PDF защищён паролем. Сначала сохраните копию без пароля и выберите её.';
  if (error?.name === 'InvalidPDFException') return 'Не удалось прочитать PDF. Возможно, файл повреждён или имеет другой формат.';
  if (error instanceof RangeError) return 'Браузеру не хватило памяти. Уменьшите DPI или разделите PDF на несколько документов.';
  return error?.message || 'Не удалось выполнить конвертацию. Попробуйте другой PDF или уменьшите DPI.';
}

export function initUi({ openPdf, encodeTiff, createTiffEncoder, zipSync }) {
  const root = document.getElementById('app');
  root.innerHTML = `
    <main class="shell">
      <header class="heading">
        <div class="eyebrow"><span class="privacy-dot" aria-hidden="true"></span> ЛОКАЛЬНЫЙ КОНВЕРТЕР</div>
        <h1>PDF <span aria-hidden="true">→</span><span class="sr-only">в</span> TIFF</h1>
        <p class="intro">Подготовьте страницы PDF в формате TIFF.<br>Без установки и подключения к интернету.</p>
      </header>

      <section class="converter" aria-label="Настройки конвертации">
        <div id="drop-zone" class="drop-zone">
          <svg class="file-icon" viewBox="0 0 40 48" fill="none" aria-hidden="true"><path d="M8 2h16l12 12v29a3 3 0 0 1-3 3H8a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Z" stroke="currentColor" stroke-width="2"/><path d="M24 2v12h12M12 25h16M12 32h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <label class="file-label" for="pdf-file">Выберите PDF</label>
          <p id="file-detail" class="file-detail">или перетащите его сюда</p>
          <input id="pdf-file" type="file" accept=".pdf,application/pdf" aria-describedby="file-detail" />
          <p id="file-name" class="file-name" hidden></p>
        </div>

        <fieldset id="settings" class="settings">
          <legend class="sr-only">Параметры TIFF</legend>
          <div class="field">
            <label for="output-mode">Результат</label>
            <select id="output-mode"><option value="separate">Отдельный TIFF для каждой страницы</option><option value="multi">Один многостраничный TIFF</option></select>
            <p id="output-hint" class="hint">Все страницы сохранятся в одном ZIP-архиве.</p>
          </div>
          <div id="download-mode-field" class="field">
            <label for="download-mode">Как скачать страницы</label>
            <select id="download-mode"><option value="zip">ZIP-архив</option><option value="files">Отдельные TIFF-файлы без архива</option></select>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="dpi">Разрешение</label>
              <select id="dpi"><option value="200">200 DPI</option><option value="300">300 DPI</option><option value="400" selected>400 DPI · стандартное</option><option value="600">600 DPI · максимальное</option></select>
            </div>
            <div class="field">
              <label for="color-mode">Цветность</label>
              <select id="color-mode"><option value="color">Цветной</option><option value="grayscale">Оттенки серого</option><option value="bw" selected>Чёрно-белый · 1 бит</option></select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="compression">Сжатие</label>
              <select id="compression"><option value="packbits" selected>PackBits · без потери качества</option><option value="lzw">LZW · без потери качества</option><option value="none">Без сжатия</option></select>
            </div>
            <div id="threshold-field" class="field" hidden>
              <label for="threshold">Порог чёрного: <output id="threshold-value" for="threshold">180</output></label>
              <input id="threshold" type="range" min="0" max="255" value="180" />
              <p class="hint">Выше — больше чёрного.</p>
            </div>
          </div>
          <p id="bw-hint" class="hint color-hint" hidden>В чёрно-белом режиме светлые надписи и оттенки могут пропасть.</p>
        </fieldset>

        <div class="actions">
          <button id="convert" class="button primary" type="button" disabled>Конвертировать</button>
          <button id="cancel" class="button secondary" type="button" hidden>Отменить</button>
        </div>

        <section id="feedback" class="feedback" aria-label="Ход конвертации" hidden>
          <p id="status" role="status" aria-live="polite"></p>
          <progress id="progress" max="100" value="0" aria-label="Ход конвертации" hidden></progress>
          <a id="download" class="button primary download" hidden>Скачать результат</a>
          <p id="result-created" class="hint" hidden>Результат создан: <time id="result-created-time"></time></p>
          <p id="download-hint" class="hint" hidden>Файл уже готов. Нажмите кнопку, чтобы сохранить его на компьютер.</p>
          <ul id="file-downloads" class="file-downloads" aria-label="Скачать отдельные TIFF-файлы" hidden></ul>
        </section>
      </section>

      <footer class="notes">
        <p><svg viewBox="0 0 16 18" fill="none" aria-hidden="true"><rect x="2" y="7" width="12" height="9" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 7V4a3 3 0 0 1 6 0v3" stroke="currentColor" stroke-width="1.5"/></svg> Документы обрабатываются в этом браузере и никуда не отправляются.</p>
        <details><summary>Ограничения браузерной версии</summary><p>PDF до 128 МиБ. Страницы обрабатываются по очереди: до 80 млн пикселей и 256 МиБ растровых данных на одну страницу. Готовые TIFF вместе — до 256 МиБ. Размер исходного PDF не определяет объём изображения при выбранном DPI. При нехватке памяти уменьшите DPI или разделите PDF. PDF с паролем не поддерживаются. Во время обработки держите вкладку открытой.</p><p>PackBits и LZW сохраняют изображение без потерь. Вариант «Без сжатия» создаёт заметно большие файлы. Сжатие CCITT Group 4 доступно в приложении для Windows.</p></details>
      </footer>
    </main>`;

  const get = id => document.getElementById(id);
  const fileInput = get('pdf-file');
  const dropZone = get('drop-zone');
  const convert = get('convert');
  const cancel = get('cancel');
  const feedback = get('feedback');
  const status = get('status');
  const progress = get('progress');
  const download = get('download');
  let selectedFile = null;
  let busy = false;
  let cancelled = false;
  let resultDownloads = [];

  function clearResult() {
    for (const file of resultDownloads) URL.revokeObjectURL(file.url);
    resultDownloads = [];
    get('file-downloads').replaceChildren();
    get('file-downloads').hidden = true;
    download.removeAttribute('href');
    download.hidden = true;
    get('result-created').hidden = true;
    get('result-created-time').textContent = '';
    get('result-created-time').removeAttribute('datetime');
    get('download-hint').hidden = true;
  }

  function say(message, error = false) {
    feedback.hidden = false;
    feedback.classList.toggle('error', error);
    status.textContent = message;
  }

  function setBusy(value) {
    busy = value;
    fileInput.disabled = value;
    get('settings').disabled = value;
    dropZone.classList.toggle('busy', value);
    convert.disabled = value || !selectedFile;
    convert.textContent = value ? 'Конвертация…' : 'Конвертировать';
    cancel.hidden = !value;
    cancel.disabled = false;
    cancel.textContent = 'Отменить';
    root.setAttribute('aria-busy', String(value));
  }

  function chooseFile(file) {
    if (busy || !file) return;
    clearResult();
    feedback.hidden = true;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      say('Выберите файл PDF.', true);
      return;
    }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      say(file.size === 0 ? 'Выбранный файл пуст.' : 'Размер PDF превышает 128 МиБ. Разделите его на несколько файлов.', true);
      return;
    }
    selectedFile = file;
    get('file-name').hidden = false;
    get('file-name').textContent = file.name;
    get('file-detail').textContent = `${formatSize(file.size)} · нажмите «Выберите PDF», чтобы заменить`;
    dropZone.classList.add('has-file');
    convert.disabled = false;
  }

  fileInput.addEventListener('change', () => {
    chooseFile(fileInput.files?.[0]);
    fileInput.value = '';
  });
  let dragDepth = 0;
  dropZone.addEventListener('dragenter', event => {
    event.preventDefault();
    if (!busy) { dragDepth++; dropZone.classList.add('dragging'); }
  });
  dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  });
  dropZone.addEventListener('dragleave', event => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('dragging');
  });
  dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('dragging');
    if (busy) return;
    if (event.dataTransfer?.files.length !== 1) { say('Выберите один PDF для конвертации.', true); return; }
    chooseFile(event.dataTransfer.files[0]);
  });
  // Prevent a PDF dropped outside the picker from replacing the application tab.
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => event.preventDefault());

  function updateOutputControls() {
    const separate = get('output-mode').value === 'separate';
    get('download-mode-field').hidden = !separate;
    get('output-hint').textContent = !separate
      ? 'Все страницы сохранятся внутри одного файла TIFF.'
      : get('download-mode').value === 'zip'
        ? 'Все страницы сохранятся в одном ZIP-архиве.'
        : 'Каждая страница скачается отдельным TIFF-файлом. Браузер может запросить разрешение на несколько скачиваний.';
  }
  get('output-mode').addEventListener('change', updateOutputControls);
  get('download-mode').addEventListener('change', updateOutputControls);
  download.addEventListener('click', event => {
    if (resultDownloads.length <= 1) return;
    event.preventDefault();
    for (const link of get('file-downloads').querySelectorAll('a')) link.click();
  });
  function updateColorControls() {
    const bw = get('color-mode').value === 'bw';
    get('threshold-field').hidden = !bw;
    get('threshold').disabled = !bw;
    get('bw-hint').hidden = !bw;
  }
  get('color-mode').addEventListener('change', updateColorControls);
  updateColorControls();
  get('threshold').addEventListener('input', () => { get('threshold-value').value = get('threshold').value; });
  cancel.addEventListener('click', () => {
    cancelled = true;
    cancel.disabled = true;
    cancel.textContent = 'Отмена…';
    say('Отмена после завершения текущей операции…');
  });

  convert.addEventListener('click', async () => {
    if (busy || !selectedFile) return;
    const file = selectedFile;
    const options = {
      dpi: Number(get('dpi').value), colorMode: get('color-mode').value,
      compression: get('compression').value, threshold: Number(get('threshold').value)
    };
    const separate = get('output-mode').value === 'separate';
    const zip = separate && get('download-mode').value === 'zip';
    const base = outputBase(file.name);
    let pdf = null;
    cancelled = false;
    clearResult();
    setBusy(true);
    progress.value = 0;
    progress.hidden = false;
    say('Открываем PDF…');
    function checkCancelled() { if (cancelled) throw new DOMException('Конвертация отменена.', 'AbortError'); }
    try {
      await nextFrame();
      pdf = await openPdf(file);
      checkCancelled();
      if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('В PDF нет страниц для конвертации.');
      const entries = Object.create(null);
      const multiPage = separate ? null : createTiffEncoder({ ...options, maxBytes: MAX_RESULT_BYTES });
      const digits = Math.max(3, String(pdf.numPages).length);
      let encodedBytes = 0;
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        checkCancelled();
        if (separate && encodedBytes >= MAX_RESULT_BYTES) throw new Error('Размер готовых TIFF достиг лимита 256 МиБ. Уменьшите DPI, включите сжатие или разделите PDF.');
        say(`Обрабатываем страницу ${pageNo} из ${pdf.numPages}…`);
        await nextFrame();
        let page = await pdf.renderPage(pageNo, options.dpi, MAX_PAGE_BYTES);
        checkCancelled();
        if (!page || !Number.isInteger(page.width) || !Number.isInteger(page.height) || page.width <= 0 || page.height <= 0 || page.width * page.height > MAX_PAGE_PIXELS) {
          throw new Error('Страница слишком большая: допустимо до 80 млн пикселей. Уменьшите DPI.');
        }
        if (separate) {
          const bytes = encodeTiff([page], { ...options, maxBytes: MAX_RESULT_BYTES - encodedBytes });
          encodedBytes += bytes.byteLength;
          entries[`${base}_page_${String(pageNo).padStart(digits, '0')}.tiff`] = bytes;
        } else multiPage.addPage(page);
        page = null; // Only encoded TIFF bytes survive between pages, never previous RGBA rasters.
        progress.value = Math.round(pageNo / pdf.numPages * 90);
        await nextFrame();
      }
      checkCancelled();
      say(zip ? 'Собираем ZIP-архив…' : separate ? 'Подготавливаем TIFF-файлы…' : 'Собираем многостраничный TIFF…');
      await nextFrame();
      const files = zip ? [[`${base}_tiff.zip`, zipSync(entries, { level: 0 })]]
        : separate ? Object.entries(entries) : [[`${base}.tiff`, multiPage.finish()]];
      checkCancelled();
      for (const [name, bytes] of files) {
        resultDownloads.push({ name, url: URL.createObjectURL(new Blob([bytes], { type: zip ? 'application/zip' : 'image/tiff' })) });
      }
      download.href = resultDownloads[0].url;
      download.download = resultDownloads[0].name;
      download.textContent = zip ? 'Скачать ZIP с TIFF' : resultDownloads.length === 1 ? 'Скачать TIFF' : `Скачать все TIFF (${resultDownloads.length})`;
      if (separate && !zip) {
        for (const file of resultDownloads) {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = file.url;
          link.download = file.name;
          link.textContent = file.name;
          item.append(link);
          get('file-downloads').append(item);
        }
        get('file-downloads').hidden = false;
      }
      get('download-hint').textContent = resultDownloads.length > 1
        ? 'Браузер может запросить разрешение на несколько скачиваний. Если скачались не все страницы, сохраните их по ссылкам ниже.'
        : 'Файл уже готов. Нажмите кнопку, чтобы сохранить его на компьютер.';
      const createdAt = new Date();
      get('result-created-time').dateTime = createdAt.toISOString();
      get('result-created-time').textContent = createdAt.toLocaleString('ru-RU', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      get('result-created').hidden = false;
      download.hidden = false;
      get('download-hint').hidden = false;
      progress.value = 100;
      say(`Готово. Страниц: ${pdf.numPages}. Размер результата: ${formatSize(files.reduce((total, [, bytes]) => total + bytes.byteLength, 0))}.`);
    } catch (error) {
      clearResult();
      progress.hidden = true;
      say(error?.name === 'AbortError' ? 'Конвертация отменена. Можно изменить настройки и начать снова.' : readableError(error), error?.name !== 'AbortError');
    } finally {
      try { await pdf?.destroy(); } catch { /* The result is already independent of the renderer. */ }
      setBusy(false);
    }
  });
  window.addEventListener('pagehide', clearResult);
}
