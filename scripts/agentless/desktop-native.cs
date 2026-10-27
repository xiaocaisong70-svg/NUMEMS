// Windows desktop isolation only. No browser flags, credential manipulation, or desktop switching.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace NumemsDesktop {
  public sealed class DesktopState {
    public string desktop;
    public string inputDesktop;
    public string windowStation;
    public bool isolated;
  }
  public sealed class WindowAudit {
    public string desktop;
    public string inputDesktop;
    public uint jobProcessCount;
    public uint ownedWindowsOnInputDesktop;
    public uint ownedWindowsOnIsolatedDesktop;
    public bool isolated;
  }

  public static class Native {
    const uint DESKTOP_ACCESS = 0x00CF; // Read, create windows/menus, hook, enumerate, write. No switch right.
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint KILL_ON_JOB_CLOSE = 0x00002000;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const uint STARTF_USESHOWWINDOW = 0x00000001;
    const uint STARTF_FORCEOFFFEEDBACK = 0x00000080;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public uint cb;
      public string lpReserved, lpDesktop, lpTitle;
      public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public ushort wShowWindow, cbReserved2;
      public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
      public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
      public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr attributes);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder data, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr desktop);
    delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")]
    static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returnedLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
      IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
      ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static Exception Failure(string step) { return new Win32Exception(Marshal.GetLastWin32Error(), step); }
    static string ObjectName(IntPtr handle) {
      if (handle == IntPtr.Zero) throw Failure("Desktop handle unavailable");
      uint size;
      GetUserObjectInformationW(handle, 2, null, 0, out size);
      if (size == 0 || size > 65536) throw Failure("Desktop name unavailable");
      var result = new StringBuilder((int)size / 2 + 1);
      if (!GetUserObjectInformationW(handle, 2, result, size, out size)) throw Failure("Desktop name read failed");
      return result.ToString();
    }
    public static DesktopState Probe() {
      string own = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
      string station = ObjectName(GetProcessWindowStation());
      IntPtr input = OpenInputDesktop(0, false, 0x0001);
      if (input == IntPtr.Zero) throw Failure("Input desktop unavailable; isolation cannot be verified");
      string active;
      try { active = ObjectName(input); } finally { CloseDesktop(input); }
      string expected = Environment.GetEnvironmentVariable("NUMEMS_DESKTOP_NAME");
      return new DesktopState { desktop = own, inputDesktop = active, windowStation = station,
        isolated = !String.IsNullOrEmpty(expected) && expected.StartsWith("NUMEMS-Agentless-", StringComparison.Ordinal) &&
          String.Equals(own, expected, StringComparison.Ordinal) &&
          !String.Equals(own, active, StringComparison.OrdinalIgnoreCase) &&
          !String.Equals(own, "Default", StringComparison.OrdinalIgnoreCase) &&
          String.Equals(station, "WinSta0", StringComparison.OrdinalIgnoreCase) };
    }

    static string Quote(string value) {
      if (value == null || value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
        throw new ArgumentException("Invalid command argument");
      // Windows argv quoting: double backslashes before a quote and the closing quote.
      var result = new StringBuilder("\"");
      int backslashes = 0;
      foreach (char ch in value) {
        if (ch == '\\') { backslashes++; continue; }
        if (ch == '"') result.Append('\\', backslashes * 2 + 1).Append(ch);
        else result.Append('\\', backslashes).Append(ch);
        backslashes = 0;
      }
      return result.Append('\\', backslashes * 2).Append('"').ToString();
    }
    static readonly HashSet<string> AdminCommands = new HashSet<string>(StringComparer.Ordinal) {
      "status", "observe", "prepare-test", "release-test", "test-reminder", "test-expire", "enable-live", "disable",
      "reconcile", "recover-browser", "resolve-alert", "resume-test-invite", "review-test-workspace", "review-live-workspace"
    };
    static readonly HashSet<string> TestIdCommands = new HashSet<string>(StringComparer.Ordinal) {
      "release-test", "test-reminder", "test-expire"
    };
    sealed class WorkerCommand {
      public string script;
      public List<string> arguments = new List<string>();
    }
    static WorkerCommand ResolveWorker(string directory, string mode, string adminCommand, string requestId) {
      if (String.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory))
        throw new ArgumentException("An absolute project directory is required");
      string entry;
      var result = new WorkerCommand();
      if (mode == "admin") {
        if (String.IsNullOrEmpty(adminCommand) || !AdminCommands.Contains(adminCommand))
          throw new ArgumentException("An allowed admin command is required");
        bool needsId = TestIdCommands.Contains(adminCommand);
        if (needsId && (requestId == null || !Regex.IsMatch(requestId, @"\Areq_[a-zA-Z0-9_]+\z")))
          throw new ArgumentException("This test command requires a registered req_ ID");
        if (!needsId && !String.IsNullOrEmpty(requestId))
          throw new ArgumentException("RequestId is allowed only for test commands that require an ID");
        entry = "admin.mjs";
        result.arguments.Add(adminCommand);
        if (needsId) result.arguments.Add(requestId);
      } else {
        if (!String.IsNullOrEmpty(adminCommand) || !String.IsNullOrEmpty(requestId))
          throw new ArgumentException("Admin arguments are allowed only in admin mode");
        switch (mode) {
          case "probe": entry = "probe.mjs"; break;
          case "once": entry = "main.mjs"; result.arguments.Add("--once"); break;
          case "run": entry = "main.mjs"; break;
          default: throw new ArgumentException("An allowed worker mode is required");
        }
      }
      result.script = Path.Combine(Path.GetFullPath(directory), "scripts", "agentless", entry);
      return result;
    }
    static string BuildCommandLine(string node, WorkerCommand worker) {
      if (String.IsNullOrEmpty(node) || !Path.IsPathRooted(node) ||
          !String.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase))
        throw new ArgumentException("An absolute installed node.exe is required");
      var result = new StringBuilder(Quote(node)).Append(' ').Append(Quote(worker.script));
      foreach (string argument in worker.arguments) result.Append(' ').Append(Quote(argument));
      return result.ToString();
    }
    // Pure validation/building entry point for tests; it creates no desktop or child process.
    public static string BuildCommandLine(string node, string directory, string mode, string adminCommand, string requestId) {
      return BuildCommandLine(node, ResolveWorker(directory, mode, adminCommand, requestId));
    }
    static IntPtr EnvironmentBlock(string desktop) {
      var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (DictionaryEntry pair in Environment.GetEnvironmentVariables()) values[(string)pair.Key] = (string)pair.Value;
      values["NUMEMS_DESKTOP_NAME"] = desktop;
      var block = new StringBuilder();
      foreach (var pair in values) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
      block.Append('\0');
      return Marshal.StringToHGlobalUni(block.ToString());
    }
    static HashSet<uint> JobProcesses(IntPtr job) {
      // Class 3: two DWORD counts followed by pointer-sized process IDs.
      for (int size = 4096; size <= 1048576; size *= 2) {
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          uint returned;
          if (!QueryInformationJobObject(job, 3, buffer, (uint)size, out returned)) {
            if (Marshal.GetLastWin32Error() == 234) continue;
            throw Failure("Isolated job process list unavailable");
          }
          uint count = (uint)Marshal.ReadInt32(buffer, 4);
          if (count > (size - 8) / IntPtr.Size) throw new InvalidOperationException("Invalid isolated process list");
          var result = new HashSet<uint>();
          for (int i = 0; i < count; i++) {
            ulong id = unchecked((ulong)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
            if (id > UInt32.MaxValue) throw new InvalidOperationException("Invalid isolated process ID");
            result.Add((uint)id);
          }
          return result;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("Isolated process list exceeds audit limit");
    }
    static List<uint> DesktopWindowProcesses(IntPtr desktop, string label, string expectedName) {
      var ids = new List<uint>();
      int callbacks = 0;
      EnumWindowsProc collect = delegate(IntPtr window, IntPtr unused) {
        callbacks++;
        uint pid;
        if (GetWindowThreadProcessId(window, out pid) != 0) ids.Add(pid);
        return true;
      };
      SetLastError(0);
      bool success = EnumDesktopWindows(desktop, collect, IntPtr.Zero);
      int error = Marshal.GetLastWin32Error();
      GC.KeepAlive(collect);
      if (!success) {
        // A newly created desktop can contain no windows. Accept only the narrow no-error,
        // no-callback result on the same valid handle; all actual Win32 failures stay fatal.
        // https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumdesktopwindows
        bool verifiedEmpty = error == 0 && callbacks == 0 &&
          String.Equals(ObjectName(desktop), expectedName, StringComparison.Ordinal);
        if (!verifiedEmpty) throw new Win32Exception(error, "Desktop window audit unavailable: label=" + label +
          ", desktop=" + expectedName + ", callbacks=" + callbacks + ", Win32=" + error);
      }
      return ids;
    }
    static uint CountOwned(List<uint> windows, HashSet<uint> processes) {
      uint result = 0;
      foreach (uint pid in windows) if (processes.Contains(pid)) result++;
      return result;
    }

    public sealed class Session : IDisposable {
      IntPtr process, thread, job, desktop;
      public uint processId;
      public string desktopName;
      public string inputDesktop;
      bool disposed;
      internal Session(IntPtr p, IntPtr t, IntPtr j, IntPtr d, uint id, string name, string input) {
        process = p; thread = t; job = j; desktop = d; processId = id; desktopName = name; inputDesktop = input;
      }
      public bool Wait(uint milliseconds) {
        if (disposed) throw new ObjectDisposedException("Session");
        uint result = WaitForSingleObject(process, milliseconds);
        if (result == WAIT_OBJECT_0) return true;
        if (result == WAIT_TIMEOUT) return false;
        throw Failure("Waiting for isolated child failed");
      }
      public uint ExitCode() {
        uint result;
        if (!GetExitCodeProcess(process, out result)) throw Failure("Child exit code unavailable");
        return result;
      }
      public WindowAudit Audit() {
        if (disposed) throw new ObjectDisposedException("Session");
        IntPtr input = OpenInputDesktop(0, false, 0x0041);
        if (input == IntPtr.Zero) throw Failure("Input desktop cannot be audited");
        try {
          string active = ObjectName(input);
          string own = ObjectName(desktop);
          var processes = JobProcesses(job);
          var inputWindows = DesktopWindowProcesses(input, "input", active);
          var isolatedWindows = DesktopWindowProcesses(desktop, "isolated", own);
          // Include descendants created while enumerating; no unrelated titles or text are inspected.
          processes.UnionWith(JobProcesses(job));
          uint onInput = CountOwned(inputWindows, processes);
          return new WindowAudit { desktop = own, inputDesktop = active,
            jobProcessCount = (uint)processes.Count, ownedWindowsOnInputDesktop = onInput,
            ownedWindowsOnIsolatedDesktop = CountOwned(isolatedWindows, processes),
            isolated = onInput == 0 && String.Equals(own, desktopName, StringComparison.Ordinal) &&
              !String.Equals(own, active, StringComparison.OrdinalIgnoreCase) };
        } finally { CloseDesktop(input); }
      }
      public void Dispose() {
        if (disposed) return;
        disposed = true;
        // Only this job's descendants are terminated. Unrelated processes are never touched.
        if (job != IntPtr.Zero) CloseHandle(job);
        if (thread != IntPtr.Zero) CloseHandle(thread);
        if (process != IntPtr.Zero) { WaitForSingleObject(process, 5000); CloseHandle(process); }
        if (desktop != IntPtr.Zero) CloseDesktop(desktop);
      }
    }

    public static Session Start(string node, string directory, string mode, string adminCommand, string requestId) {
      if (!Path.IsPathRooted(node) || !File.Exists(node) || !String.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase))
        throw new ArgumentException("An absolute installed node.exe is required");
      WorkerCommand worker = ResolveWorker(directory, mode, adminCommand, requestId);
      string commandLine = BuildCommandLine(node, worker);
      if (!File.Exists(worker.script) || !Directory.Exists(directory))
        throw new ArgumentException("Worker path is unavailable");
      DesktopState before = Probe();
      if (!String.Equals(before.windowStation, "WinSta0", StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("The interactive Windows user session is required");
      string name = "NUMEMS-Agentless-" + Guid.NewGuid().ToString("N");
      IntPtr desktop = IntPtr.Zero, job = IntPtr.Zero, environment = IntPtr.Zero;
      PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
      bool assigned = false;
      try {
        desktop = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_ACCESS, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw Failure("Create isolated desktop failed");
        if (!String.Equals(ObjectName(desktop), name, StringComparison.Ordinal) ||
            String.Equals(name, before.inputDesktop, StringComparison.OrdinalIgnoreCase))
          throw new InvalidOperationException("Isolated desktop identity mismatch");
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Failure("Create child job failed");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
          throw Failure("Configure child job failed");
        var si = new STARTUPINFO { cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)),
          lpDesktop = before.windowStation + "\\" + name,
          dwFlags = STARTF_USESHOWWINDOW | STARTF_FORCEOFFFEEDBACK, wShowWindow = 0 };
        var command = new StringBuilder(commandLine);
        environment = EnvironmentBlock(name);
        if (!CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment, directory, ref si, out pi))
          throw Failure("Create isolated worker failed");
        if (!AssignProcessToJobObject(job, pi.hProcess)) throw Failure("Assign isolated worker to cleanup job failed");
        assigned = true;
        if (ResumeThread(pi.hThread) == UInt32.MaxValue) throw Failure("Resume isolated worker failed");
        var result = new Session(pi.hProcess, pi.hThread, job, desktop, pi.dwProcessId, name, before.inputDesktop);
        pi.hProcess = pi.hThread = desktop = job = IntPtr.Zero;
        return result;
      } catch {
        // A not-yet-assigned child is still suspended. It must never execute outside the job.
        if (pi.hProcess != IntPtr.Zero && !assigned) TerminateProcess(pi.hProcess, 126);
        throw;
      } finally {
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        if (job != IntPtr.Zero) CloseHandle(job);
        if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
        if (pi.hProcess != IntPtr.Zero) { WaitForSingleObject(pi.hProcess, 5000); CloseHandle(pi.hProcess); }
        if (desktop != IntPtr.Zero) CloseDesktop(desktop);
      }
    }
  }
}
