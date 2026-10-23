import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const installer = path.resolve(import.meta.dirname, '../scripts/agentless/install-task.ps1');
const now = '2026-10-22T12:00:00.000Z';
function validEvidence() {
  const desktop = 'NUMEMS-Agentless-fixture123';
  return {
    config: {liveActions:true, legacyCheckerDisabled:true, browserMode:'isolated_desktop', headless:false},
    probe: {
      mode:'isolated_desktop', passed:true, officialVerified:true, portalVerified:true,
      modelCalls:0, realInvitesSent:0, realMembersRemoved:0, realMailSent:0,
      checkedAt:'2026-10-22T11:58:00.000Z', finishedAt:'2026-10-22T11:59:00.000Z',
      desktop:{desktop, inputDesktop:'Default', windowStation:'WinSta0', isolated:true},
    },
    host: {
      mode:'probe', state:'exited', exitCode:0, desktop, audits:60,
      checkedAt:'2026-10-22T11:59:01.000Z', maxOwnedWindowsOnInputDesktop:0,
      windowAudit:{desktop, inputDesktop:'Default', isolated:true, ownedWindowsOnInputDesktop:0},
    },
  };
}

test('installer keeps conflict checks and checks isolation evidence before task APIs', async () => {
  const source = await readFile(installer, 'utf8');
  const gate = source.indexOf('Assert-IsolatedProbe -Config $config');
  assert.ok(gate > 0);
  assert.ok(gate < source.indexOf('Get-ScheduledTask'));
  assert.match(source, /'isolated-probe\.json'/);
  assert.match(source, /'host-desktop\.json'/);
  assert.match(source, /TaskName -like 'NUMEMS\*'.*State -ne 'Disabled'/);
  assert.match(source, /Task already exists; not overwritten/);
  assert.match(source, /CodexSandbox/);
  assert.match(source, /wscript\.exe/);
  assert.match(source, /MultipleInstances IgnoreNew/);
  assert.match(source, /Get-Content -LiteralPath \$Path -Raw -Encoding UTF8/);
  assert.match(source, /Parameters\.ContainsKey\('DateKind'\)/);
  assert.match(source, /\$arguments\.DateKind = 'String'/);
  assert.match(source, /\$probe=Read-JsonStringDates -Path/);
  assert.doesNotMatch(source, /Disable-ScheduledTask|Unregister-ScheduledTask|RestartCount/);
});

