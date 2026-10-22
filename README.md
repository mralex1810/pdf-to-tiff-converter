# PDF → TIFF

Небольшое нативное приложение Windows 10/11. Конвертация выполняется локально,
без интернета, сервера и установленного у пользователя .NET.

## Запуск

Скачайте **[готовый релиз для Windows x64](https://github.com/mralex1810/pdf-to-tiff-converter/releases/latest)**:
`PdfToTiff-win-x64.zip`. Распакуйте его и запустите `PdfToTiff.exe`.
Устанавливать .NET не требуется. Инструкция для пользователя включена в
`DISTRIBUTION.txt`; рядом с ZIP опубликована контрольная сумма SHA-256.

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
собирает self-contained EXE, добавляет инструкции и лицензии, создаёт ZIP.
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

На macOS можно собрать Windows EXE той же командой .NET:

```sh
dotnet publish src/PdfToTiff.App -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:EnableCompressionInSingleFile=true -p:DebugType=None \
  --disable-build-servers -o artifacts/PdfToTiff-win-x64
```

Это создаёт EXE; для распространения также нужны `DISTRIBUTION.txt`,
`THIRD-PARTY-NOTICES.md`, `licenses/` и лицензии .NET runtime.
При запуске single-file EXE нативные библиотеки автоматически извлекаются
в пользовательскую временную папку.

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
проверяет запуск готового EXE. Само наличие workflow не означает, что CI уже выполнен.
Текущие результаты — в `TESTING.md`.

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
