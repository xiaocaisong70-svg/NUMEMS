import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const dir = path.resolve(import.meta.dirname, '../scripts/agentless');

test('isolated desktop host has no user-desktop fallback or security bypass flags', async () => {
  const native = await readFile(path.join(dir, 'desktop-native.cs'), 'utf8');
  assert.match(native, /lpDesktop = before\.windowStation/);
  assert.match(native, /CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT \| CREATE_NO_WINDOW/);
  assert.ok(native.indexOf('AssignProcessToJobObject(job, pi.hProcess)') < native.indexOf('ResumeThread(pi.hThread)'));
  assert.match(native, /KILL_ON_JOB_CLOSE/);
  assert.match(native, /STARTF_USESHOWWINDOW \| STARTF_FORCEOFFFEEDBACK/);
  assert.match(native, /QueryInformationJobObject\(job, 3,/);
  assert.match(native, /EnumDesktopWindows\(desktop, collect,/);
  assert.match(native, /isolated = onInput == 0/);
  assert.match(native, /SetLastError\(0\);\s*bool success = EnumDesktopWindows/);
  assert.match(native, /verifiedEmpty = error == 0 && callbacks == 0 &&\s*String\.Equals\(ObjectName\(desktop\), expectedName/);
  assert.match(native, /Win32=" \+ error/);
  assert.doesNotMatch(native, /SwitchDesktop\s*\(|SetThreadDesktop\s*\(|--no-sandbox|--disable-blink-features|window-position|taskkill/i);
  assert.match(native, /String\.Equals\(own, expected/);
  assert.match(native, /!String\.Equals\(own, active/);
});

test('launcher admits only fixed worker modes and probe fails closed', async () => {
  const launcher = await readFile(path.join(dir, 'isolated-desktop.ps1'), 'utf8');
  const probe = await readFile(path.join(dir, 'desktop-probe.ps1'), 'utf8');
  assert.match(launcher, /ValidateSet\('probe','once','run','admin'\)/);
  assert.match(launcher, /'admin\.mjs'.*'probe\.mjs'.*'main\.mjs'/);
  assert.match(launcher, /\.WaitOne\(0\)/);
  assert.match(launcher, /\$session\.Dispose\(\)/);
  assert.match(launcher, /\$session\.Audit\(\)/);
  assert.match(launcher, /if \(-not \$audit\.isolated\) \{ throw/);
  assert.match(launcher, /maxOwnedWindowsOnInputDesktop/);
  assert.doesNotMatch(launcher, /Start-Process|Invoke-Expression|Turn\/start|thread\/queue\/add/i);
  assert.match(probe, /isolated=\$false/);
  assert.match(probe, /exit 1/);
});

test('native command builder fixes entries and rejects non-whitelisted admin arguments', {skip:process.platform!=='win32'}, async () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe', project = 'D:\\NUMEMS project';
  const allowed = ['status','observe','prepare-test','release-test','test-reminder','test-expire','enable-live','disable','reconcile','recover-browser','resolve-alert','resume-test-invite','review-test-workspace'];
  const adminSource = await readFile(path.join(dir,'admin.mjs'),'utf8');
  const advertised = adminSource.match(/用法：admin\.mjs ([^']+)/)?.[1].split('|').map(value=>value.trim().split(/\s+/)[0]);
  assert.deepEqual(new Set(advertised),new Set(allowed),'isolated admin whitelist must match the current CLI');
  const requiresId = new Set(['release-test','test-reminder','test-expire']);
  const cases = [
    ...['probe','once','run'].map(mode=>({mode,adminCommand:null,requestId:null,valid:true})),
    ...allowed.map(adminCommand=>({mode:'admin',adminCommand,requestId:requiresId.has(adminCommand)?'req_Ab12_3':null,valid:true})),
    {mode:'admin',adminCommand:'status & calc',requestId:null,valid:false},
    {mode:'admin',adminCommand:'../admin.mjs',requestId:null,valid:false},
    {mode:'admin',adminCommand:'STATUS',requestId:null,valid:false},
    {mode:'admin',adminCommand:null,requestId:null,valid:false},
    {mode:'admin',adminCommand:'status',requestId:'req_123',valid:false},
    {mode:'admin',adminCommand:'prepare-test',requestId:'req_123',valid:false},
    {mode:'probe',adminCommand:'status',requestId:null,valid:false},
    {mode:'run',adminCommand:null,requestId:'req_123',valid:false},
    {mode:'../admin.mjs',adminCommand:null,requestId:null,valid:false},
    ...[null,'req_','req_123\n','req_123 & calc','req_123"','../../req_123'].map(requestId=>({mode:'admin',adminCommand:'release-test',requestId,valid:false})),
  ];
  const data = Buffer.from(JSON.stringify(cases)).toString('base64');
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -LiteralPath '${path.join(dir,'desktop-native.cs').replaceAll("'","''")}'
$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$result = foreach ($case in $cases) {
  try {
    $command = [NumemsDesktop.Native]::BuildCommandLine('${node}','${project}',$case.mode,$case.adminCommand,$case.requestId)
    [pscustomobject]@{ valid=$true; command=$command }
  } catch { [pscustomobject]@{ valid=$false } }
}
ConvertTo-Json -InputObject @($result) -Compress`;
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result = JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {windowsHide:true,encoding:'utf8'}).trim());
  assert.deepEqual(result.map(r=>r.valid),cases.map(c=>c.valid));
  const prefix = `"${node}" "${project}\\scripts\\agentless\\`;
  assert.equal(result[0].command,`${prefix}probe.mjs"`);
  assert.equal(result[1].command,`${prefix}main.mjs" "--once"`);
  assert.equal(result[2].command,`${prefix}main.mjs"`);
  for (const [index,command] of allowed.entries()) {
    assert.equal(result[index+3].command,`${prefix}admin.mjs" "${command}"${requiresId.has(command)?' "req_Ab12_3"':''}`);
  }
});

test('host report supports first write and atomic replacement in Windows PowerShell', {skip:process.platform!=='win32'}, () => {
  const launcherPath = path.join(dir,'isolated-desktop.ps1').replaceAll("'","''");
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$errors=$null; $tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${launcherPath}',[ref]$tokens,[ref]$errors)
if ($errors) { throw 'Launcher syntax failed.' }
$save=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Save-HostReport'},$true).Body.GetScriptBlock()
$runtimePath=Join-Path ([IO.Path]::GetTempPath()) ('numems-host-report-test-'+[Guid]::NewGuid().ToString('N'))
$reportPath=Join-Path $runtimePath 'host-desktop.json'
$report=[ordered]@{state='first';audits=1}
try {
  & $save
  $report.state='second'; $report.audits=2
  & $save
  [IO.File]::ReadAllText($reportPath)
} finally {
  if ([IO.File]::Exists($reportPath)) { [IO.File]::Delete($reportPath) }
  if ([IO.Directory]::Exists($runtimePath)) { [IO.Directory]::Delete($runtimePath) }
}`;
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result = JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'}).trim());
  assert.deepEqual(result,{state:'second',audits:2});
});