test('installer evidence gate rejects stale, mismatched, incomplete or non-isolated acceptance', {
  skip:process.platform !== 'win32',
}, async t => {
  const cases = [];
  const add = (name, change, allowed = false) => {
    const fixture = validEvidence();
    change?.(fixture);
    cases.push({name, allowed, now, utf8:'无可见弹窗', ...fixture});
  };
  add('verified fresh probe', null, true);
  add('live not authorized', f => {f.config.liveActions=false;});
  add('legacy not disabled', f => {f.config.legacyCheckerDisabled=false;});
  add('string booleans rejected', f => {f.config.liveActions='true';});
  add('headless mode rejected', f => {f.config.browserMode='headless';f.config.headless=true;});
  add('missing browser mode', f => {delete f.config.browserMode;});
  add('string false rejected', f => {f.config.headless='false';});
  add('probe failed', f => {f.probe.passed=false;});
  add('official not verified', f => {f.probe.officialVerified=false;});
  add('portal not verified', f => {f.probe.portalVerified=false;});
  add('string verified rejected', f => {f.probe.portalVerified='true';});
  add('probe error conflicts with success', f => {f.probe.officialFailure={message:'challenge'};});
  add('model call during probe', f => {f.probe.modelCalls=1;});
  add('real action during probe', f => {f.probe.realInvitesSent=1;});
  add('missing read-only evidence', f => {delete f.probe.realMembersRemoved;});
  add('string zero rejected', f => {f.probe.realMailSent='0';});
  add('missing desktop proof', f => {delete f.probe.desktop;});
  add('default desktop', f => {f.probe.desktop.desktop='Default';});
  add('active desktop', f => {f.probe.desktop.inputDesktop=f.probe.desktop.desktop;});
  add('wrong window station', f => {f.probe.desktop.windowStation='Service-0x0-3e7$';});
  add('isolation not proven', f => {f.probe.desktop.isolated=false;});
  add('different native run', f => {f.host.desktop='NUMEMS-Agentless-other';});
  add('ordinary host mode', f => {f.host.mode='run';});
  add('host still running', f => {f.host.state='running';});
  add('host nonzero exit', f => {f.host.exitCode=2;});
  add('host missing exit', f => {delete f.host.exitCode;});
  add('host error despite exit', f => {f.host.error='audit failed';});
  add('no audits', f => {f.host.audits=0;});
  add('noninteger audit count', f => {f.host.audits=0.5;});
  add('window appeared on user desktop', f => {f.host.maxOwnedWindowsOnInputDesktop=1;});
  add('missing window evidence', f => {delete f.host.maxOwnedWindowsOnInputDesktop;});
  add('final audit missing', f => {delete f.host.windowAudit;});
  add('final audit wrong desktop', f => {f.host.windowAudit.desktop='NUMEMS-Agentless-other';});
  add('final audit not isolated', f => {f.host.windowAudit.isolated=false;});
  add('final audit visible window', f => {f.host.windowAudit.ownedWindowsOnInputDesktop=1;});
  add('stale probe', f => {f.probe.checkedAt='2026-10-22T11:44:59.000Z';});
  add('stale host', f => {f.host.checkedAt='2026-10-22T11:44:59.000Z';});
  add('future probe', f => {f.probe.finishedAt='2026-10-22T12:00:01.000Z';});
  add('future host', f => {f.host.checkedAt='2026-10-22T12:00:01.000Z';});
  add('timezone absent', f => {f.probe.checkedAt='2026-10-22T11:58:00';});
  add('invalid timestamp', f => {f.probe.finishedAt='bad';});
  add('reversed probe times', f => {f.probe.checkedAt='2026-10-22T11:59:00.500Z';});
  add('host predates completed probe', f => {f.host.checkedAt='2026-10-22T11:58:59.000Z';});
  add('15 minute boundary accepted', f => {f.probe.checkedAt='2026-10-22T11:45:00.000Z';}, true);

  const temp = await mkdtemp(path.join(os.tmpdir(), 'numems-install-gate-'));
  try {
    const fixturePath = path.join(temp, 'cases.json');
    const scriptPath = path.join(temp, 'validate-only.ps1');
    await writeFile(fixturePath, JSON.stringify(cases));
    // Extract only the pure validator via PowerShell's AST. Never execute installer main.
    await writeFile(scriptPath, String.raw`param([string]$Installer,[string]$Cases)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Installer parse failed'}
$definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Read-JsonStringDates','Assert-IsolatedProbe')},$true))
if($definitions.Count -ne 2){throw 'Expected JSON reader and isolated evidence validator only'}
foreach($definition in $definitions){. ([scriptblock]::Create($definition.Extent.Text))}
function Get-ScheduledTask {throw 'Task APIs must never execute in this test'}
function Register-ScheduledTask {throw 'Task APIs must never execute in this test'}
function Start-ScheduledTask {throw 'Task APIs must never execute in this test'}
$fixtures=Read-JsonStringDates -Path $Cases
$results=foreach($case in $fixtures) {
  $accepted=$false; $reason=$null
  try {Assert-IsolatedProbe -Config $case.config -Probe $case.probe -HostReport $case.host -Now ([DateTimeOffset]::Parse($case.now)); $accepted=$true}
  catch {$reason=$_.Exception.Message}
  [pscustomobject]@{name=$case.name; accepted=$accepted; reason=$reason}
}
[pscustomobject]@{major=$PSVersionTable.PSVersion.Major; dateKindSupported=(Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind');
  timestampType=$fixtures[0].probe.checkedAt.GetType().FullName; timestamp=$fixtures[0].probe.checkedAt;
  utf8=$fixtures[0].utf8; results=@($results)} | ConvertTo-Json -Depth 4 -Compress
`);
    for (const [shell,major] of [['powershell.exe',5],['pwsh.exe',7]]) {
      await t.test(`actual PowerShell ${major}: UTF-8 string dates and strict evidence gate`, async()=>{
        const {stdout} = await execute(shell, [
          '-NoProfile','-NonInteractive','-File',scriptPath,'-Installer',installer,'-Cases',fixturePath,
        ], {windowsHide:true, timeout:30_000});
        const data = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
        assert.equal(data.major,major);
        assert.equal(data.timestampType,'System.String');
        assert.equal(data.timestamp,cases[0].probe.checkedAt);
        assert.equal(data.utf8,'无可见弹窗');
        assert.equal(data.results.length, cases.length);
        for (const [i, result] of data.results.entries()) {
          assert.equal(result.name, cases[i].name);
          assert.equal(result.accepted, cases[i].allowed, `${result.name}: ${result.reason ?? 'unexpected acceptance'}`);
        }
      });
    }
  } finally {
    // temp was created by mkdtemp for this test; no project or user data is removed.
    const resolvedTemp=path.resolve(temp);
    if(path.dirname(resolvedTemp)!==path.resolve(os.tmpdir()) || !path.basename(resolvedTemp).startsWith('numems-install-gate-'))
      throw new Error('Refusing to remove an unexpected test directory.');
    await rm(resolvedTemp, {recursive:true, force:true});
  }
});
