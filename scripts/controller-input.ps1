param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'

# Built-in Windows APIs keep the shipped app free of native Node add-ons.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class TrackHunterController {
    [StructLayout(LayoutKind.Sequential)]
    public struct Gamepad {
        public ushort Buttons;
        public byte LeftTrigger, RightTrigger;
        public short LeftX, LeftY, RightX, RightY;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct State { public uint Packet; public Gamepad Pad; }
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")]
    private static extern uint GetState(uint index, out State state);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static string ProcessName(IntPtr window) {
        uint id;
        GetWindowThreadProcessId(window, out id);
        try { using (Process process = Process.GetProcessById((int)id)) return process.ProcessName; }
        catch { return ""; }
    }

    private static void Focus(IntPtr window) {
        if (window == IntPtr.Zero) return;
        uint unused;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
        uint currentThread = GetCurrentThreadId();
        bool attached = foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        try {
            if (IsIconic(window)) ShowWindow(window, 9);
            SetForegroundWindow(window);
        } finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
    }

    public static string FormatState(uint index, bool connected, State state, bool gameForeground, Rect rect) {
        return String.Format(CultureInfo.InvariantCulture, "{{\"type\":\"state\",\"index\":{0},\"connected\":{1},\"buttons\":{2},\"leftX\":{3},\"leftY\":{4},\"leftTrigger\":{5},\"rightTrigger\":{6},\"gameForeground\":{7},\"bounds\":{{\"x\":{8},\"y\":{9},\"width\":{10},\"height\":{11}}}}}",
                    index, connected ? "true" : "false", state.Pad.Buttons, state.Pad.LeftX, state.Pad.LeftY,
                    state.Pad.LeftTrigger, state.Pad.RightTrigger, gameForeground ? "true" : "false",
                    rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    public static void Run(int ownerProcessId) {
        long gameWindow = 0;
        bool running = true;
        Thread commands = new Thread(delegate() {
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line == "focus-game") {
                    IntPtr target = new IntPtr(Interlocked.Read(ref gameWindow));
                    uint foregroundId;
                    GetWindowThreadProcessId(GetForegroundWindow(), out foregroundId);
                    if (foregroundId == (uint)ownerProcessId && ProcessName(target).Equals("Trackmania", StringComparison.OrdinalIgnoreCase)) Focus(target);
                } else if (line.StartsWith("focus-overlay ", StringComparison.Ordinal)) {
                    long handle;
                    if (!long.TryParse(line.Substring(14), out handle)) continue;
                    IntPtr target = new IntPtr(handle);
                    uint id;
                    GetWindowThreadProcessId(target, out id);
                    if (id == (uint)ownerProcessId) Focus(target);
                }
            }
            Volatile.Write(ref running, false);
        });
        commands.IsBackground = true;
        commands.Start();
        Console.WriteLine("{\"type\":\"ready\"}");
        IntPtr previousForeground = IntPtr.Zero;
        bool gameForeground = false;
        while (Volatile.Read(ref running)) {
            IntPtr foreground = GetForegroundWindow();
            if (foreground != previousForeground) {
                gameForeground = ProcessName(foreground).Equals("Trackmania", StringComparison.OrdinalIgnoreCase);
                previousForeground = foreground;
            }
            Rect rect = new Rect();
            if (gameForeground) {
                Interlocked.Exchange(ref gameWindow, foreground.ToInt64());
                GetWindowRect(foreground, out rect);
            }
            for (uint index = 0; index < 4; index++) {
                State state;
                bool connected = GetState(index, out state) == 0;
                Console.WriteLine(FormatState(index, connected, state, gameForeground, rect));
            }
            Thread.Sleep(50);
        }
    }
}
'@

if ($ValidateOnly) {
    if ([Runtime.InteropServices.Marshal]::SizeOf([type][TrackHunterController+State]) -ne 16) { throw 'Invalid XInput state layout' }
    $sample = [TrackHunterController]::FormatState(0, $true, (New-Object TrackHunterController+State), $true, (New-Object TrackHunterController+Rect)) | ConvertFrom-Json
    if ($sample.type -ne 'state' -or $sample.index -ne 0 -or -not $sample.connected) { throw 'Invalid controller message' }
    Write-Output 'Controller bridge compiled; native struct layout and JSON protocol validated.'
} else {
    [TrackHunterController]::Run([int]$env:TRACKHUNTER_OWNER_PID)
}
