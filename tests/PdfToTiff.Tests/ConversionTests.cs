using BitMiracle.LibTiff.Classic;
using PdfToTiff.Core;
using Xunit;

namespace PdfToTiff.Tests;

public sealed class ConversionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "PdfToTiff.Tests", Guid.NewGuid().ToString("N"));
    private readonly PdfConverter converter = new();

    public ConversionTests() => Directory.CreateDirectory(root);

    [Fact]
    public void ExplicitColorLzwProducesOneTiffPerPageWithDpiAndCorrectRgbPixels()
    {
        string input = CreateTwoPagePdf();
        ConversionResult result = Convert(input, new ConversionOptions
        {
            Dpi = 200, ColorMode = ColorMode.Color, Compression = TiffCompression.Lzw
        });

        Assert.Equal(2, result.PageCount);
        Assert.Equal(2, result.Files.Count);
        Assert.True(Directory.Exists(result.OutputFolder));
        Assert.All(result.Files, file => Assert.Equal(result.OutputFolder, Path.GetDirectoryName(file)));
        Assert.EndsWith("_001.tiff", result.Files[0], StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith("_002.tiff", result.Files[1], StringComparison.OrdinalIgnoreCase);

        using Tiff first = Open(result.Files[0]);
        Assert.Equal(1, first.NumberOfDirectories());
        AssertDimensions(first, 200, 300);
        AssertDpi(first, 200);
        Assert.Equal(3, Tag(first, TiffTag.SAMPLESPERPIXEL));
        Assert.Equal(8, Tag(first, TiffTag.BITSPERSAMPLE));
        Assert.Equal((int)Photometric.RGB, Tag(first, TiffTag.PHOTOMETRIC));
        Assert.Equal((int)Compression.LZW, Tag(first, TiffTag.COMPRESSION));
        int[] pixels = Decode(first);
        AssertRgb(pixels[75 * 200 + 50], 0, 0, 255);
        AssertRgb(pixels[75 * 200 + 150], 255, 255, 255);
        AssertRgb(pixels[225 * 200 + 50], 255, 0, 0);
        AssertRgb(pixels[225 * 200 + 150], 0, 255, 0);

        using Tiff second = Open(result.Files[1]);
        Assert.Equal(1, second.NumberOfDirectories());
        AssertDimensions(second, 200, 400); // /Rotate 90 changes displayed page dimensions.
        AssertDpi(second, 200);
        AssertRgb(Decode(second)[200 * 200 + 100], 255, 255, 0);
    }

    [Fact]
    public void FilledAcroFormIncludesSavedWidgetAppearance()
    {
        string input = Path.Combine(root, "filled-form.pdf");
        PdfFixture.WriteFilledAcroForm(input);
        ConversionResult result = Convert(input, new ConversionOptions { Dpi = 72, ColorMode = ColorMode.Color });
        using Tiff tiff = Open(Assert.Single(result.Files));
        AssertDimensions(tiff, 72, 72);
        int[] pixels = Decode(tiff);
        // The page's content stream is empty. Red exists only inside the saved
        // AcroForm widget appearance, which ordinary page rendering omits.
        AssertRgb(pixels[36 * 72 + 36], 255, 0, 0);
        AssertRgb(pixels[6 * 72 + 6], 255, 255, 255);
    }

    [Theory]
    [InlineData(72, 72, 108)]
    [InlineData(144, 144, 216)]
    [InlineData(300, 300, 450)]
    [InlineData(400, 400, 600)]
    public void DpiControlsRasterDimensionsAndResolutionMetadata(int dpi, int width, int height)
    {
        ConversionResult result = Convert(CreateTwoPagePdf(), new ConversionOptions { Dpi = dpi });
        using Tiff first = Open(result.Files[0]);
        AssertDimensions(first, width, height);
        AssertDpi(first, dpi);
        Assert.Equal(width * height, Decode(first).Length);
    }

    [Fact]
    public void GrayscaleUsesOneEightBitSampleAndPreservesDistinctLuminance()
    {
        ConversionResult result = Convert(CreateTwoPagePdf(), new ConversionOptions { Dpi = 72, ColorMode = ColorMode.Grayscale });
        using Tiff first = Open(result.Files[0]);
        Assert.Equal(1, Tag(first, TiffTag.SAMPLESPERPIXEL));
        Assert.Equal(8, Tag(first, TiffTag.BITSPERSAMPLE));
        int[] pixels = Decode(first);
        int blue = pixels[27 * 72 + 18];
        int white = pixels[27 * 72 + 54];
        int red = pixels[81 * 72 + 18];
        int green = pixels[81 * 72 + 54];
        foreach (int pixel in new[] { blue, white, red, green })
        {
            Assert.Equal(Red(pixel), Green(pixel));
            Assert.Equal(Green(pixel), Blue(pixel));
        }
        Assert.True(Red(blue) < Red(red), "Blue must have lower luminance than red.");
        Assert.True(Red(red) < Red(green), "Red must have lower luminance than green.");
        AssertRgb(white, 255, 255, 255);
    }

    [Fact]
    public void Group4EncodesTrueOneBitPixelsIncludingPartialFinalByte()
    {
        string input = Path.Combine(root, "bitonal.pdf");
        PdfFixture.WriteBitonal(input);
        ConversionResult result = Convert(input, new ConversionOptions
        {
            Dpi = 72,
            ColorMode = ColorMode.BlackAndWhite,
            Compression = TiffCompression.Group4,
            Threshold = 180
        });

        using Tiff tiff = Open(Assert.Single(result.Files));
        AssertDimensions(tiff, 73, 41);
        Assert.Equal(1, Tag(tiff, TiffTag.SAMPLESPERPIXEL));
        Assert.Equal(1, Tag(tiff, TiffTag.BITSPERSAMPLE));
        Assert.Equal((int)Compression.CCITTFAX4, Tag(tiff, TiffTag.COMPRESSION));
        int[] pixels = Decode(tiff);
        for (int y = 0; y < 41; y++)
        {
            AssertRgb(pixels[y * 73 + 10], 0, 0, 0);
            AssertRgb(pixels[y * 73 + 72], 255, 255, 255);
        }
    }

    [Theory]
    [InlineData(100, 255)]
    [InlineData(230, 0)]
    public void BlackAndWhiteThresholdAffectsGrayPixels(int threshold, int expected)
    {
        string input = Path.Combine(root, "threshold.pdf");
        PdfFixture.WriteBitonal(input);
        ConversionResult result = Convert(input, new ConversionOptions
        {
            Dpi = 72,
            ColorMode = ColorMode.BlackAndWhite,
            Compression = TiffCompression.Lzw,
            Threshold = (byte)threshold
        });
        using Tiff tiff = Open(Assert.Single(result.Files));
        AssertRgb(Decode(tiff)[30 * 73 + 60], expected, expected, expected);
    }

    [Fact]
    public void MultiPageOutputPreservesOrderAndEachPageDimensions()
    {
        ConversionResult result = Convert(CreateTwoPagePdf(), new ConversionOptions
        {
            Dpi = 72,
            ColorMode = ColorMode.Color,
            OutputMode = OutputMode.MultiPage
        });
        Assert.Equal(2, result.PageCount);
        using Tiff tiff = Open(Assert.Single(result.Files));
        Assert.Equal(2, tiff.NumberOfDirectories());
        AssertDimensions(tiff, 72, 108);
        AssertDpi(tiff, 72);
        AssertRgb(Decode(tiff)[27 * 72 + 18], 0, 0, 255);
        Assert.True(tiff.ReadDirectory());
        AssertDimensions(tiff, 72, 144);
        AssertDpi(tiff, 72);
        AssertRgb(Decode(tiff)[72 * 72 + 36], 255, 255, 0);
        Assert.False(tiff.ReadDirectory());
    }

    [Theory]
    [InlineData(TiffCompression.None)]
    [InlineData(TiffCompression.Deflate)]
    [InlineData(TiffCompression.PackBits)]
    public void AlternativeCompressionModesRoundTripPixels(TiffCompression compression)
    {
        ConversionResult result = Convert(CreateTwoPagePdf(), new ConversionOptions { Dpi = 72, ColorMode = ColorMode.Color, Compression = compression });
        using Tiff tiff = Open(result.Files[0]);
        int tag = Tag(tiff, TiffTag.COMPRESSION);
        if (compression == TiffCompression.None)
            Assert.Equal((int)Compression.NONE, tag);
        else if (compression == TiffCompression.PackBits)
            Assert.Equal((int)Compression.PACKBITS, tag);
        else
            Assert.Contains(tag, new[] { (int)Compression.DEFLATE, (int)Compression.ADOBE_DEFLATE });
        AssertRgb(Decode(tiff)[81 * 72 + 18], 255, 0, 0);
    }

    [Fact]
    public void DefaultsProduceSeparateOneBitPackBitsTiffsAt400Dpi()
    {
        ConversionResult result = Convert(CreateTwoPagePdf(), new ConversionOptions());
        Assert.Equal(2, result.Files.Count);
        using Tiff first = Open(result.Files[0]);
        Assert.Equal(1, first.NumberOfDirectories());
        AssertDimensions(first, 400, 600);
        AssertDpi(first, 400);
        Assert.Equal(1, Tag(first, TiffTag.SAMPLESPERPIXEL));
        Assert.Equal(1, Tag(first, TiffTag.BITSPERSAMPLE));
        Assert.Equal((int)Compression.PACKBITS, Tag(first, TiffTag.COMPRESSION));
        int[] pixels = Decode(first);
        AssertRgb(pixels[150 * 400 + 100], 0, 0, 0); // Blue becomes black.
        AssertRgb(pixels[150 * 400 + 300], 255, 255, 255);
        AssertRgb(pixels[450 * 400 + 100], 0, 0, 0); // Red becomes black.
        AssertRgb(pixels[450 * 400 + 300], 0, 0, 0); // Green is below threshold 180.
        using Tiff second = Open(result.Files[1]);
        Assert.Equal(1, second.NumberOfDirectories());
        AssertDimensions(second, 400, 800);
        AssertDpi(second, 400);
        Assert.Equal(1, Tag(second, TiffTag.BITSPERSAMPLE));
        Assert.Equal((int)Compression.PACKBITS, Tag(second, TiffTag.COMPRESSION));
        AssertRgb(Decode(second)[400 * 400 + 200], 255, 255, 255); // Yellow becomes white.
    }

    [Theory]
    [InlineData(ColorMode.Color, OutputMode.SeparateFiles)]
    [InlineData(ColorMode.Color, OutputMode.MultiPage)]
    [InlineData(ColorMode.Grayscale, OutputMode.SeparateFiles)]
    [InlineData(ColorMode.Grayscale, OutputMode.MultiPage)]
    [InlineData(ColorMode.BlackAndWhite, OutputMode.SeparateFiles)]
    [InlineData(ColorMode.BlackAndWhite, OutputMode.MultiPage)]
    public void PackBitsExactlyMatchesUncompressedPixelsForEveryColorAndOutputMode(ColorMode color, OutputMode mode)
    {
        string input = Path.Combine(root, "bitonal.pdf");
        PdfFixture.WritePackBitsTwoPages(input); // 73 pixels includes a partial byte in one-bit output.
        var options = new ConversionOptions { Dpi = 72, ColorMode = color, OutputMode = mode };
        ConversionResult plain = Convert(input, options with { Compression = TiffCompression.None });
        ConversionResult packed = Convert(input, options with { Compression = TiffCompression.PackBits });
        Assert.Equal(mode == OutputMode.MultiPage ? 1 : 2, packed.Files.Count);
        for (int file = 0; file < packed.Files.Count; file++)
        {
            using Tiff expected = Open(plain.Files[file]);
            using Tiff actual = Open(packed.Files[file]);
            Assert.Equal(mode == OutputMode.MultiPage ? 2 : 1, actual.NumberOfDirectories());
            do
            {
                Assert.Equal((int)Compression.PACKBITS, Tag(actual, TiffTag.COMPRESSION));
                Assert.Equal(Decode(expected), Decode(actual));
                bool more = actual.ReadDirectory();
                Assert.Equal(more, expected.ReadDirectory());
                if (!more) break;
            } while (true);
        }
    }

    [Fact]
    public void CyrillicPathsAndRepeatedConversionsPreserveExistingFiles()
    {
        string inputFolder = Directory.CreateDirectory(Path.Combine(root, "Исходные анкеты")).FullName;
        string input = Path.Combine(inputFolder, "Анкета 07.pdf");
        PdfFixture.WriteTwoPages(input);
        string output = Directory.CreateDirectory(Path.Combine(root, "Готовые файлы")).FullName;
        string foreign = Path.Combine(output, "Анкета 07_001.tiff");
        byte[] foreignContent = [12, 34, 56, 78];
        File.WriteAllBytes(foreign, foreignContent);

        ConversionResult first = converter.Convert(input, output, new ConversionOptions { Dpi = 72 });
        byte[] originalFirst = File.ReadAllBytes(first.Files[0]);
        ConversionResult second = converter.Convert(input, output, new ConversionOptions { Dpi = 72 });

        Assert.NotEqual(first.OutputFolder, second.OutputFolder);
        Assert.Equal(output, Path.GetDirectoryName(first.OutputFolder));
        Assert.Equal(output, Path.GetDirectoryName(second.OutputFolder));
        Assert.Equal(foreignContent, File.ReadAllBytes(foreign));
        Assert.Equal(originalFirst, File.ReadAllBytes(first.Files[0]));
        Assert.Equal(3, Directory.GetFileSystemEntries(output).Length);
        Assert.All(first.Files.Concat(second.Files), file =>
        {
            using Tiff tiff = Open(file);
            Assert.NotEmpty(Decode(tiff));
        });
    }

    [Fact]
    public void AlreadyCancelledConversionLeavesNoPartialOutput()
    {
        string input = CreateTwoPagePdf();
        string output = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => converter.Convert(input, output,
            new ConversionOptions(), cancellationToken: cancellation.Token));
        Assert.Empty(Directory.GetFileSystemEntries(output));
    }

    [Theory]
    [InlineData(OutputMode.SeparateFiles)]
    [InlineData(OutputMode.MultiPage)]
    public void CancellationAfterFirstPageRemovesOnlyUnfinishedConversion(OutputMode mode)
    {
        string input = CreateTwoPagePdf();
        string output = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
        string marker = Path.Combine(output, "keep.txt");
        File.WriteAllText(marker, "keep me");
        using var cancellation = new CancellationTokenSource();
        var progress = new ImmediateProgress(p =>
        {
            if (p.CompletedPages >= 1)
                cancellation.Cancel();
        });

        Assert.ThrowsAny<OperationCanceledException>(() => converter.Convert(input, output,
            new ConversionOptions { Dpi = 72, OutputMode = mode }, progress, cancellation.Token));
        Assert.Equal(new[] { marker }, Directory.GetFileSystemEntries(output));
        Assert.Equal("keep me", File.ReadAllText(marker));
    }

    [Fact]
    public void InvalidPdfReportsFailureAndLeavesNoPartialOutput()
    {
        string input = Path.Combine(root, "invalid.pdf");
        File.WriteAllText(input, "This is not a PDF.");
        string output = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
        Assert.Throws<InvalidOperationException>(() => converter.Convert(input, output, new ConversionOptions()));
        Assert.Empty(Directory.GetFileSystemEntries(output));
    }

    [Theory]
    [InlineData(OutputMode.SeparateFiles)]
    [InlineData(OutputMode.MultiPage)]
    public void OversizedLaterPageFailsWithoutLeavingEarlierPages(OutputMode mode)
    {
        string input = Path.Combine(root, "large-page.pdf");
        PdfFixture.WriteOversizedSecondPage(input);
        string output = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
        Assert.Throws<InvalidOperationException>(() => converter.Convert(input, output,
            new ConversionOptions { Dpi = 200, OutputMode = mode }));
        Assert.Empty(Directory.GetFileSystemEntries(output));
    }

    [Fact]
    public void InputAboveMemoryLimitIsRejectedBeforeReadingWholeFile()
    {
        string input = Path.Combine(root, "large-input.pdf");
        // Extending a new file creates a sparse test input rather than allocating
        // a half-gigabyte managed array or copying a half-gigabyte fixture.
        using (FileStream stream = File.Create(input))
            stream.SetLength(512L * 1024 * 1024 + 1);
        string output = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(() =>
            converter.Convert(input, output, new ConversionOptions()));
        Assert.Contains("512", exception.Message);
        Assert.Empty(Directory.GetFileSystemEntries(output));
    }

    public static TheoryData<ConversionOptions> InvalidOptions => new()
    {
        new ConversionOptions { Dpi = 71 },
        new ConversionOptions { Dpi = 601 },
        new ConversionOptions { ColorMode = (ColorMode)99 },
        new ConversionOptions { OutputMode = (OutputMode)99 },
        new ConversionOptions { Compression = (TiffCompression)99 },
        new ConversionOptions { Compression = TiffCompression.Group4, ColorMode = ColorMode.Color },
        new ConversionOptions { Compression = TiffCompression.Group4, ColorMode = ColorMode.Grayscale }
    };

    [Theory]
    [MemberData(nameof(InvalidOptions))]
    public void InvalidSettingsFailBeforeCreatingPartialOutput(ConversionOptions options)
    {
        string input = CreateTwoPagePdf();
        string output = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
        Assert.ThrowsAny<ArgumentException>(() => converter.Convert(input, output, options));
        Assert.Empty(Directory.GetFileSystemEntries(output));
    }

    [Fact]
    public void ProgressReportsPageCompletionAndTotal()
    {
        var reports = new List<ConversionProgress>();
        Convert(CreateTwoPagePdf(), new ConversionOptions { Dpi = 72 }, new ImmediateProgress(reports.Add));
        Assert.Contains(reports, p => p.CompletedPages == 1 && p.TotalPages == 2);
        Assert.Contains(reports, p => p.CompletedPages == 2 && p.TotalPages == 2);
        Assert.All(reports, p => Assert.InRange(p.CompletedPages, 0, p.TotalPages));
    }

    private string CreateTwoPagePdf()
    {
        string input = Path.Combine(root, "sample.pdf");
        PdfFixture.WriteTwoPages(input);
        return input;
    }

    private ConversionResult Convert(string input, ConversionOptions options, IProgress<ConversionProgress>? progress = null)
        => converter.Convert(input, Path.Combine(root, "output"), options, progress);

    private static Tiff Open(string path) => Tiff.Open(path, "r") ?? throw new InvalidOperationException($"Cannot decode TIFF: {path}");
    private static int Tag(Tiff tiff, TiffTag tag) => tiff.GetField(tag)[0].ToInt();
    private static void AssertDimensions(Tiff tiff, int width, int height)
    {
        Assert.Equal(width, Tag(tiff, TiffTag.IMAGEWIDTH));
        Assert.Equal(height, Tag(tiff, TiffTag.IMAGELENGTH));
    }

    private static void AssertDpi(Tiff tiff, double expected)
    {
        Assert.Equal((int)ResUnit.INCH, Tag(tiff, TiffTag.RESOLUTIONUNIT));
        Assert.Equal(expected, tiff.GetField(TiffTag.XRESOLUTION)[0].ToDouble(), 2);
        Assert.Equal(expected, tiff.GetField(TiffTag.YRESOLUTION)[0].ToDouble(), 2);
    }

    private static int[] Decode(Tiff tiff)
    {
        int[] pixels = new int[Tag(tiff, TiffTag.IMAGEWIDTH) * Tag(tiff, TiffTag.IMAGELENGTH)];
        Assert.True(tiff.ReadRGBAImageOriented(Tag(tiff, TiffTag.IMAGEWIDTH), Tag(tiff, TiffTag.IMAGELENGTH), pixels, Orientation.TOPLEFT));
        return pixels;
    }

    private static int Red(int pixel) => pixel & 255;
    private static int Green(int pixel) => (pixel >> 8) & 255;
    private static int Blue(int pixel) => (pixel >> 16) & 255;
    private static void AssertRgb(int pixel, int red, int green, int blue)
    {
        Assert.InRange(Red(pixel), Math.Max(0, red - 2), Math.Min(255, red + 2));
        Assert.InRange(Green(pixel), Math.Max(0, green - 2), Math.Min(255, green + 2));
        Assert.InRange(Blue(pixel), Math.Max(0, blue - 2), Math.Min(255, blue + 2));
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
            Directory.Delete(root, recursive: true);
    }

    private sealed class ImmediateProgress(Action<ConversionProgress> report) : IProgress<ConversionProgress>
    {
        public void Report(ConversionProgress value) => report(value);
    }
}
