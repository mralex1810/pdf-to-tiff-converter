namespace PdfToTiff.Core;

public sealed class PdfConverter
{
    private static readonly SemaphoreSlim PdfiumGate = new(1, 1);

    /// <summary>
    /// Converts into a new subfolder. Completed output becomes visible only after every page is written.
    /// The caller should run this synchronous, CPU-intensive operation on a background thread.
    /// </summary>
    public ConversionResult Convert(string inputPath, string outputDirectory, ConversionOptions options,
        IProgress<ConversionProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(inputPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputDirectory);
        ArgumentNullException.ThrowIfNull(options);
        options.Validate();
        cancellationToken.ThrowIfCancellationRequested();
        inputPath = Path.GetFullPath(inputPath);
        outputDirectory = Path.GetFullPath(outputDirectory);
        if (!File.Exists(inputPath)) throw new FileNotFoundException("PDF не найден.", inputPath);

        PdfiumGate.Wait(cancellationToken);
        string? workFolder = null;
        try
        {
            using var document = new PdfiumDocument(inputPath);
            // TIFF PageNumber stores unsigned 16-bit values.
            if (document.PageCount > ushort.MaxValue)
                throw new InvalidOperationException("В документе слишком много страниц (максимум 65535).");
            cancellationToken.ThrowIfCancellationRequested();
            Directory.CreateDirectory(outputDirectory);
            string stem = SafeStem(Path.GetFileNameWithoutExtension(inputPath));
            string id = Guid.NewGuid().ToString("N");
            workFolder = Path.Combine(outputDirectory, $".pdf-to-tiff-{id}.tmp");
            Directory.CreateDirectory(workFolder);
            var names = new List<string>();
            progress?.Report(new(0, document.PageCount, "Открыт PDF. Подготовка страниц…"));

            if (options.OutputMode == OutputMode.MultiPage)
            {
                string name = $"{stem}.tiff";
                using (var writer = new TiffWriter(Path.Combine(workFolder, name)))
                {
                    for (int i = 0; i < document.PageCount; i++)
                    {
                        using var page = document.Render(i, options.Dpi, cancellationToken);
                        writer.AddPage(page, options, i, document.PageCount, cancellationToken);
                        progress?.Report(new(i + 1, document.PageCount, $"Обработана страница {i + 1} из {document.PageCount}"));
                    }
                }
                names.Add(name);
            }
            else
            {
                int digits = Math.Max(3, document.PageCount.ToString(System.Globalization.CultureInfo.InvariantCulture).Length);
                for (int i = 0; i < document.PageCount; i++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    string name = $"{stem}_{(i + 1).ToString($"D{digits}", System.Globalization.CultureInfo.InvariantCulture)}.tiff";
                    using (var page = document.Render(i, options.Dpi, cancellationToken))
                    using (var writer = new TiffWriter(Path.Combine(workFolder, name)))
                        writer.AddPage(page, options, 0, 1, cancellationToken);
                    names.Add(name);
                    progress?.Report(new(i + 1, document.PageCount, $"Обработана страница {i + 1} из {document.PageCount}"));
                }
            }

            cancellationToken.ThrowIfCancellationRequested();
            string finalFolder = Path.Combine(outputDirectory, $"{stem}_{DateTime.Now:yyyyMMdd_HHmmss}_{id[..8]}");
            Directory.Move(workFolder, finalFolder);
            workFolder = null;
            return new(finalFolder, names.Select(name => Path.Combine(finalFolder, name)).ToArray(), document.PageCount);
        }
        catch (OutOfMemoryException error)
        {
            throw new InvalidOperationException("Не хватает памяти. Уменьшите DPI или разделите PDF на части.", error);
        }
        finally
        {
            try
            {
                if (workFolder is not null && Directory.Exists(workFolder))
                    Directory.Delete(workFolder, recursive: true);
            }
            catch (IOException) { /* A locked temporary file must not hide the original error. */ }
            catch (UnauthorizedAccessException) { }
            PdfiumGate.Release();
        }
    }

    private static string SafeStem(string name)
    {
        const string invalid = "<>:\"/\\|?*";
        string stem = new(name.Select(c => c < 32 || invalid.Contains(c) ? '_' : c).ToArray());
        stem = stem.Trim().TrimEnd('.', ' ');
        if (stem.Length == 0) stem = "document";
        if (stem.Length > 80)
        {
            int length = char.IsHighSurrogate(stem[79]) ? 79 : 80;
            stem = stem[..length].TrimEnd('.', ' ');
        }
        string firstPart = stem.Split('.')[0].ToUpperInvariant();
        if (firstPart is "CON" or "PRN" or "AUX" or "NUL" ||
            (firstPart.Length == 4 && (firstPart.StartsWith("COM") || firstPart.StartsWith("LPT")) && firstPart[3] is >= '1' and <= '9'))
            stem = "_" + stem;
        return stem;
    }
}
