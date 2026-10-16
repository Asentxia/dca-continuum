import fs from 'node:fs/promises';import net from 'node:net';import {callController} from '../dist/src/controller-client.js';
const x=JSON.parse(process.env.PROBE_CONFIG);const checks={};
async function cannotConnect(key,options){checks[key]=await new Promise(r=>{const s=net.connect(options,()=>{s.destroy();r(false);});s.on('error',()=>r(true));s.setTimeout(1500,()=>{s.destroy();r(true);});});}
await cannotConnect('provider_tcp_blocked',{host:'127.0.0.1',port:56670});
await cannotConnect('database_tcp_blocked',{host:'127.0.0.1',port:55432});
await cannotConnect('database_unix_blocked',{path:x.pgSocket});
try{await fs.readFile(x.secretPath);checks.credential_file_blocked=false;}catch{checks.credential_file_blocked=true;}
try{await callController(x.socket,'forged',x.operation);checks.forged_capability_blocked=false;}catch{checks.forged_capability_blocked=true;}
try{await callController(x.socket,x.capability,x.operation,'/dispatch',{tenant:'b',state:'COMMITTED',url:'http://127.0.0.1:56670'});checks.request_injection_blocked=false;}catch{checks.request_injection_blocked=true;}
try{await callController(x.socket,x.capability,'another-operation');checks.scope_bypass_blocked=false;}catch{checks.scope_bypass_blocked=true;}
const admitted=await callController(x.socket,x.capability,x.operation);checks.scoped_request_works=admitted.state==='COMMITTED';
console.log(JSON.stringify({uid:process.getuid(),checks}));if(!Object.values(checks).every(Boolean))process.exitCode=1;
