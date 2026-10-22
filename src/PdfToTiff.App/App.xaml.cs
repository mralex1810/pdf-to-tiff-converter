using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace PdfToTiff.App;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // This utility only draws controls; it does not need GPU acceleration.
        RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;
        StartupDiagnostics.Write("Creating window; render mode: SoftwareOnly");
        MainWindow = new MainWindow();
        MainWindow.Show();
        StartupDiagnostics.Write("Window shown");
    }
}
