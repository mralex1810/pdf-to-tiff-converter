using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace PdfToTiff.App;

internal static class StartupDiagnostics
{
    private static readonly object Gate = new();
    private static string? _logPath;
    private static int _reportingFatal;

    internal static void Initialize()
    {
        foreach (string root in new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Path.GetTempPath()
        })
        {
            try
            {
                if (string.IsNullOrWhiteSpace(root)) continue;
                string folder = Path.Combine(root, "PdfToTiff", "Logs");
                Directory.CreateDirectory(folder);
                string path = Path.Combine(folder, "startup.log");
                if (File.Exists(path) && new FileInfo(path).Length > 512 * 1024)
                    File.Move(path, Path.Combine(folder, "startup.previous.log"), overwrite: true);
                File.AppendAllText(path, $"\n--- Startup {DateTimeOffset.Now:O}, PID {Environment.ProcessId} ---\n");
                _logPath = path;
                break;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
            {
                // Logging must never prevent the application from starting.
            }
        }
        Write("Version: " + Assembly.GetExecutingAssembly().GetName().Version);
        Write("OS: " + RuntimeInformation.OSDescription);
        Write("OS architecture: " + RuntimeInformation.OSArchitecture + "; process: " + RuntimeInformation.ProcessArchitecture);
        Write("Runtime: " + RuntimeInformation.FrameworkDescription);
        Write("Application directory: " + AppContext.BaseDirectory);
    }

    internal static void Write(string message)
    {
        if (_logPath is null) return;
        try
        {
            lock (Gate)
                File.AppendAllText(_logPath, $"{DateTimeOffset.Now:O} {message}\n");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    internal static void ReportFatal(Exception error)
    {
        Write("Fatal startup/UI exception: " + error);
        if (Interlocked.Exchange(ref _reportingFatal, 1) != 0) return;
        try
        {
            string location = _logPath is not null
                ? "\n\nПодробности сохранены в:\n" + _logPath
                : "\n\nНе удалось записать журнал ошибки.";
            // Use Win32 directly: WPF may be the component that failed to load.
            MessageBoxW(IntPtr.Zero,
                "Не удалось запустить PDF → TIFF.\n\n" + error.Message + location,
                "PDF → TIFF — ошибка запуска", 0x10);
        }
        catch (Exception) { /* Preserve the original failure and exit code. */ }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
}
