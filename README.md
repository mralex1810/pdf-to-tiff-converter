# PDF → TIFF

[![Windows build and conversion](https://github.com/mralex1810/pdf-to-tiff-converter/actions/workflows/windows.yml/badge.svg)](https://github.com/mralex1810/pdf-to-tiff-converter/actions/workflows/windows.yml)

Конвертер для работы без интернета: автономный **HTML для браузера** и
нативное **приложение Windows 10/11**. Конвертация выполняется на компьютере;
документы никуда не отправляются.

## HTML: запуск без установки и подписи EXE

Скачайте **[релиз](https://github.com/mralex1810/pdf-to-tiff-converter/releases/latest)**:
`PdfToTiff-html.zip` или отдельный `PdfToTiff.html`.
Распакуйте ZIP и откройте `PdfToTiff.html` двойным щелчком в актуальном
**Microsoft Edge или Google Chrome**. Интернет, локальный сервер, .NET и Node.js
для запуска не требуются. Все библиотеки находятся внутри одного HTML.

Выберите PDF → «Конвертировать» → «Скачать ZIP с TIFF».
По умолчанию: отдельный TIFF для каждой страницы, 200 DPI, цветной, LZW.
В настройках есть один многостраничный TIFF, 300/600 DPI, серый и чёрно-белый
режимы, LZW/без сжатия. Результат сохраняется через обычное скачивание браузера.

Лимиты HTML: PDF до 128 МиБ, до 80 млн пикселей/страницу и суммарно до 256 МиБ
RGBA на документ (примерно 17 страниц A4 при 200 DPI). Фактическая память выше;
для больших документов используйте нативную версию. CCITT Group 4 и Deflate
доступны в Windows-версии. PDF с паролем и XFA не поддерживаются.

Сборка HTML из исходников — Node.js 22.13+ и npm:

```sh
cd web
npm ci --ignore-scripts
npm run build
```

Готовые файлы: `artifacts/html/PdfToTiff.html` и `PdfToTiff-html.zip`.
Первая загрузка npm-пакетов требует интернет. Подробности сборки, тестов и
ограничений — в [web/README.md](web/README.md).

## Windows: запуск

Скачайте **[готовый релиз для Windows x64](https://github.com/mralex1810/pdf-to-tiff-converter/releases/latest)**:
`PdfToTiff-win-x64.zip`. Распакуйте его и запустите `PdfToTiff.exe`.
Устанавливать .NET не требуется. Инструкция для пользователя включена в
`DISTRIBUTION.txt`; рядом с ZIP опубликована контрольная сумма SHA-256.
Если Windows блокирует скачанный файл, у ZIP откройте **Свойства → Разблокировать**,
затем распакуйте его. Текущие релизы не имеют доверенной Authenticode-подписи;
проверки скачанных файлов зависят от настроек безопасности Windows.
Начиная с v0.2.0 это папка с EXE и DLL: распакуйте её целиком и сохраняйте файлы
вместе. Самораспаковка библиотек во временную папку при старте не используется.

Если окно не появляется, запустите **«Запуск с диагностикой.cmd»** из той же
папки. Он покажет код завершения и откроет `%LOCALAPPDATA%\PdfToTiff\Logs`.
Для разбора нужны `launcher.log`, `host-startup.log` (если создан) и
`startup.log` (если приложение успело загрузиться). Журналы не отправляются
автоматически. Они могут содержать имя пользователя и пути на компьютере.
При ошибке загрузки интерфейса приложение также показывает сообщение с путём журнала.

По умолчанию: **один TIFF на каждую страницу, 200 DPI, цветной, LZW**.
Есть переключение на один многостраничный TIFF, 300/600 DPI, оттенки серого,
чёрно-белый режим с порогом, LZW/Deflate/без сжатия/CCITT Group 4.
Поддерживаются drag-and-drop, прогресс и отмена.

Каждая конвертация создаёт новую подпапку с именем PDF, временем и уникальным
суффиксом. Результат публикуется только после записи всех страниц; при ошибке
или отмене временная папка удаляется. Исходники и предыдущие результаты сохраняются.
Если временный файл заблокирован другой программой, его очистка может не выполниться.

## Сборка

Для самостоятельной сборки на Windows 10/11 нужны
[.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0),
[PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows)
и Git. Можно также скачать исходники через GitHub **Code → Download ZIP** и
распаковать их вместо `git clone`.

Первая загрузка SDK/NuGet-пакетов при разработке требует интернет;
готовому EXE он не нужен. Откройте PowerShell 7 и выполните:

```powershell
git clone https://github.com/mralex1810/pdf-to-tiff-converter.git
cd pdf-to-tiff-converter
dotnet --version
pwsh -NoProfile -File ./scripts/publish-windows.ps1
```

Команды выполняются из корня репозитория. Скрипт сам восстанавливает зависимости,
собирает self-contained папку EXE+DLL, добавляет инструкции и лицензии, создаёт ZIP.
Результат: `artifacts/PdfToTiff-win-x64/PdfToTiff.exe`,
`artifacts/PdfToTiff-win-x64.zip` и `artifacts/PdfToTiff-win-x64.zip.sha256`.
Для запуска готового результата достаточно распакованного ZIP.

Проверка контрольной суммы в PowerShell:

```powershell
Get-FileHash ./artifacts/PdfToTiff-win-x64.zip -Algorithm SHA256
Get-Content ./artifacts/PdfToTiff-win-x64.zip.sha256
```

Для Windows ARM64: `./scripts/publish-windows.ps1 -Runtime win-arm64`.
ARM64-пакет нужно отдельно проверить на целевом устройстве.
Опциональная сборка одним EXE: `./scripts/publish-windows.ps1 -SingleFile`.
Она требует извлечения встроенных нативных библиотек при запуске и не является
основным распространяемым вариантом.

На macOS можно собрать Windows EXE той же командой .NET:

```sh
dotnet publish src/PdfToTiff.App -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=false -p:DebugType=None \
  --disable-build-servers -o artifacts/PdfToTiff-win-x64
```

Это создаёт папку EXE+DLL; для распространения также нужны `DISTRIBUTION.txt`,
`THIRD-PARTY-NOTICES.md`, диагностический CMD, `licenses/` и лицензии .NET runtime.

## Проверки

```sh
dotnet test tests/PdfToTiff.Tests -c Release --disable-build-servers
```

Тесты выполняют настоящую конвертацию PDFium и читают пиксели TIFF через
LibTiff.NET. На macOS/Linux используются соответствующие нативные сборки
PDFium той же версии. Проверяются страницы, поворот, DPI, цветность, сжатие,
заполненные AcroForm, кириллица, отмена и сохранность существующих файлов.

На Windows дополнительно запускается настоящий WPF-интерфейс:

```powershell
./scripts/test-windows.ps1
```

Этот сценарий нажимает кнопку конвертации, проверяет два одностраничных TIFF
встроенным Windows-декодером и сохраняет снимок окна. Workflow
`.github/workflows/windows.yml` выполняет тесты, упаковывает приложение и
проверяет запуск готового EXE. Windows CI успешно выполнен 22 октября 2026:
28 тестов, конвертация через WPF и запуск/закрытие упакованного EXE.
Результаты и границы проверок — в [TESTING.md](TESTING.md).

Для проверки ядра на приложенном PDF без GUI есть служебный CLI:

```sh
dotnet run --project tools/PdfToTiff.Cli -- input.pdf output-folder
dotnet run --project tools/PdfToTiff.Cli -- input.pdf output-folder \
  --layout MultiPage --color Grayscale --dpi 300
```

## Архитектура и ограничения

- `src/PdfToTiff.App`: WPF-интерфейс.
- `src/PdfToTiff.Core`: PDFium → построчное преобразование пикселей → LibTiff.NET.
  Общий TIFF-кодировщик позволяет проверять тот же код на macOS и Windows.
- PDFium работает последовательно в фоновом потоке; в памяти находится растр
  одной страницы. Входной PDF читается в память для поддержки Unicode-путей.
- Разрешение: 72–600 DPI; PDF до 512 МиБ; страница до 80 млн пикселей.
  Многостраничный классический TIFF ограничен 2 ГБ исходных пикселей для
  безопасных 32-битных смещений; для больших документов используйте отдельные файлы.
- Отмена проверяется между страницами и строками TIFF; текущий нативный рендер
  страницы может завершаться некоторое время.
- Парольные PDF и XFA отклоняются с понятной ошибкой. Сохранённые AcroForm
  отображаются; PDF JavaScript, пересчёт и интерактивные действия не выполняются.
- При отсутствующих в PDF шрифтах возможна замена системным шрифтом.
- TIFF — растровое изображение: текстовый слой, интерактивные поля и цифровая
  подпись PDF в него не переносятся.

Версии сторонних пакетов зафиксированы в проектах и NuGet lock-файлах.
Лицензии — в `THIRD-PARTY-NOTICES.md` и `licenses/`.
