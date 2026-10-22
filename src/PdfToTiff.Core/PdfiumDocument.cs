using System.Runtime.InteropServices;

namespace PdfToTiff.Core;

// PdfConverter serializes complete document lifetimes: PDFium's public API is not thread safe.
internal sealed class PdfiumDocument : IDisposable
{
    private const long MaximumInputBytes = 512L * 1024 * 1024;
    private GCHandle _pinnedInput;
    private IntPtr _document;
    private IntPtr _form;
    private IntPtr _formInfo;
    private Delegate[]? _formCallbacks;
    private IntPtr _currentPage;
    private int _currentPageIndex = -1;
    private bool _initialized;
    public int PageCount { get; }

    public PdfiumDocument(string inputPath)
    {
        try
        {
            using var stream = new FileStream(inputPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length > MaximumInputBytes)
                throw new InvalidOperationException("PDF больше 512 МиБ. Разделите документ на части.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            _pinnedInput = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            Native.FPDF_InitLibrary();
            _initialized = true;
            _document = Native.FPDF_LoadMemDocument64(_pinnedInput.AddrOfPinnedObject(), (nuint)bytes.Length, IntPtr.Zero);
            if (_document == IntPtr.Zero)
            {
                var code = Native.FPDF_GetLastError();
                throw new InvalidOperationException(code == 4
                    ? "PDF защищён паролем. Сначала сохраните копию без пароля."
                    : $"Не удалось открыть PDF: файл повреждён или имеет неподдерживаемый формат (код {code}).");
            }
            PageCount = Native.FPDF_GetPageCount(_document);
            if (PageCount <= 0)
                throw new InvalidOperationException("В PDF нет доступных страниц.");
            int formType = Native.FPDF_GetFormType(_document);
            if (formType is 2 or 3)
                throw new InvalidOperationException("PDF содержит форму XFA. Сначала сохраните её как обычный PDF (например, через печать в PDF).");
            if (formType == 1)
                InitializeForms();
        }
        catch (DllNotFoundException error)
        {
            Dispose();
            throw new InvalidOperationException("Не найдена библиотека PDFium. Распакуйте приложение целиком из ZIP.", error);
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public RenderedPage Render(int pageIndex, int dpi, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var page = Native.FPDF_LoadPage(_document, pageIndex);
        if (page == IntPtr.Zero)
            throw new InvalidOperationException($"Не удалось прочитать страницу {pageIndex + 1}.");
        try
        {
            _currentPage = page;
            _currentPageIndex = pageIndex;
            if (_form != IntPtr.Zero)
                Native.FORM_OnAfterLoadPage(page, _form);
            var width = PixelDimension(Native.FPDF_GetPageWidth(page), dpi);
            var height = PixelDimension(Native.FPDF_GetPageHeight(page), dpi);
            if ((long)width * height > 80_000_000)
                throw new InvalidOperationException($"Страница {pageIndex + 1} слишком большая. Уменьшите DPI (лимит — 80 млн пикселей на страницу).");
            var bitmap = Native.FPDFBitmap_Create(width, height, 0);
            if (bitmap == IntPtr.Zero)
                throw new InvalidOperationException("Не хватает памяти для отрисовки страницы. Уменьшите DPI.");
            try
            {
                Native.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xFFFFFFFF);
                // FPDF_ANNOT: include visible annotation appearances. Never execute PDF JavaScript.
                Native.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x01);
                // FPDF_ANNOT excludes widget annotations: filled text/checkbox fields
                // need a second rendering pass through the form fill environment.
                if (_form != IntPtr.Zero)
                    Native.FPDF_FFLDraw(_form, bitmap, page, 0, 0, width, height, 0, 0x01);
                cancellationToken.ThrowIfCancellationRequested();
                return new RenderedPage(bitmap, width, height);
            }
            catch
            {
                Native.FPDFBitmap_Destroy(bitmap);
                throw;
            }
        }
        finally
        {
            if (_form != IntPtr.Zero)
                Native.FORM_OnBeforeClosePage(page, _form);
            _currentPage = IntPtr.Zero;
            _currentPageIndex = -1;
            Native.FPDF_ClosePage(page);
        }
    }

    private void InitializeForms()
    {
        // Keep both the unmanaged interface and reverse-P/Invoke delegates alive
        // until ExitFormFillEnvironment. This is the stable v1 interface from
        // fpdf_formfill.h; version 2/XFA callbacks are intentionally unavailable.
        var invalidate = new InvalidateCallback((_, _, _, _, _, _) => { });
        var setCursor = new IntCallback((_, _) => { });
        var setTimer = new SetTimerCallback((_, _, _) => 0);
        var killTimer = new IntCallback((_, _) => { });
        var getLocalTime = new GetLocalTimeCallback(_ => default);
        var getPage = new GetPageCallback((_, _, index) => index == _currentPageIndex ? _currentPage : IntPtr.Zero);
        var getCurrentPage = new GetCurrentPageCallback((_, _) => _currentPage);
        var getRotation = new GetRotationCallback((_, _) => 0);
        var namedAction = new PointerCallback((_, _) => { });
        _formCallbacks = [invalidate, setCursor, setTimer, killTimer, getLocalTime, getPage, getCurrentPage, getRotation, namedAction];
        var info = new FormFillInfoV1
        {
            Version = 1,
            Invalidate = Marshal.GetFunctionPointerForDelegate(invalidate),
            SetCursor = Marshal.GetFunctionPointerForDelegate(setCursor),
            SetTimer = Marshal.GetFunctionPointerForDelegate(setTimer),
            KillTimer = Marshal.GetFunctionPointerForDelegate(killTimer),
            GetLocalTime = Marshal.GetFunctionPointerForDelegate(getLocalTime),
            GetPage = Marshal.GetFunctionPointerForDelegate(getPage),
            GetCurrentPage = Marshal.GetFunctionPointerForDelegate(getCurrentPage),
            GetRotation = Marshal.GetFunctionPointerForDelegate(getRotation),
            ExecuteNamedAction = Marshal.GetFunctionPointerForDelegate(namedAction),
            // A null JavaScript platform prevents JavaScript execution, including
            // scripts associated with form fields. No document/page actions run.
            JsPlatform = IntPtr.Zero,
        };
        _formInfo = Marshal.AllocHGlobal(Marshal.SizeOf<FormFillInfoV1>());
        Marshal.StructureToPtr(info, _formInfo, false);
        _form = Native.FPDFDOC_InitFormFillEnvironment(_document, _formInfo);
        if (_form == IntPtr.Zero)
            throw new InvalidOperationException("Не удалось подготовить поля формы PDF к отрисовке.");
    }

    private static int PixelDimension(double points, int dpi)
    {
        double pixels = Math.Ceiling(points * dpi / 72.0);
        if (!double.IsFinite(pixels) || pixels < 1 || pixels > 100_000)
            throw new InvalidOperationException("Некорректный или слишком большой размер страницы PDF.");
        return (int)pixels;
    }

    public void Dispose()
    {
        if (_form != IntPtr.Zero)
        {
            Native.FPDFDOC_ExitFormFillEnvironment(_form);
            _form = IntPtr.Zero;
        }
        if (_formInfo != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_formInfo);
            _formInfo = IntPtr.Zero;
        }
        GC.KeepAlive(_formCallbacks);
        _formCallbacks = null;
        if (_document != IntPtr.Zero)
        {
            Native.FPDF_CloseDocument(_document);
            _document = IntPtr.Zero;
        }
        if (_pinnedInput.IsAllocated) _pinnedInput.Free();
        if (_initialized)
        {
            Native.FPDF_DestroyLibrary();
            _initialized = false;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FormFillInfoV1
    {
        public int Version;
        public IntPtr Release, Invalidate, OutputSelectedRect, SetCursor, SetTimer, KillTimer;
        public IntPtr GetLocalTime, OnChange, GetPage, GetCurrentPage, GetRotation;
        public IntPtr ExecuteNamedAction, SetTextFieldFocus, DoUriAction, DoGoToAction, JsPlatform;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PdfSystemTime
    {
        public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void InvalidateCallback(IntPtr self, IntPtr page, double left, double top, double right, double bottom);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void IntCallback(IntPtr self, int value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int SetTimerCallback(IntPtr self, int milliseconds, IntPtr callback);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate PdfSystemTime GetLocalTimeCallback(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate IntPtr GetPageCallback(IntPtr self, IntPtr document, int index);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate IntPtr GetCurrentPageCallback(IntPtr self, IntPtr document);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetRotationCallback(IntPtr self, IntPtr page);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void PointerCallback(IntPtr self, IntPtr value);

    internal sealed class RenderedPage : IDisposable
    {
        private IntPtr _bitmap;
        public int Width { get; }
        public int Height { get; }
        private readonly IntPtr _buffer;
        private readonly int _stride;

        public RenderedPage(IntPtr bitmap, int width, int height)
        {
            _bitmap = bitmap;
            Width = width;
            Height = height;
            _buffer = Native.FPDFBitmap_GetBuffer(bitmap);
            _stride = Native.FPDFBitmap_GetStride(bitmap);
        }

        public void CopyBgraRow(int row, byte[] destination) =>
            Marshal.Copy(IntPtr.Add(_buffer, checked(row * _stride)), destination, 0, checked(Width * 4));

        public void Dispose()
        {
            if (_bitmap == IntPtr.Zero) return;
            Native.FPDFBitmap_Destroy(_bitmap);
            _bitmap = IntPtr.Zero;
        }
    }

    private static class Native
    {
        private const string Library = "pdfium";
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDF_InitLibrary();
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDF_DestroyLibrary();
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr FPDF_LoadMemDocument64(IntPtr data, nuint size, IntPtr password);
        // On Windows FPDF_GetLastError returns unsigned long (32-bit), on Unix 64-bit.
        // The defined error values fit in 32 bits on both platforms.
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern uint FPDF_GetLastError();
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern int FPDF_GetPageCount(IntPtr document);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern int FPDF_GetFormType(IntPtr document);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr FPDFDOC_InitFormFillEnvironment(IntPtr document, IntPtr formInfo);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDFDOC_ExitFormFillEnvironment(IntPtr form);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FORM_OnAfterLoadPage(IntPtr page, IntPtr form);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FORM_OnBeforeClosePage(IntPtr page, IntPtr form);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDF_FFLDraw(IntPtr form, IntPtr bitmap, IntPtr page, int startX, int startY, int sizeX, int sizeY, int rotate, int flags);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDF_CloseDocument(IntPtr document);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr FPDF_LoadPage(IntPtr document, int pageIndex);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDF_ClosePage(IntPtr page);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern double FPDF_GetPageWidth(IntPtr page);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern double FPDF_GetPageHeight(IntPtr page);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr FPDFBitmap_Create(int width, int height, int alpha);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern int FPDFBitmap_FillRect(IntPtr bitmap, int left, int top, int width, int height, uint color);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDF_RenderPageBitmap(IntPtr bitmap, IntPtr page, int startX, int startY, int sizeX, int sizeY, int rotate, int flags);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr FPDFBitmap_GetBuffer(IntPtr bitmap);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern int FPDFBitmap_GetStride(IntPtr bitmap);
        [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void FPDFBitmap_Destroy(IntPtr bitmap);
    }
}
