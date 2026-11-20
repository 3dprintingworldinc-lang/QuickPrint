# Trusted resource. Neither this helper nor its caller changes execution policy.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$requestId=$null
function Send-Message($message) {
 [Console]::Out.WriteLine(($message | ConvertTo-Json -Compress -Depth 8))
 [Console]::Out.Flush()
}
try {
 Add-Type -Path (Join-Path $PSScriptRoot 'windows-native-job.cs')
 $line=[QuickPrintWindowsNativeJob]::ReadBoundedLine([Console]::In,32768)
 if(-not $line){throw 'Expected one bounded JSON request'}
 $r=$line | ConvertFrom-Json
 $expected=@('schemaVersion','requestId','executable','arguments','directory','environment','processCommitLimitBytes','jobCommitLimitBytes','maxOutputBytes','timeoutMs')
 $actual=@($r.PSObject.Properties.Name)
 if(($actual | Where-Object {$_ -notin $expected}).Count -or $actual.Count -ne $expected.Count -or $r.schemaVersion -ne 1 -or $r.requestId -notmatch '^[a-f0-9]{32}$'){throw 'Invalid supervisor request schema'}
 $requestId=$r.requestId
 $environment=@{'DOTNET_PROCESSOR_COUNT'='1'}
 if($r.environment){$r.environment.PSObject.Properties | ForEach-Object{$environment[$_.Name]=[string]$_.Value}}
 $environment['DOTNET_PROCESSOR_COUNT']='1'
 $job=[QuickPrintWindowsNativeJob]::Start([string]$r.executable,[string[]]$r.arguments,[string]$r.directory,$environment,[uint64]$r.processCommitLimitBytes,[uint64]$r.jobCommitLimitBytes,[int]$r.maxOutputBytes)
 try {
  Send-Message @{event='started';schemaVersion=1;requestId=$requestId;processId=$job.ProcessId;assignedBeforeResume=$job.AssignedBeforeResume;assignedAtCreation=$job.AssignedAtCreation}
  $job.WatchControl([Console]::In)
  $result=$job.Wait([int]$r.timeoutMs)
  Send-Message @{event='result';schemaVersion=1;requestId=$requestId;result=$result}
 } finally { $job.Dispose() }
} catch {
 $message=$_.Exception.Message
 if($message.Length -gt 4096){$message=$message.Substring(0,4096)}
 Send-Message @{event='error';schemaVersion=1;requestId=$requestId;message=$message}
 exit 1
}
