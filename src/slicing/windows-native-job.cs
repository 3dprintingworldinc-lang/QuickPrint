using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Trusted resource extracted and hash-checked by windows-native-job.js.
// Windows Job memory limits govern committed virtual memory, not RSS.
public sealed class QuickPrintWindowsNativeJob : IDisposable
{
    const uint LIMIT_PROCESS_MEMORY=0x100, LIMIT_JOB_MEMORY=0x200, KILL_ON_CLOSE=0x2000;
    const uint SUSPENDED=4, NO_WINDOW=0x08000000, UNICODE_ENV=0x400, EXTENDED_STARTUP=0x80000;
    const uint WAIT_OBJECT_0=0, WAIT_TIMEOUT=258;
    const uint CANCEL_EXIT=0xE0000001, TIMEOUT_EXIT=0xE0000002, OUTPUT_EXIT=0xE0000003;
    const uint MAX_COMMIT=1024U*1024U*1024U;
    IntPtr job, process, thread, completion;
    readonly object gate=new object(), outputGate=new object();
    readonly MemoryStream stdout=new MemoryStream(), stderr=new MemoryStream();
    Task outTask, errTask;
    FileStream outStream, errStream;
    int maxOutputBytes, outputExceeded;
    bool memoryLimitHit;
    readonly List<uint> memoryMessages=new List<uint>();
    string stopped;
    bool disposed;
    public uint ProcessId {get;private set;}
    public bool ParentWasInJob {get;private set;}
    public bool AssignedBeforeResume {get;private set;}
    public bool AssignedAtCreation {get;private set;}
    public ulong ProcessCommitLimit {get;private set;}
    public ulong JobCommitLimit {get;private set;}
    public uint LimitFlags {get;private set;}

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {public uint nLength;public IntPtr lpSecurityDescriptor;[MarshalAs(UnmanagedType.Bool)]public bool bInheritHandle;}
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount;}
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {public long PerProcessUserTimeLimit,PerJobUserTimeLimit;public uint LimitFlags;public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint PriorityClass,SchedulingClass;}
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {public BASIC_LIMIT BasicLimitInformation;public IO_COUNTERS IoInfo;public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO {public uint cb;public string lpReserved,lpDesktop,lpTitle;public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;public ushort wShowWindow,cbReserved2;public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;}
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {public STARTUPINFO StartupInfo;public IntPtr lpAttributeList;}
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {public IntPtr hProcess,hThread;public uint dwProcessId,dwThreadId;}
    [StructLayout(LayoutKind.Sequential)] struct COMPLETION_ASSOCIATION {public IntPtr CompletionKey,CompletionPort;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int type,ref EXTENDED_LIMIT info,uint size);
    [DllImport("kernel32.dll",EntryPoint="SetInformationJobObject",SetLastError=true)] static extern bool SetCompletionJobObject(IntPtr h,int type,ref COMPLETION_ASSOCIATION info,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int type,out EXTENDED_LIMIT info,uint size,IntPtr resultSize);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr h,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string file,uint access,uint share,ref SECURITY_ATTRIBUTES security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFOEX startup,out PROCESS_INFORMATION information);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr h,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr existing,UIntPtr key,uint threads);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint message,out UIntPtr key,out IntPtr data,uint milliseconds);
    static Exception Error(string operation){return new Win32Exception(Marshal.GetLastWin32Error(),operation);}
    static void Close(ref IntPtr h){if(h!=IntPtr.Zero&&h!=new IntPtr(-1)){CloseHandle(h);h=IntPtr.Zero;}}
    static string Quote(string value){var s=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){s.Append('\\',slashes*2+1);s.Append(c);slashes=0;continue;}s.Append('\\',slashes);slashes=0;s.Append(c);}s.Append('\\',slashes*2);return s.Append('"').ToString();}
    public static QuickPrintWindowsNativeJob Start(string executable,string[] arguments,string directory,IDictionary environment,ulong processLimit,ulong jobLimit,int outputLimit)
    {
        if(!Path.IsPathRooted(executable)||!File.Exists(executable)||!Path.IsPathRooted(directory)||!Directory.Exists(directory)||arguments==null||arguments.Length>512)throw new ArgumentException("Use existing absolute executable and directory with bounded arguments.");
        if(processLimit<16*1024*1024||processLimit>MAX_COMMIT||jobLimit<processLimit||jobLimit>MAX_COMMIT||outputLimit<1||outputLimit>1024*1024)throw new ArgumentException("Resource bounds exceed supported limits.");
        var self=new QuickPrintWindowsNativeJob();self.maxOutputBytes=outputLimit;
        IntPtr readOut=IntPtr.Zero,writeOut=IntPtr.Zero,readErr=IntPtr.Zero,writeErr=IntPtr.Zero,input=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero,jobList=IntPtr.Zero,envBlock=IntPtr.Zero;
        bool attributesInitialized=false;
        try{
            bool parentInJob;if(!IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out parentInJob))throw Error("IsProcessInJob(parent)");self.ParentWasInJob=parentInJob;
            self.job=CreateJobObjectW(IntPtr.Zero,null);if(self.job==IntPtr.Zero)throw Error("CreateJobObject");
            self.completion=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,UIntPtr.Zero,1);if(self.completion==IntPtr.Zero)throw Error("CreateIoCompletionPort");
            var association=new COMPLETION_ASSOCIATION();association.CompletionKey=new IntPtr(1);association.CompletionPort=self.completion;if(!SetCompletionJobObject(self.job,7,ref association,(uint)Marshal.SizeOf(typeof(COMPLETION_ASSOCIATION))))throw Error("Associate job completion port");
            var limits=new EXTENDED_LIMIT();limits.BasicLimitInformation.LimitFlags=LIMIT_PROCESS_MEMORY|LIMIT_JOB_MEMORY|KILL_ON_CLOSE;limits.ProcessMemoryLimit=new UIntPtr(processLimit);limits.JobMemoryLimit=new UIntPtr(jobLimit);
            uint bytes=(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT));if(!SetInformationJobObject(self.job,9,ref limits,bytes))throw Error("SetInformationJobObject");
            EXTENDED_LIMIT applied;if(!QueryInformationJobObject(self.job,9,out applied,bytes,IntPtr.Zero))throw Error("QueryInformationJobObject");
            self.ProcessCommitLimit=applied.ProcessMemoryLimit.ToUInt64();self.JobCommitLimit=applied.JobMemoryLimit.ToUInt64();self.LimitFlags=applied.BasicLimitInformation.LimitFlags;
            if(self.ProcessCommitLimit!=processLimit||self.JobCommitLimit!=jobLimit||self.LimitFlags!=(LIMIT_PROCESS_MEMORY|LIMIT_JOB_MEMORY|KILL_ON_CLOSE))throw new InvalidOperationException("Job limits were not applied exactly.");
            var security=new SECURITY_ATTRIBUTES();security.nLength=(uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));security.bInheritHandle=true;
            if(!CreatePipe(out readOut,out writeOut,ref security,4096)||!SetHandleInformation(readOut,1,0))throw Error("Create stdout pipe");
            if(!CreatePipe(out readErr,out writeErr,ref security,4096)||!SetHandleInformation(readErr,1,0))throw Error("Create stderr pipe");
            input=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);if(input==new IntPtr(-1))throw Error("Open child NUL stdin");
            UIntPtr attributeBytes=UIntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attributeBytes);if(attributeBytes.ToUInt64()==0)throw Error("Size process handle whitelist");
            attributes=Marshal.AllocHGlobal(new IntPtr(checked((long)attributeBytes.ToUInt64())));if(!InitializeProcThreadAttributeList(attributes,2,0,ref attributeBytes))throw Error("Initialize process attributes");attributesInitialized=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,writeOut);Marshal.WriteIntPtr(handles,IntPtr.Size*2,writeErr);
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new UIntPtr((uint)(IntPtr.Size*3)),IntPtr.Zero,IntPtr.Zero))throw Error("Whitelist inherited handles");
            jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,self.job);
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobList,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw Error("Set creation-time job list (Windows10+ required; no fallback)");
            var startup=new STARTUPINFOEX();startup.StartupInfo.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=0x100;startup.StartupInfo.hStdInput=input;startup.StartupInfo.hStdOutput=writeOut;startup.StartupInfo.hStdError=writeErr;startup.lpAttributeList=attributes;
            var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(DictionaryEntry pair in Environment.GetEnvironmentVariables())env[(string)pair.Key]=(string)pair.Value;
            foreach(DictionaryEntry pair in environment){string key=(string)pair.Key,value=(string)pair.Value;if((key!="DOTNET_PROCESSOR_COUNT"&&key!="OPENCV_FOR_THREADS_NUM")||value!="1")throw new ArgumentException("Unsupported managed environment control.");env[key]=value;}
            env["DOTNET_PROCESSOR_COUNT"]="1";
            var envText=new StringBuilder();foreach(var pair in env)envText.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');envText.Append('\0');envBlock=Marshal.StringToHGlobalUni(envText.ToString());
            var command=new StringBuilder(Quote(executable));foreach(string arg in arguments){if(arg==null||arg.IndexOf('\0')>=0)throw new ArgumentException("Invalid argument.");command.Append(' ').Append(Quote(arg));}
            if(command.Length>32766)throw new ArgumentException("Windows command line exceeds its bound.");
            PROCESS_INFORMATION information;if(!CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,SUSPENDED|NO_WINDOW|UNICODE_ENV|EXTENDED_STARTUP,envBlock,directory,ref startup,out information))throw Error("CreateProcess suspended");
            self.process=information.hProcess;self.thread=information.hThread;self.ProcessId=information.dwProcessId;
            Close(ref writeOut);Close(ref writeErr);Close(ref input);
            bool inJob;if(!IsProcessInJob(self.process,self.job,out inJob)||!inJob)throw Error("Verify creation-time child job membership");self.AssignedBeforeResume=true;self.AssignedAtCreation=true;
            self.outStream=new FileStream(new SafeFileHandle(readOut,true),FileAccess.Read,4096,false);readOut=IntPtr.Zero;
            self.errStream=new FileStream(new SafeFileHandle(readErr,true),FileAccess.Read,4096,false);readErr=IntPtr.Zero;
            self.outTask=Task.Run(()=>self.Pump(self.outStream,self.stdout));self.errTask=Task.Run(()=>self.Pump(self.errStream,self.stderr));
            if(ResumeThread(self.thread)==0xffffffff)throw Error("ResumeThread");Close(ref self.thread);
            return self;
        }catch{if(self.process!=IntPtr.Zero){TerminateProcess(self.process,CANCEL_EXIT);WaitForSingleObject(self.process,5000);}self.Dispose();throw;}
        finally{Close(ref readOut);Close(ref readErr);Close(ref writeOut);Close(ref writeErr);Close(ref input);if(attributesInitialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(envBlock!=IntPtr.Zero)Marshal.FreeHGlobal(envBlock);}
    }
    void Pump(FileStream stream,MemoryStream destination){byte[] buffer=new byte[4096];int n;try{while((n=stream.Read(buffer,0,buffer.Length))>0){lock(outputGate){int retain=Math.Min(n,maxOutputBytes-(int)destination.Length);if(retain>0)destination.Write(buffer,0,retain);if(retain<n&&Interlocked.Exchange(ref outputExceeded,1)==0)Stop("output-limit",OUTPUT_EXIT);}}}catch(ObjectDisposedException){}finally{stream.Dispose();}}
    void Stop(string reason,uint code){lock(gate){if(stopped==null)stopped=reason;if(job!=IntPtr.Zero&&!TerminateJobObject(job,code))throw Error("TerminateJobObject");}}
    public void Cancel(){Stop("cancelled",CANCEL_EXIT);}
    public static string ReadBoundedLine(TextReader reader,int maxChars){var line=new StringBuilder();for(;;){int value=reader.Read();if(value<0)return line.Length==0?null:line.ToString();if(value==10)return line.ToString().TrimEnd('\r');if(line.Length>=maxChars)throw new InvalidDataException("Control/request line exceeds bound.");line.Append((char)value);}}
    public void WatchControl(TextReader reader){Task.Run(()=>{try{string command=ReadBoundedLine(reader,8);if(command==null)Stop("parent-disconnected",CANCEL_EXIT);else if(command=="cancel")Cancel();else Stop("invalid-control",CANCEL_EXIT);}catch{Stop("control-error",CANCEL_EXIT);}});}
    void PollJobEvents(){for(int n=0;n<1024;n++){uint message;UIntPtr key;IntPtr data;if(!GetQueuedCompletionStatus(completion,out message,out key,out data,0)){int error=Marshal.GetLastWin32Error();if(error==258)return;throw new Win32Exception(error,"GetQueuedCompletionStatus");}if(message==9||message==10){memoryLimitHit=true;if(!memoryMessages.Contains(message))memoryMessages.Add(message);}}throw new InvalidOperationException("Job event budget exceeded.");}
    public Dictionary<string,object> Wait(int timeoutMs)
    {
        if(timeoutMs<100||timeoutMs>3600000)throw new ArgumentException("Timeout must be100..3600000ms.");var clock=Stopwatch.StartNew();
        for(;;){uint wait=WaitForSingleObject(process,10);PollJobEvents();if(wait==WAIT_OBJECT_0)break;if(wait!=WAIT_TIMEOUT)throw Error("WaitForSingleObject");if(memoryLimitHit)Stop("memory-limit",0xE0000004);if(clock.ElapsedMilliseconds>=timeoutMs){Stop("timeout",TIMEOUT_EXIT);if(WaitForSingleObject(process,5000)!=WAIT_OBJECT_0)throw new InvalidOperationException("Child termination did not complete.");break;}}
        uint code;if(!GetExitCodeProcess(process,out code))throw Error("GetExitCodeProcess");
        EXTENDED_LIMIT final;if(!QueryInformationJobObject(job,9,out final,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)),IntPtr.Zero))throw Error("Query final job memory");
        // A normally exiting root may leave descendants holding the pipes. Last
        // noninherited job-handle close terminates those descendants before drain.
        lock(gate){Close(ref job);}
        if(!Task.WaitAll(new[]{outTask,errTask},5000))throw new InvalidOperationException("Owned output readers did not close after job termination.");
        return new Dictionary<string,object>{{"processId",ProcessId},{"exitCode",code},{"stopReason",stopped},{"assignedBeforeResume",AssignedBeforeResume},{"assignedAtCreation",AssignedAtCreation},{"parentWasInJob",ParentWasInJob},{"limitFlags",LimitFlags},{"processCommitLimitBytes",ProcessCommitLimit},{"jobCommitLimitBytes",JobCommitLimit},{"peakProcessCommitBytes",final.PeakProcessMemoryUsed.ToUInt64()},{"peakJobCommitBytes",final.PeakJobMemoryUsed.ToUInt64()},{"memoryLimitHit",memoryLimitHit},{"memoryLimitMessages",memoryMessages.ToArray()},{"stdoutBase64",Convert.ToBase64String(stdout.ToArray())},{"stderrBase64",Convert.ToBase64String(stderr.ToArray())},{"stdoutBytes",stdout.Length},{"stderrBytes",stderr.Length},{"outputLimitExceeded",outputExceeded!=0},{"elapsedMs",clock.ElapsedMilliseconds},{"descendantsTerminatedOnCompletion",true}};
    }
    public void Dispose(){lock(gate){if(disposed)return;disposed=true;Close(ref job);Close(ref thread);Close(ref process);Close(ref completion);}if(outTask==null&&outStream!=null)outStream.Dispose();if(errTask==null&&errStream!=null)errStream.Dispose();}
}
