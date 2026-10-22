namespace PdfToTiff.Core;

public enum ColorMode { Color, Grayscale, BlackAndWhite }
public enum OutputMode { SeparateFiles, MultiPage }
public enum TiffCompression { Lzw, Deflate, None, Group4, PackBits }

public sealed record ConversionOptions
{
    public int Dpi { get; init; } = 400;
    public ColorMode ColorMode { get; init; } = ColorMode.BlackAndWhite;
    public OutputMode OutputMode { get; init; } = OutputMode.SeparateFiles;
    public TiffCompression Compression { get; init; } = TiffCompression.PackBits;
    public byte Threshold { get; init; } = 180;

    internal void Validate()
    {
        if (Dpi is < 72 or > 600)
            throw new ArgumentOutOfRangeException(nameof(Dpi), "Разрешение должно быть от 72 до 600 DPI.");
        if (!Enum.IsDefined(ColorMode) || !Enum.IsDefined(OutputMode) || !Enum.IsDefined(Compression))
            throw new ArgumentException("Неизвестная настройка конвертации.");
        if (Compression == TiffCompression.Group4 && ColorMode != ColorMode.BlackAndWhite)
            throw new ArgumentException("Сжатие Group 4 доступно только для чёрно-белого изображения.");
    }
}

public sealed record ConversionProgress(int CompletedPages, int TotalPages, string Message);
public sealed record ConversionResult(string OutputFolder, IReadOnlyList<string> Files, int PageCount);
