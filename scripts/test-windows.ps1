param([string]$Pdf = '')

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $IsWindows) { throw 'The UI checks require Windows.' }
Push-Location $repo
try {
    if (-not $Pdf) { $Pdf = Join-Path $repo 'tests/fixtures/two-pages.pdf' }
    $Pdf = (Resolve-Path $Pdf).Path
    dotnet test tests/PdfToTiff.Tests/PdfToTiff.Tests.csproj -c Release `
        --logger 'trx;LogFileName=conversion.trx' --results-directory artifacts/test-results --disable-build-servers
    if ($LASTEXITCODE -ne 0) { throw 'Conversion tests failed.' }

    $stamp = [Guid]::NewGuid().ToString('N')
    $output = Join-Path $repo "artifacts/ui-smoke-$stamp"
    dotnet run --project tests/PdfToTiff.App.Smoke -c Release --disable-build-servers -- `
        $Pdf $output (Join-Path $repo 'artifacts/ui-smoke.png')
    if ($LASTEXITCODE -ne 0) { throw 'WPF UI smoke test failed.' }
}
finally { Pop-Location }
