using BitMiracle.LibTiff.Classic;

namespace PdfToTiff.Core;

internal sealed class TiffWriter : IDisposable
{
    private readonly Tiff _tiff;
    // Classic TIFF has 32-bit offsets. Keep a conservative upper bound even for LZW expansion.
    private long _uncompressedBytes;

    public TiffWriter(string path)
    {
        _tiff = Tiff.Open(path, "wl") ?? throw new IOException("Не удалось создать TIFF.");
    }

    public void AddPage(PdfiumDocument.RenderedPage page, ConversionOptions options, int pageIndex, int pageCount,
        CancellationToken cancellationToken)
    {
        bool monochrome = options.ColorMode == ColorMode.BlackAndWhite;
        int samples = options.ColorMode == ColorMode.Color ? 3 : 1;
        int rowBytes = monochrome ? (page.Width + 7) / 8 : checked(page.Width * samples);
        _uncompressedBytes = checked(_uncompressedBytes + (long)rowBytes * page.Height);
        if (_uncompressedBytes > 2_000_000_000)
            throw new InvalidOperationException("Многостраничный TIFF слишком большой. Выберите отдельный файл для каждой страницы или уменьшите DPI.");

        Set(TiffTag.IMAGEWIDTH, page.Width);
        Set(TiffTag.IMAGELENGTH, page.Height);
        Set(TiffTag.SAMPLESPERPIXEL, samples);
        Set(TiffTag.BITSPERSAMPLE, monochrome ? 1 : 8);
        Set(TiffTag.ORIENTATION, Orientation.TOPLEFT);
        Set(TiffTag.PLANARCONFIG, PlanarConfig.CONTIG);
        Set(TiffTag.PHOTOMETRIC, monochrome ? Photometric.MINISWHITE : samples == 3 ? Photometric.RGB : Photometric.MINISBLACK);
        Set(TiffTag.FILLORDER, FillOrder.MSB2LSB);
        Set(TiffTag.COMPRESSION, options.Compression switch
        {
            TiffCompression.Lzw => Compression.LZW,
            TiffCompression.Deflate => Compression.ADOBE_DEFLATE,
            TiffCompression.Group4 => Compression.CCITTFAX4,
            _ => Compression.NONE
        });
        if (!monochrome && options.Compression is TiffCompression.Lzw or TiffCompression.Deflate)
            Set(TiffTag.PREDICTOR, Predictor.HORIZONTAL);
        Set(TiffTag.ROWSPERSTRIP, Math.Max(1, 64 * 1024 / rowBytes));
        Set(TiffTag.XRESOLUTION, (float)options.Dpi);
        Set(TiffTag.YRESOLUTION, (float)options.Dpi);
        Set(TiffTag.RESOLUTIONUNIT, ResUnit.INCH);
        Set(TiffTag.SOFTWARE, "PDF to TIFF");
        if (pageCount > 1)
        {
            Set(TiffTag.SUBFILETYPE, FileType.PAGE);
            Set(TiffTag.PAGENUMBER, pageIndex, pageCount);
        }

        var bgra = new byte[checked(page.Width * 4)];
        var row = new byte[rowBytes];
        for (int y = 0; y < page.Height; y++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            page.CopyBgraRow(y, bgra);
            if (monochrome) Array.Clear(row);
            for (int x = 0; x < page.Width; x++)
            {
                int offset = x * 4;
                byte blue = bgra[offset], green = bgra[offset + 1], red = bgra[offset + 2];
                if (samples == 3)
                {
                    row[x * 3] = red;
                    row[x * 3 + 1] = green;
                    row[x * 3 + 2] = blue;
                }
                else
                {
                    byte luminance = (byte)((299 * red + 587 * green + 114 * blue + 500) / 1000);
                    if (monochrome)
                    {
                        if (luminance < options.Threshold) row[x / 8] |= (byte)(0x80 >> (x % 8));
                    }
                    else row[x] = luminance;
                }
            }
            if (!_tiff.WriteScanline(row, y))
                throw new IOException("Не удалось записать TIFF. Проверьте свободное место на диске.");
        }
        if (!_tiff.WriteDirectory())
            throw new IOException("Не удалось завершить страницу TIFF.");
    }

    private void Set(TiffTag tag, params object[] values)
    {
        if (!_tiff.SetField(tag, values))
            throw new IOException($"Не удалось записать параметр TIFF: {tag}.");
    }

    public void Dispose() => _tiff.Dispose();
}
