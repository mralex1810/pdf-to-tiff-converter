using System.Runtime.CompilerServices;

namespace PdfToTiff.App;

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        try { StartupDiagnostics.Initialize(); }
        catch (Exception) { /* A logging failure must not prevent startup. */ }
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception error)
                StartupDiagnostics.Write("Unhandled exception: " + error);
        };
        try
        {
            return RunDesktopApplication();
        }
        catch (Exception error)
        {
            StartupDiagnostics.ReportFatal(error);
            return 1;
        }
    }

    // Keep WPF assembly loading/JIT behind the startup error boundary.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunDesktopApplication()
    {
        StartupDiagnostics.Write("Loading WPF application");
        var application = new App();
        application.DispatcherUnhandledException += (_, e) =>
        {
            e.Handled = true;
            StartupDiagnostics.ReportFatal(e.Exception);
            application.Shutdown(1);
        };
        StartupDiagnostics.Write("Loading application resources");
        application.InitializeComponent();
        StartupDiagnostics.Write("Application resources loaded");
        int result = application.Run();
        StartupDiagnostics.Write("Application exit code: " + result);
        return result;
    }
}
