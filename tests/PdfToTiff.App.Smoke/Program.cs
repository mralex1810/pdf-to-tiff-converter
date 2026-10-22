using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace PdfToTiff.App.Smoke;

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows())
                throw new PlatformNotSupportedException("The WPF smoke runner requires Windows.");
            var settings = Settings.Parse(args);
            var application = new global::PdfToTiff.App.App();
            application.InitializeComponent();
            application.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            SmokeRunner? runner = null;
            application.DispatcherUnhandledException += (_, e) =>
            {
                e.Handled = true;
                if (runner is not null)
                    runner.Fail(e.Exception);
                else
                {
                    Console.Error.WriteLine("WPF UI SMOKE FAILED DURING STARTUP: " + e.Exception);
                    application.Shutdown(1);
                }
            };
            // Let the real App.OnStartup create its normal window. Subclassing App
            // changes the BAML component type and prevents app.xaml from loading.
            application.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() =>
            {
                if (application.MainWindow is not global::PdfToTiff.App.MainWindow window)
                    throw new InvalidOperationException("The application did not create its main window.");
                runner = new SmokeRunner(application, window, settings);
                runner.Start();
            }));
            return application.Run();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("WPF UI SMOKE FAILED: " + ex);
            return 1;
        }
    }

    private sealed record Settings(string? PdfPath, string? OutputRoot, string ScreenshotPath)
    {
        public static Settings Parse(string[] args)
        {
            if (args.Length == 0)
                return new(null, null, Path.GetFullPath("ui-smoke.png"));
            if (args.Length == 2 && args[0] == "--screenshot")
                return new(null, null, Path.GetFullPath(args[1]));
            if (args.Length is not (2 or 3))
                throw new ArgumentException("Usage: PdfToTiff.App.Smoke [two-page.pdf output-folder [screenshot.png]] | --screenshot screenshot.png");
            string pdf = Path.GetFullPath(args[0]);
            if (!File.Exists(pdf))
                throw new FileNotFoundException("Smoke-test PDF does not exist.", pdf);
            string output = Path.GetFullPath(args[1]);
            string screenshot = Path.GetFullPath(args.Length == 3 ? args[2] : Path.Combine(output, "ui-smoke.png"));
            return new(pdf, output, screenshot);
        }
    }

    private sealed class SmokeRunner(Application application, Window window, Settings settings)
    {
        private readonly DispatcherTimer _poll = new(DispatcherPriority.Background);
        private readonly Stopwatch _elapsed = new();
        private HashSet<string> _existingFolders = new(StringComparer.OrdinalIgnoreCase);
        private bool _finished;

        public void Start()
        {
            try
            {
                AssertTag("OutputChoice", "SeparateFiles");
                AssertTag("DpiChoice", "200");
                AssertTag("ColorChoice", "Color");
                AssertTag("CompressionChoice", "Lzw");
                Console.WriteLine("PASS: default options are separate TIFF files, 200 DPI, color, LZW.");

                SelectTag("CompressionChoice", "Group4");
                AssertTag("ColorChoice", "BlackAndWhite");
                Assert(Control<StackPanel>("ThresholdPanel").Visibility == Visibility.Visible,
                    "Black-and-white threshold should be visible for Group 4.");
                SelectTag("ColorChoice", "Color");
                AssertTag("CompressionChoice", "Lzw");
                Assert(Control<StackPanel>("ThresholdPanel").Visibility == Visibility.Collapsed,
                    "Black-and-white threshold should be hidden for color output.");
                Console.WriteLine("PASS: Group 4 selects black-and-white; selecting color restores LZW.");

                if (settings.PdfPath is null)
                {
                    Finish(0);
                    return;
                }

                Directory.CreateDirectory(settings.OutputRoot!);
                _existingFolders = Directory.GetDirectories(settings.OutputRoot!).ToHashSet(StringComparer.OrdinalIgnoreCase);
                Control<TextBox>("InputPath").Text = settings.PdfPath;
                Control<TextBox>("OutputPath").Text = settings.OutputRoot!;
                _poll.Interval = TimeSpan.FromMilliseconds(100);
                _poll.Tick += Poll;
                _elapsed.Start();
                Control<Button>("ConvertButton").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                _poll.Start();
            }
            catch (Exception ex) { Fail(ex); }
        }

        private void Poll(object? sender, EventArgs e)
        {
            try
            {
                string status = Control<TextBlock>("StatusText").Text;
                if (status.StartsWith("Не удалось", StringComparison.Ordinal))
                    throw new InvalidOperationException(status + " " + Control<TextBlock>("ResultText").Text);
                if (_elapsed.Elapsed > TimeSpan.FromSeconds(60))
                    throw new TimeoutException("UI conversion did not finish within 60 seconds. Last status: " + status);
                if (!status.StartsWith("Готово.", StringComparison.Ordinal))
                    return;
                Assert(Control<Button>("ConvertButton").IsEnabled, "Convert button should be enabled after conversion.");
                Assert(!Control<Button>("CancelButton").IsEnabled, "Cancel button should be disabled after conversion.");
                Assert(Control<Button>("OpenResultButton").Visibility == Visibility.Visible,
                    "The result folder button should be visible after conversion.");
                VerifyOutput();
                Console.WriteLine("PASS: a click on the real Convert button produced two single-page TIFF files.");
                Finish(0);
            }
            catch (Exception ex) { Fail(ex); }
        }

        private void VerifyOutput()
        {
            string[] created = Directory.GetDirectories(settings.OutputRoot!)
                .Where(path => !_existingFolders.Contains(path)).ToArray();
            Assert(created.Length == 1, "Expected exactly one new conversion subfolder; found " + created.Length + ".");
            string[] files = Directory.GetFiles(created[0], "*", SearchOption.TopDirectoryOnly)
                .Where(path => Path.GetExtension(path).Equals(".tiff", StringComparison.OrdinalIgnoreCase) ||
                               Path.GetExtension(path).Equals(".tif", StringComparison.OrdinalIgnoreCase))
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase).ToArray();
            Assert(files.Length == 2, "Expected two TIFF files for the two-page fixture; found " + files.Length + ".");
            foreach (string path in files)
            {
                using var stream = File.OpenRead(path);
                var decoder = new TiffBitmapDecoder(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                Assert(decoder.Frames.Count == 1, Path.GetFileName(path) + " should contain exactly one page.");
                BitmapFrame frame = decoder.Frames[0];
                Assert(frame.PixelWidth > 0 && frame.PixelHeight > 0, Path.GetFileName(path) + " is empty.");
                Assert(Math.Abs(frame.DpiX - 200) < 1 && Math.Abs(frame.DpiY - 200) < 1,
                    Path.GetFileName(path) + " should have 200 DPI metadata.");
                Console.WriteLine($"PASS: {Path.GetFileName(path)} — 1 page, {frame.PixelWidth} × {frame.PixelHeight}, {frame.DpiX:0.##} DPI.");
            }
        }

        private T Control<T>(string name) where T : FrameworkElement =>
            window.FindName(name) as T ?? throw new InvalidOperationException("UI control was not found: " + name);

        private void AssertTag(string name, string expected)
        {
            var combo = Control<ComboBox>(name);
            string? actual = (combo.SelectedItem as ComboBoxItem)?.Tag?.ToString();
            Assert(actual == expected, $"{name}: expected {expected}, actual {actual ?? "<none>"}.");
        }

        private void SelectTag(string name, string tag)
        {
            var combo = Control<ComboBox>(name);
            combo.SelectedItem = combo.Items.Cast<ComboBoxItem>().Single(item => item.Tag?.ToString() == tag);
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
                throw new InvalidOperationException(message);
        }

        public void Fail(Exception ex)
        {
            if (_finished)
                return;
            Console.Error.WriteLine("WPF UI SMOKE FAILED: " + ex);
            Finish(1);
        }

        private void Finish(int exitCode)
        {
            if (_finished)
                return;
            _finished = true;
            _poll.Stop();
            try
            {
                window.UpdateLayout();
                var bitmap = new RenderTargetBitmap(
                    Math.Max(1, (int)Math.Ceiling(window.ActualWidth)),
                    Math.Max(1, (int)Math.Ceiling(window.ActualHeight)),
                    96, 96, PixelFormats.Pbgra32);
                bitmap.Render(window);
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(bitmap));
                Directory.CreateDirectory(Path.GetDirectoryName(settings.ScreenshotPath)!);
                using var screenshot = File.Create(settings.ScreenshotPath);
                encoder.Save(screenshot);
                Console.WriteLine("Screenshot: " + settings.ScreenshotPath);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Screenshot failed: " + ex);
                exitCode = 1;
            }

            int finalExitCode = exitCode;
            // Normal closure respects MainWindow's cancellation/cleanup handler.
            // A hung native conversion must not keep the smoke-test process alive forever.
            var shutdownGuard = new DispatcherTimer(DispatcherPriority.Send)
            {
                Interval = TimeSpan.FromSeconds(5),
            };
            shutdownGuard.Tick += (_, _) =>
            {
                shutdownGuard.Stop();
                Console.Error.WriteLine("WPF UI SMOKE FAILED: window did not close within 5 seconds.");
                application.Shutdown(1);
            };
            window.Closed += (_, _) =>
            {
                shutdownGuard.Stop();
                if (finalExitCode == 0)
                    Console.WriteLine("WPF UI SMOKE PASSED");
                application.Shutdown(finalExitCode);
            };
            shutdownGuard.Start();
            window.Close();
        }
    }
}
