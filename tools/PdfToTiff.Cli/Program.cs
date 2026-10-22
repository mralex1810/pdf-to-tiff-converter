using System.Globalization;
using System.Text.Json;
using PdfToTiff.Core;

if (args.Length < 2 || args.Contains("--help"))
{
    Console.WriteLine("PDF to TIFF — инструмент проверки ядра\n" +
        "Usage: PdfToTiff.Cli input.pdf output-folder [--dpi 200] [--color Color|Grayscale|BlackAndWhite]\n" +
        "       [--layout SeparateFiles|MultiPage] [--compression Lzw|Deflate|None|Group4] [--threshold 180]");
    return args.Contains("--help") ? 0 : 2;
}

using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
try
{
    var options = new ConversionOptions();
    for (int i = 2; i < args.Length; i += 2)
    {
        if (i + 1 >= args.Length) throw new ArgumentException("Отсутствует значение параметра " + args[i]);
        string value = args[i + 1];
        options = args[i] switch
        {
            "--dpi" => options with { Dpi = int.Parse(value, CultureInfo.InvariantCulture) },
            "--color" => options with { ColorMode = Enum.Parse<ColorMode>(value, true) },
            "--layout" => options with { OutputMode = Enum.Parse<OutputMode>(value, true) },
            "--compression" => options with { Compression = Enum.Parse<TiffCompression>(value, true) },
            "--threshold" => options with { Threshold = byte.Parse(value, CultureInfo.InvariantCulture) },
            _ => throw new ArgumentException("Неизвестный параметр " + args[i])
        };
    }
    var result = new PdfConverter().Convert(args[0], args[1], options, new ConsoleProgress(), cancellation.Token);
    Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
    return 0;
}
catch (OperationCanceledException) { Console.Error.WriteLine("Отменено."); return 130; }
catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }

file sealed class ConsoleProgress : IProgress<ConversionProgress>
{
    public void Report(ConversionProgress value) => Console.Error.WriteLine(value.Message);
}
