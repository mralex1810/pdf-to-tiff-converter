using System.Globalization;
using System.Text;

namespace PdfToTiff.Tests;

// A real, self-contained PDF with an xref table. The fixtures use only vector
// rectangles, so font installation and font substitution cannot affect tests.
internal static class PdfFixture
{
    internal static void WriteTwoPages(string path) => Write(path,
        new Page(72, 108, "1 0 0 rg 0 0 36 54 re f\n0 1 0 rg 36 0 36 54 re f\n0 0 1 rg 0 54 36 54 re f\n"),
        new Page(144, 72, "1 1 0 rg 0 0 144 72 re f\n", 90));

    internal static void WriteBitonal(string path) => Write(path,
        new Page(73, 41, "0 0 0 rg 0 0 36 41 re f\n0.8 0.8 0.8 rg 36 0 37 20 re f\n"));

    internal static void WriteOversizedSecondPage(string path) => Write(path,
        new Page(72, 72, "0 0 0 rg 0 0 72 72 re f\n"),
        new Page(5000, 5000, "0 0 0 rg 0 0 5000 5000 re f\n"));

    internal static void WriteFilledAcroForm(string path)
    {
        const string appearance = "1 0 0 rg 0 0 48 48 re f\n";
        WriteObjects(path,
        [
            "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>",
            "<< /Length 0 >>\nstream\nendstream",
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Filled field) /V (Saved answer) /Rect [12 12 60 60] /P 3 0 R /F 4 /AP << /N 7 0 R >> >>",
            "<< /Fields [5 0 R] /NeedAppearances false >>",
            $"<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 48 48] /Resources << >> /Length {Encoding.ASCII.GetByteCount(appearance)} >>\nstream\n{appearance}endstream"
        ]);
    }

    private static void Write(string path, params Page[] pages)
    {
        var objects = new List<string>
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            $"<< /Type /Pages /Kids [{string.Join(" ", Enumerable.Range(0, pages.Length).Select(i => $"{3 + i * 2} 0 R"))}] /Count {pages.Length} >>"
        };

        foreach (Page page in pages)
        {
            int contentObject = objects.Count + 2;
            objects.Add(FormattableString.Invariant($"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page.Width} {page.Height}] /Rotate {page.Rotation} /Resources << >> /Contents {contentObject} 0 R >>"));
            objects.Add($"<< /Length {Encoding.ASCII.GetByteCount(page.Content)} >>\nstream\n{page.Content}endstream");
        }

        WriteObjects(path, objects);
    }

    private static void WriteObjects(string path, IReadOnlyList<string> objects)
    {
        using var stream = File.Create(path);
        void Append(string value) => stream.Write(Encoding.ASCII.GetBytes(value));
        Append("%PDF-1.4\n");
        var offsets = new List<long> { 0 };
        for (int i = 0; i < objects.Count; i++)
        {
            offsets.Add(stream.Position);
            Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }

        long xrefOffset = stream.Position;
        Append($"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (long offset in offsets.Skip(1))
            Append($"{offset.ToString("D10", CultureInfo.InvariantCulture)} 00000 n \n");
        Append($"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xrefOffset}\n%%EOF\n");
    }

    private sealed record Page(int Width, int Height, string Content, int Rotation = 0);
}
