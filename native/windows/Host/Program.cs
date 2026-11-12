using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Tsinghua;

internal static class Program
{
    [DllImport("kernel32.dll")] static extern nint GetStdHandle(int standardHandle);
    static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || !Protocol.ValidArguments(args)) return 2;
        // Chrome may leave a pipe open. Never outlive the extension's 12 second timeout.
        using var timeout = new Timer(_ => Environment.Exit(3), null, 10_000, Timeout.Infinite);
        try
        {
            using var input = new FileStream(new SafeFileHandle(GetStdHandle(-10), false), FileAccess.Read);
            using var output = new FileStream(new SafeFileHandle(GetStdHandle(-11), false), FileAccess.Write);
            Protocol.Serve(input, output, new DpapiVault());
            return 0;
        }
        catch { return 1; } // Never write diagnostics or secrets to the protocol stream.
    }
}
