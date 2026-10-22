# WPF UI smoke runner

This Windows-only STA console runner opens the actual WPF application and checks its named controls. It verifies the defaults (black-and-white, 400 DPI, PackBits, separate files), the Group 4/color interaction, and that selecting black-and-white preserves PackBits. With a two-page PDF fixture, it clicks the real Convert button, pumps the WPF dispatcher, waits up to 60 seconds, and checks that a new output subfolder contains two independently decodable one-bit, PackBits-compressed single-page TIFFs at 400 DPI. A PNG screenshot is saved after layout.

Run on Windows 10/11 with the .NET 10 SDK:

```powershell
dotnet run --project tests/PdfToTiff.App.Smoke -- "C:\fixtures\two-page.pdf" "C:\test-output" "C:\test-output\ui-smoke.png"
```

Check the controls and take a screenshot without converting a PDF:

```powershell
dotnet run --project tests/PdfToTiff.App.Smoke -- --screenshot "C:\test-output\ui-defaults.png"
```

With no arguments, it checks the controls and writes `ui-smoke.png` in the current directory. Exit code 0 means all requested checks passed; exit code 1 means a UI/conversion/decoding/screenshot check failed. This is a real window/dispatcher test intended for Windows CI. Cross-compilation on macOS does not execute these checks.
