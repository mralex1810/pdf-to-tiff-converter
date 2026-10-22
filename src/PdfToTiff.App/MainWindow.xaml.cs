using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;
using PdfToTiff.Core;

namespace PdfToTiff.App;

public partial class MainWindow : Window
{
    private CancellationTokenSource? _cancellation;
    private Task? _conversionTask;
    private string? _resultFolder;
    private bool _updatingOptions;
    private bool _isClosing;
    private bool _allowClose;

    public MainWindow()
    {
        InitializeComponent();
        OutputPath.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "PDF в TIFF");
    }

    private void ChoosePdf_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Выберите PDF",
            Filter = "Документы PDF (*.pdf)|*.pdf",
            CheckFileExists = true,
            Multiselect = false,
        };
        if (dialog.ShowDialog(this) == true)
            SelectPdf(dialog.FileName);
    }

    private void ChooseOutput_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog { Title = "Выберите папку результата", Multiselect = false };
        if (Directory.Exists(OutputPath.Text))
            dialog.InitialDirectory = OutputPath.Text;
        if (dialog.ShowDialog(this) == true)
            OutputPath.Text = dialog.FolderName;
    }

    private void SelectPdf(string path)
    {
        InputPath.Text = path;
        StatusText.Text = "Готов к конвертации: " + Path.GetFileName(path);
        ResultText.Visibility = Visibility.Collapsed;
        OpenResultButton.Visibility = Visibility.Collapsed;
        _resultFolder = null;
        ConversionProgressBar.Value = 0;
    }

    private void Window_DragOver(object sender, DragEventArgs e)
    {
        e.Effects = !_isClosing && _conversionTask is null && TryGetDroppedPdf(e, out _)
            ? DragDropEffects.Copy
            : DragDropEffects.None;
        e.Handled = true;
    }

    private void Window_Drop(object sender, DragEventArgs e)
    {
        if (!_isClosing && _conversionTask is null)
        {
            if (TryGetDroppedPdf(e, out var path))
                SelectPdf(path!);
            else
                StatusText.Text = "Перетащите один файл с расширением .pdf.";
        }
        e.Handled = true;
    }

    private static bool TryGetDroppedPdf(DragEventArgs e, out string? path)
    {
        path = null;
        if (!e.Data.GetDataPresent(DataFormats.FileDrop) ||
            e.Data.GetData(DataFormats.FileDrop) is not string[] { Length: 1 } paths ||
            !string.Equals(Path.GetExtension(paths[0]), ".pdf", StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(paths[0]))
            return false;
        path = paths[0];
        return true;
    }

    private void ColorChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // SelectionChanged may run while InitializeComponent is still creating other controls.
        if (_updatingOptions || CompressionChoice is null || ThresholdPanel is null)
            return;
        _updatingOptions = true;
        try
        {
            bool monochrome = SelectedEnum<ColorMode>(ColorChoice) == ColorMode.BlackAndWhite;
            if (monochrome)
                CompressionChoice.SelectedIndex = 3;
            else if (SelectedEnum<TiffCompression>(CompressionChoice) == TiffCompression.Group4)
                CompressionChoice.SelectedIndex = 0;
            UpdateColorHint(monochrome);
        }
        finally { _updatingOptions = false; }
    }

    private void CompressionChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_updatingOptions || ColorChoice is null || ThresholdPanel is null)
            return;
        _updatingOptions = true;
        try
        {
            if (SelectedEnum<TiffCompression>(CompressionChoice) == TiffCompression.Group4)
                ColorChoice.SelectedIndex = 2;
            UpdateColorHint(SelectedEnum<ColorMode>(ColorChoice) == ColorMode.BlackAndWhite);
        }
        finally { _updatingOptions = false; }
    }

    private void UpdateColorHint(bool monochrome)
    {
        ThresholdPanel.Visibility = monochrome ? Visibility.Visible : Visibility.Collapsed;
        CompressionHint.Text = SelectedEnum<TiffCompression>(CompressionChoice) == TiffCompression.Group4
            ? "Group 4 использует чёрно-белый режим. При выборе этого сжатия цветность переключается автоматически."
            : "LZW и Deflate сохраняют все детали выбранного режима. Более высокое DPI увеличивает время и размер файлов.";
    }

    private static T SelectedEnum<T>(ComboBox choice) where T : struct, Enum =>
        Enum.Parse<T>((string)((ComboBoxItem)choice.SelectedItem).Tag);

    private async void Convert_Click(object sender, RoutedEventArgs e)
    {
        if (_conversionTask is not null || _isClosing)
            return;
        string input = InputPath.Text.Trim();
        string output = OutputPath.Text.Trim();
        if (!File.Exists(input))
        {
            StatusText.Text = "Выберите существующий PDF-файл.";
            return;
        }
        if (string.IsNullOrWhiteSpace(output))
        {
            StatusText.Text = "Укажите папку для результата.";
            OutputPath.Focus();
            return;
        }

        var options = new ConversionOptions
        {
            Dpi = int.Parse((string)((ComboBoxItem)DpiChoice.SelectedItem).Tag),
            ColorMode = SelectedEnum<ColorMode>(ColorChoice),
            OutputMode = SelectedEnum<OutputMode>(OutputChoice),
            Compression = SelectedEnum<TiffCompression>(CompressionChoice),
            Threshold = (byte)Math.Round(ThresholdSlider.Value),
        };
        _conversionTask = RunConversionAsync(input, output, options);
        try { await _conversionTask; }
        finally { _conversionTask = null; }
    }

    private async Task RunConversionAsync(string input, string output, ConversionOptions options)
    {
        using var cancellation = new CancellationTokenSource();
        _cancellation = cancellation;
        SetBusy(true);
        _resultFolder = null;
        ResultText.Visibility = Visibility.Collapsed;
        OpenResultButton.Visibility = Visibility.Collapsed;
        ConversionProgressBar.Value = 0;
        ConversionProgressBar.IsIndeterminate = true;
        StatusText.Text = "Открываем PDF…";
        bool acceptingProgress = true;
        var progress = new Progress<ConversionProgress>(update =>
        {
            if (!acceptingProgress || _isClosing || cancellation.IsCancellationRequested)
                return;
            ConversionProgressBar.IsIndeterminate = update.TotalPages <= 0;
            ConversionProgressBar.Maximum = Math.Max(1, update.TotalPages);
            ConversionProgressBar.Value = Math.Clamp(update.CompletedPages, 0, Math.Max(1, update.TotalPages));
            StatusText.Text = update.Message;
        });
        try
        {
            var result = await Task.Run(() => new PdfConverter().Convert(input, output, options, progress, cancellation.Token));
            if (_isClosing)
                return;
            _resultFolder = result.OutputFolder;
            ConversionProgressBar.Maximum = Math.Max(1, result.PageCount);
            ConversionProgressBar.Value = ConversionProgressBar.Maximum;
            StatusText.Text = "Готово. Обработано страниц: " + result.PageCount + ".";
            ResultText.Text = "Создано файлов: " + result.Files.Count + ".\n" + result.OutputFolder;
            ResultText.Visibility = Visibility.Visible;
            OpenResultButton.Visibility = Visibility.Visible;
        }
        catch (OperationCanceledException)
        {
            if (!_isClosing)
                StatusText.Text = "Конвертация отменена.";
        }
        catch (Exception ex)
        {
            if (!_isClosing)
            {
                StatusText.Text = "Не удалось выполнить конвертацию.";
                ResultText.Text = ex switch
                {
                    UnauthorizedAccessException => "Нет доступа к исходному файлу или папке результата. Выберите доступную папку.",
                    IOException => "Ошибка чтения или записи: " + ex.Message,
                    _ => ex.Message,
                };
                ResultText.Visibility = Visibility.Visible;
            }
        }
        finally
        {
            // Prevent delayed progress callbacks from replacing the completion/error status.
            acceptingProgress = false;
            _cancellation = null;
            ConversionProgressBar.IsIndeterminate = false;
            if (!_isClosing)
                SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        FileControls.IsEnabled = !busy;
        OptionControls.IsEnabled = !busy;
        ConvertButton.IsEnabled = !busy;
        CancelButton.IsEnabled = busy;
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        _cancellation?.Cancel();
        CancelButton.IsEnabled = false;
        StatusText.Text = "Отменяем конвертацию…";
    }

    private void OpenResult_Click(object sender, RoutedEventArgs e)
    {
        if (_resultFolder is null)
            return;
        try
        {
            Process.Start(new ProcessStartInfo { FileName = _resultFolder, UseShellExecute = true });
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
        {
            StatusText.Text = "Не удалось открыть папку: " + ex.Message;
        }
    }

    private async void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_allowClose || _conversionTask is null)
            return;
        e.Cancel = true;
        if (_isClosing)
            return;
        _isClosing = true;
        StatusText.Text = "Завершаем текущую операцию…";
        CancelButton.IsEnabled = false;
        _cancellation?.Cancel();
        try { await _conversionTask; }
        finally
        {
            _allowClose = true;
            Close();
        }
    }
}
