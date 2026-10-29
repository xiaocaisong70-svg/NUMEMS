// Explicit maintenance only. Never cancels leases, clears tickets, deploys Sites,
// edits D1, launches a model, deletes a tree, or re-enables the scheduler.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,mkdir,lstat,readdir,copyFile,rename,open,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {finishedFaultRescueEvidence} from './fault-rescue-ownership.mjs';
const exec=promisify(execFile);
export const V13_BACKUP={commit:'336b98236f694c3ea574e970efaaf29361b0e909',count:300,
  manifestSha256:'31675c9c1ff19fff7ce872154617b343083b73412f2b4571407e446d577fd0d0',
  bundleSha256:'d99592bbd77367fd0c83abc4c96b1d8d69b116069ce0630d6822db949f2a794d'};
const digest=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
const maybe=async p=>{try{return await readFile(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const json=async p=>{const raw=await maybe(p);return raw===null?null:JSON.parse(raw.toString('utf8'));};
const abs=p=>{if(typeof p!=='string'||!path.isAbsolute(p))throw new Error('Absolute paths are required.');return path.resolve(p);};
const under=(base,p)=>{const r=path.relative(base,p);return !!r&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
function member(base,relative) {
  if(typeof relative!=='string'||relative.includes('\\')||relative.startsWith('/')||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid backup member path.');
  const result=path.join(base,...relative.split('/'));if(!under(base,result))throw new Error('Backup path escapes its root.');return result;
}
async function noLinks(base,p) {
  if(base!==p&&!under(base,p))throw new Error('Path escaped its verified root.');
  let current=base;for(const part of ['.',...path.relative(base,p).split(path.sep).filter(Boolean)]) {
    if(part!=='.')current=path.join(current,part);
    try{if((await lstat(current)).isSymbolicLink())throw new Error('Links and junctions are not allowed.');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
async function sourceMatches(file,item) {
  const bytes=await readFile(file),blob=digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1');
  if(bytes.length!==item.bytes||digest(bytes)!==item.sha256||blob!==item.blob)throw new Error('V13 file failed canonical hash verification: '+item.path);
}
export async function verifyBackup(backupDir) {
  backupDir=abs(backupDir);await noLinks(path.parse(backupDir).root,backupDir);
  const raw=await readFile(path.join(backupDir,'manifest.json'));
  if(digest(raw)!==V13_BACKUP.manifestSha256)throw new Error('Pinned V13 manifest hash mismatch.');
  const manifest=JSON.parse(raw.toString('utf8'));
  if(manifest.sourceCommit!==V13_BACKUP.commit||manifest.files.length!==V13_BACKUP.count||new Set(manifest.files.map(f=>f.path)).size!==V13_BACKUP.count)
    throw new Error('Pinned V13 source identity or file inventory mismatch.');
  if(digest(await readFile(path.join(backupDir,'source-v13.bundle')))!==V13_BACKUP.bundleSha256)throw new Error('Pinned V13 Git bundle hash mismatch.');
  for(const item of manifest.files) {
    if(item.exactCanonical!==true)throw new Error('Backup is not canonical.');
    const file=member(path.join(backupDir,'canonical'),item.path);await noLinks(backupDir,file);await sourceMatches(file,item);
  }
  return manifest;
}
function fresh(at,now,max=900000){return typeof at==='string'&&Number.isFinite(Date.parse(at))&&Date.parse(at)<=now&&now-Date.parse(at)<=max;}
export async function localRollbackGate(targetRoot,now=Date.now()) {
  const runtime=path.join(targetRoot,'.sites-runtime','agentless');await noLinks(path.parse(targetRoot).root,targetRoot);await noLinks(targetRoot,runtime);
  const hosting=await json(path.join(targetRoot,'.openai','hosting.json'));
  if(hosting?.project_id!=='appgprj_6adace8f4e7481919901f886e4a0a2f2')throw new Error('The target is not the designated production Site checkout.');
  if(await maybe(path.join(runtime,'worker.lock'))!==null)throw new Error('Worker lock exists; preserve and reconcile it before rollback.');
  const stop=await json(path.join(runtime,'stop-result.json'));
  if(!stop||!['stopped','already_stopped'].includes(stop.state)||stop.modelCalls!==0||!fresh(stop.startedAt,now)||!fresh(stop.finishedAt,now)||Date.parse(stop.startedAt)>Date.parse(stop.finishedAt))throw new Error('A fresh graceful-stop result is required.');
  const journal=await json(path.join(runtime,'operation.json'));
  if(journal&&(journal.phase!=='settled'||journal.lease!=null||journal.receipt!=null||journal.submission!=null))throw new Error('Unsettled operation journal; no rollback or evidence deletion.');
  const rescue=await json(path.join(runtime,'fault-rescue.json'));
  if(rescue&&!finishedFaultRescueEvidence(rescue,{now}))
    throw new Error('A pending, active, invalid or uncertain fault rescue still owns recovery.');
  const config=await json(path.join(runtime,'config.json'));
  if(config?.siteUrl!=='https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/'||config.adminEmail!=='xiaocaisong70@gmail.com'||
    config.workspaceId!=='cd01c344-8ff9-41fd-a750-f7b30af9a7c9'||!under(runtime,path.resolve(config.profile??'')))throw new Error('Current runtime identity/profile is not the intended project.');
  return {runtime,config,host:await json(path.join(runtime,'host-desktop.json'))};
}
export function nativeRollbackGate(snapshot,targetRoot,host) {
  if(snapshot?.supported!==true||!Array.isArray(snapshot.processes)||!Array.isArray(snapshot.tasks))throw new Error('Native Windows process/task evidence is unavailable.');
  const root=targetRoot.toLowerCase(),processes=snapshot.processes;
  const owned=new Set(processes.filter(p=>typeof p.commandLine==='string'&&p.commandLine.toLowerCase().includes(root)&&
    p.processId!==process.pid&&!p.commandLine.includes('rollback-v13.mjs')).map(p=>p.processId));
  if(Number.isInteger(host?.processId)&&processes.some(p=>p.processId===host.processId))owned.add(host.processId);
  let count=-1;while(count!==owned.size){count=owned.size;for(const p of processes)if(owned.has(p.parentProcessId))owned.add(p.processId);}
  if(owned.size)throw new Error('A project/native browser host or descendant is still alive; no forced termination.');
  if(snapshot.tasks.some(t=>(t.name==='NUMEMS-Agentless'||String(t.arguments??'').toLowerCase().includes(root))&&t.state!=='Disabled'))
    throw new Error('Disable the NUMEMS scheduled task before rollback.');
}
export async function collectWindowsState() {
  if(process.platform!=='win32')return {supported:false};
  const script="$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | ForEach-Object { @{processId=[int]$_.ProcessId;parentProcessId=[int]$_.ParentProcessId;commandLine=$_.CommandLine} }); $t=@(Get-ScheduledTask | ForEach-Object { @{name=$_.TaskName;state=[string]$_.State;arguments=(@($_.Actions | ForEach-Object {$_.Arguments}) -join ' ')} }); @{supported=$true;processes=$p;tasks=$t} | ConvertTo-Json -Compress -Depth 5";
  const {stdout}=await exec(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
  return JSON.parse(stdout);
}
export function cloudRollbackGate(report,startedAt,now=Date.now()) {
  const p=report?.result;
  if(report?.command!=='rollback-status'||report.success!==true||report.modelCalls!==0||!fresh(report.finishedAt,now,60000)||
    Date.parse(report.startedAt)<startedAt||!fresh(report.startedAt,now,180000)||!p||!Number.isSafeInteger(p.revision)||
    p.schedulerEnabled!==false||p.memberEnabled!==false||p.busy!==false||p.holds!==0||!Object.hasOwn(p,'faultRescue')||
    p.faultRescue!==null&&!(p.faultRescue?.phase==='finished'&&['recovered','needs_human','unresolved','handled'].includes(p.faultRescue.outcome)))throw new Error('Fresh V14 cloud rollback proof is incomplete, active or unsafe.');
  return {revision:p.revision,checkedAt:report.finishedAt};
}
async function readCloud(targetRoot) {
  await exec(process.execPath,[path.join(targetRoot,'scripts','agentless','host.mjs'),'admin','rollback-status'],{cwd:targetRoot,windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  return json(path.join(targetRoot,'.sites-runtime','agentless','admin-result.json'));
}
async function prepareCloudCompatibility(targetRoot,revision) {
  await exec(process.execPath,[path.join(targetRoot,'scripts','agentless','host.mjs'),'admin','prepare-v13-rollback',String(revision)],
    {cwd:targetRoot,windowsHide:true,timeout:180000,maxBuffer:1024*1024});
}
async function extraSources(targetRoot,manifest) {
  const baseline=new Set(manifest.files.map(f=>f.path)),roots=new Set(manifest.files.map(f=>f.path.split('/')[0]).filter(x=>!x.startsWith('.'))),out=[];
  roots.add('docs');
  for(const entry of await readdir(targetRoot,{withFileTypes:true}))if(entry.isFile()&&!entry.name.startsWith('.')&&/\.(?:[cm]?js|tsx?|json|md|css|ps1|vbs|cs)$/i.test(entry.name))roots.add(entry.name);
  const walk=async relative=>{const p=member(targetRoot,relative);await noLinks(targetRoot,p);let st;try{st=await lstat(p);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(st.isDirectory()){for(const name of await readdir(p))await walk(relative+'/'+name);}
    else if(st.isFile()&&!baseline.has(relative))out.push(relative);};
  for(const root of roots)await walk(root);
  return out;
}
async function copyVerified(from,to) {await mkdir(path.dirname(to),{recursive:true});await copyFile(from,to);if(digest(await readFile(from))!==digest(await readFile(to)))throw new Error('Archive/staging copy verification failed.');}
/** Dependencies are injectable only by offline tests; CLI never accepts OS or cloud proof from a file. */
export async function rollbackV13(options,{native=collectWindowsState,cloud=readCloud,prepareCloud=prepareCloudCompatibility,now=Date.now,beforeReplace=async()=>{}}={}) {
  const targetRoot=abs(options.targetRoot),backupDir=abs(options.backupDir),archiveDir=options.archiveDir?abs(options.archiveDir):null;
  if(targetRoot===backupDir||under(targetRoot,backupDir)||under(backupDir,targetRoot)||archiveDir&&
    [targetRoot,backupDir].some(p=>p===archiveDir||under(p,archiveDir)||under(archiveDir,p)))throw new Error('Backup, target and archive roots must be disjoint.');
  const manifest=await verifyBackup(backupDir),local=await localRollbackGate(targetRoot,now());nativeRollbackGate(await native(),targetRoot,local.host);
  if(!options.verifyCloud)return {ready:false,requiresFreshCloudProof:true,backupFiles:manifest.files.length,sourceCommit:manifest.sourceCommit,localSafe:true,changed:false};
  const started=now();let report=await cloud(targetRoot),proof=cloudRollbackGate(report,started,now());
  if(report.result.faultRescue?.outcome==='handled') {
    if(!options.apply)return {ready:false,requiresV13OutcomeNormalization:true,backupFiles:manifest.files.length,cloud:proof,changed:false};
    await prepareCloud(targetRoot,proof.revision);
    report=await cloud(targetRoot);proof=cloudRollbackGate(report,started,now());
    if(report.result.faultRescue?.outcome==='handled')throw new Error('V13 cloud outcome normalization was not verified.');
  }
  const current=await localRollbackGate(targetRoot,now());nativeRollbackGate(await native(),targetRoot,current.host);
  if(!options.apply)return {ready:true,requiresFreshCloudProof:false,backupFiles:manifest.files.length,cloud:proof,changed:false};
  if(!archiveDir)throw new Error('Apply requires an explicit new absolute archive directory.');
  await noLinks(path.parse(archiveDir).root,archiveDir);try{await lstat(archiveDir);throw new Error('Archive directory already exists; do not overwrite rollback evidence.');}catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(archiveDir,{recursive:true});const progress={version:1,state:'staging',sourceCommit:manifest.sourceCommit,startedAt:new Date(now()).toISOString(),targetRoot,backupDir,cloud:proof,replaced:[],extras:[]};
  const save=()=>writeFile(path.join(archiveDir,'rollback-progress.json'),JSON.stringify(progress,null,2)+'\n',{mode:0o600});await save();
  for(const item of manifest.files){const staged=member(path.join(archiveDir,'staging-v13'),item.path);await copyVerified(member(path.join(backupDir,'canonical'),item.path),staged);await sourceMatches(staged,item);
    const live=member(targetRoot,item.path);await noLinks(targetRoot,live);if(await maybe(live)!==null)await copyVerified(live,member(path.join(archiveDir,'before'),item.path));}
  const extras=await extraSources(targetRoot,manifest);
  for(const relative of extras)await copyVerified(member(targetRoot,relative),member(path.join(archiveDir,'extras'),relative));
  await copyVerified(path.join(current.runtime,'config.json'),path.join(archiveDir,'runtime-config.before.json'));
  const originalRescue=await json(path.join(current.runtime,'fault-rescue.json'));
  if(originalRescue)await copyVerified(path.join(current.runtime,'fault-rescue.json'),path.join(archiveDir,'fault-rescue.before.json'));
  const lockPath=path.join(current.runtime,'rollback-v13.lock'),lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date(now()).toISOString(),archiveDir}));
  try {
    await localRollbackGate(targetRoot,now());nativeRollbackGate(await native(),targetRoot,current.host);
    progress.state='applying';await save();const config={...current.config,liveActions:false};delete config.faultRescue;
    const temporary=path.join(current.runtime,'config.rollback-'+randomUUID()+'.tmp');await writeFile(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600});await rename(temporary,path.join(current.runtime,'config.json'));
    if(originalRescue?.outcome==='handled') {
      // Already-ended, receipt-verified fallback is not a healthy script profile.
      // Preserve the original in the private rollback archive; V13 understands unresolved.
      const compatible={...originalRescue,outcome:'unresolved',rollbackFromOutcome:'handled',rollbackAt:new Date(now()).toISOString()};
      const tmp=path.join(current.runtime,'rescue.rollback-'+randomUUID()+'.tmp');
      await writeFile(tmp,JSON.stringify(compatible,null,2)+'\n',{mode:0o600});await rename(tmp,path.join(current.runtime,'fault-rescue.json'));
    }
    for(const item of manifest.files){await beforeReplace(item.path);await localRollbackGate(targetRoot,now());
      const live=member(targetRoot,item.path),tmp=live+'.rollback-'+randomUUID()+'.tmp';await copyVerified(member(path.join(archiveDir,'staging-v13'),item.path),tmp);await rename(tmp,live);await sourceMatches(live,item);progress.replaced.push(item.path);await save();}
    for(const relative of extras){const live=member(targetRoot,relative),archived=member(path.join(archiveDir,'extras'),relative);
      if(digest(await readFile(live))!==digest(await readFile(archived)))throw new Error('An extra source changed during rollback; preserved in place.');
      const moved=member(path.join(archiveDir,'moved-extras'),relative);await mkdir(path.dirname(moved),{recursive:true});await rename(live,moved);progress.extras.push(relative);await save();}
    for(const item of manifest.files)await sourceMatches(member(targetRoot,item.path),item);
    progress.state='restored_stopped';progress.finishedAt=new Date(now()).toISOString();await save();await lock.close();await unlink(lockPath);
    return {ready:true,changed:true,state:progress.state,files:manifest.files.length,extrasArchived:progress.extras.length,archiveDir,liveActions:false,cloudDeploymentRequired:true,modelCalls:0};
  }catch(error){progress.state='partial_stopped';progress.error=error.message;await save();await lock.close();throw new Error('Rollback stopped with evidence preserved at '+archiveDir+': '+error.message);}
}
export function optionsFromArgs(args) {
  const options={apply:false,verifyCloud:false,targetRoot:path.resolve(import.meta.dirname,'../..'),backupDir:'D:\\codexspace\\reports\\agentless-before-v14-20261028'};
  const flags=new Set();for(let i=0;i<args.length;i++){const arg=args[i];if(flags.has(arg))throw new Error('Duplicate rollback option.');flags.add(arg);
    if(arg==='--check')continue;if(arg==='--apply'){options.apply=true;continue;}if(arg==='--verify-cloud'){options.verifyCloud=true;continue;}
    const key={'--backup-dir':'backupDir','--target-root':'targetRoot','--archive-dir':'archiveDir'}[arg];if(!key||!args[i+1])throw new Error('Unknown or missing rollback option.');options[key]=args[++i];}
  if(options.apply&&(!flags.has('--backup-dir')||!flags.has('--target-root')||!flags.has('--archive-dir')||!options.verifyCloud))throw new Error('Apply requires explicit backup, target, archive and --verify-cloud.');
  if(flags.has('--check')&&options.apply)throw new Error('Choose --check or --apply, never both.');
  return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))rollbackV13(optionsFromArgs(process.argv.slice(2))).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
