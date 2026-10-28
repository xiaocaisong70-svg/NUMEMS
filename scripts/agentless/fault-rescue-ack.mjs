import path from 'node:path';
import {runtimeDir} from './config.mjs';
import {requestFaultRescueAck} from './fault-rescue.mjs';

export async function main(args=process.argv.slice(2)) {
  const [flag,rescueId,outcomeFlag,outcome,...extra]=args;
  if(flag!=='--rescue-id'||outcomeFlag!=='--outcome'||extra.length)
    throw new Error('Usage: fault-rescue-ack.mjs --rescue-id ID --outcome recovered|unresolved|needs_human|uncertain');
  const result=await requestFaultRescueAck({directory:runtimeDir,rescueId,outcome});
  console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename)
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
