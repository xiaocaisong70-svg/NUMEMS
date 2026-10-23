// Local control only. Never launches a browser, calls a model or cancels a lease.
import path from 'node:path';
import {runtimeDir} from './config.mjs';
import {atomicJson} from './journal.mjs';
import {requestGracefulStop} from './graceful-stop.mjs';

export function stopOptions(args) {
  if(!args.length)return {timeoutMs:300_000};
  if(args.length!==2 || args[0]!=='--timeout-ms' || !/^\d+$/.test(args[1]))
    throw new Error('用法：node scripts/agentless/stop.mjs [--timeout-ms 1000..600000]');
  const timeoutMs=Number(args[1]);
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>600_000)
    throw new Error('停机等待时间必须为 1000–600000 毫秒。');
  return {timeoutMs};
}

export async function main(args=process.argv.slice(2)) {
  const options=stopOptions(args);
  const report={startedAt:new Date().toISOString(),modelCalls:0};
  try {
    Object.assign(report,await requestGracefulStop({directory:runtimeDir,...options}));
    return report;
  } catch(error) {report.state='not_confirmed';report.error=error.message;throw error;}
  finally {report.finishedAt=new Date().toISOString();await atomicJson(path.join(runtimeDir,'stop-result.json'),report);}
}
if(process.argv[1] && path.resolve(process.argv[1])===import.meta.filename)
  main().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
