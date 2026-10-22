param(
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [switch]$SingleFile
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
    $output = Join-Path $repo "artifacts/PdfToTiff-$Runtime"
    # Only this script's fixed build directory is replaced; conversion results live elsewhere.
    if (Test-Path $output) { Remove-Item $output -Recurse -Force }
    $publishOptions = @('-p:PublishSingleFile=false')
    if ($SingleFile) {
        $publishOptions = @('-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
            '-p:EnableCompressionInSingleFile=true')
    }
    dotnet publish src/PdfToTiff.App/PdfToTiff.App.csproj -c Release -r $Runtime --self-contained true `
        @publishOptions -p:DebugType=None --disable-build-servers -o $output
    if ($LASTEXITCODE -ne 0) { throw 'Windows publish failed.' }

    Copy-Item licenses (Join-Path $output 'licenses') -Recurse
    Copy-Item DISTRIBUTION.txt,THIRD-PARTY-NOTICES.md $output
    Copy-Item (Join-Path $PSScriptRoot 'Запуск с диагностикой.cmd') $output
    $assets = Get-Content src/PdfToTiff.App/obj/project.assets.json -Raw | ConvertFrom-Json
    $cache = @($assets.packageFolders.PSObject.Properties.Name)[0]
    $configPath = "src/PdfToTiff.App/bin/Release/net10.0-windows/$Runtime/PdfToTiff.runtimeconfig.json"
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    foreach ($framework in $config.runtimeOptions.includedFrameworks) {
        $id = "$($framework.name).Runtime.$Runtime".ToLowerInvariant()
        $package = Join-Path $cache "$id/$($framework.version)"
        $destination = Join-Path $output "licenses/$id"
        New-Item $destination -ItemType Directory -Force | Out-Null
        $notices = @(Get-ChildItem $package -File | Where-Object { $_.Name -match '^(LICENSE|THIRD-PARTY-NOTICES)' })
        if ($notices.Count -eq 0) { throw "Runtime license missing: $package" }
        $notices | Copy-Item -Destination $destination
    }

    $zip = "$output.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path $output -DestinationPath $zip -CompressionLevel Optimal
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content "$zip.sha256" "$hash  $(Split-Path $zip -Leaf)" -Encoding ascii
    Write-Host "Portable package: $zip"
}
finally { Pop-Location }
