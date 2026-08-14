import koffi from "koffi";

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const Handle = koffi.pointer(koffi.opaque("HANDLE"));

const IoCounters = koffi.struct("IO_COUNTERS", {
  ReadOperationCount: "uint64_t",
  WriteOperationCount: "uint64_t",
  OtherOperationCount: "uint64_t",
  ReadTransferCount: "uint64_t",
  WriteTransferCount: "uint64_t",
  OtherTransferCount: "uint64_t",
});

const BasicLimitInformation = koffi.struct(
  "JOBOBJECT_BASIC_LIMIT_INFORMATION",
  {
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  },
);

const ExtendedLimitInformation = koffi.struct(
  "JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
  {
    BasicLimitInformation,
    IoInfo: IoCounters,
    ProcessMemoryLimit: "size_t",
    JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t",
    PeakJobMemoryUsed: "size_t",
  },
);

const BasicAccountingInformation = koffi.struct(
  "JOBOBJECT_BASIC_ACCOUNTING_INFORMATION",
  {
    TotalUserTime: "int64_t",
    TotalKernelTime: "int64_t",
    ThisPeriodTotalUserTime: "int64_t",
    ThisPeriodTotalKernelTime: "int64_t",
    TotalPageFaultCount: "uint32_t",
    TotalProcesses: "uint32_t",
    ActiveProcesses: "uint32_t",
    TotalTerminatedProcesses: "uint32_t",
  },
);

const kernel32 = koffi.load("kernel32.dll");
const CreateJobObject = kernel32.func("CreateJobObjectW", Handle, [
  "void *",
  "str16",
]);
const OpenProcess = kernel32.func("OpenProcess", Handle, [
  "uint32_t",
  "int",
  "uint32_t",
]);
const AssignProcessToJobObject = kernel32.func(
  "AssignProcessToJobObject",
  "int",
  [Handle, Handle],
);
const SetInformationJobObject = kernel32.func(
  "SetInformationJobObject",
  "int",
  [Handle, "int", koffi.pointer(ExtendedLimitInformation), "uint32_t"],
);
const QueryInformationJobObject = kernel32.func(
  "QueryInformationJobObject",
  "int",
  [
    Handle,
    "int",
    koffi.out(koffi.pointer(BasicAccountingInformation)),
    "uint32_t",
    "void *",
  ],
);
const TerminateJobObject = kernel32.func("TerminateJobObject", "int", [
  Handle,
  "uint32_t",
]);
const CloseHandle = kernel32.func("CloseHandle", "int", [Handle]);
const GetLastError = kernel32.func("GetLastError", "uint32_t", []);

export interface WindowsJob {
  terminate(): void;
  waitForEmpty(timeoutMs: number): Promise<void>;
  close(): void;
  hasActiveProcesses(): boolean;
}

export function createWindowsJob(pid: number): WindowsJob {
  const job = CreateJobObject(null, null);
  if (job === null) throwWin32Error("CreateJobObjectW");

  try {
    const limits = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0,
        WriteOperationCount: 0,
        OtherOperationCount: 0,
        ReadTransferCount: 0,
        WriteTransferCount: 0,
        OtherTransferCount: 0,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };
    if (
      !SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        limits,
        ExtendedLimitInformation.size,
      )
    ) {
      throwWin32Error("SetInformationJobObject");
    }

    const process = OpenProcess(
      PROCESS_TERMINATE |
        PROCESS_SET_QUOTA |
        PROCESS_QUERY_LIMITED_INFORMATION,
      0,
      pid,
    );
    if (process === null) throwWin32Error(`OpenProcess(${pid})`);
    try {
      if (!AssignProcessToJobObject(job, process)) {
        throwWin32Error(`AssignProcessToJobObject(${pid})`);
      }
    } finally {
      CloseHandle(process);
    }
  } catch (err) {
    CloseHandle(job);
    throw err;
  }

  return new NativeWindowsJob(job);
}

class NativeWindowsJob implements WindowsJob {
  private closed = false;
  private terminated = false;

  constructor(private readonly handle: unknown) {}

  terminate(): void {
    if (this.closed || this.terminated) return;
    this.terminated = true;
    if (!TerminateJobObject(this.handle, 1)) {
      throwWin32Error("TerminateJobObject");
    }
  }

  async waitForEmpty(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (this.hasActiveProcesses()) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Windows agent process tree did not exit within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!CloseHandle(this.handle)) throwWin32Error("CloseHandle");
  }

  hasActiveProcesses(): boolean {
    if (this.closed) return false;
    const accounting = {
      TotalUserTime: 0,
      TotalKernelTime: 0,
      ThisPeriodTotalUserTime: 0,
      ThisPeriodTotalKernelTime: 0,
      TotalPageFaultCount: 0,
      TotalProcesses: 0,
      ActiveProcesses: 0,
      TotalTerminatedProcesses: 0,
    };
    if (
      !QueryInformationJobObject(
        this.handle,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        accounting,
        BasicAccountingInformation.size,
        null,
      )
    ) {
      throwWin32Error("QueryInformationJobObject");
    }
    return accounting.ActiveProcesses > 0;
  }
}

function throwWin32Error(operation: string): never {
  throw new Error(`${operation} failed with Windows error ${GetLastError()}`);
}
