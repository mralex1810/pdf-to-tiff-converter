# Third-party components

The portable application contains:

- **PDFium 158.0.8111**, distributed by bblanchon/pdfium-binaries, non-V8 build.
  The exact `LICENSE` and bundled component notices are included in `licenses/pdfium/`,
  extracted from the `chromium/8111` Windows x64 distribution.
  Source: https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F8111
- **BitMiracle.LibTiff.NET 2.4.660**. Its BSD license and component notices
  are included in `licenses/LibTiff.NET.txt`.
  Source: https://github.com/BitMiracle/libtiff.net/blob/master/license.txt
- **Microsoft .NET / Windows Desktop runtime**, included by self-contained publish.
  The publish script copies licenses/notices from the exact runtime packages
  identified by the generated runtime configuration into `licenses/`.

Development-only dependencies (xUnit, Microsoft.NET.Test.Sdk, macOS/Linux PDFium)
are not included in the Windows application.

## Автономная HTML-версия

PDF.js 6.4.299 (Apache-2.0) с его шрифтами, CMaps, WASM-кодеками и ICC-профилем;
fflate 0.8.3 (MIT). Полный перечень — в `web/THIRD-PARTY-NOTICES.txt`.
Сборка включает лицензии в ZIP и непосредственно в HTML.
