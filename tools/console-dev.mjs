import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
const node22=process.env.CT_NODE22_BIN??'/data/toolchains/node22/bin',key=randomBytes(32).toString('hex');
const env={...process.env,CT_RUNTIME_ENV:'local-test',CT_ALLOW_LOCAL_FIXTURES:'yes',CT_LOCAL_TEST_BUILD:'yes',CT_CONSOLE_MODE:'LOCAL_FIXTURE',CT_DATABASE:'ct_console_dev',CT_API_PORT:'5660',CT_DOMAIN_API_ORIGIN:'http://127.0.0.1:5660',CT_CONSOLE_ORIGIN:'http://127.0.0.1:5661',CT_FIXTURE_SERVER_KEY:key,NEXT_TELEMETRY_DISABLED:'1'};
const children=[spawn(process.execPath,['dist/internal/fixtures/console-server.js'],{env,stdio:'inherit',detached:true}),spawn(node22+'/node',['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port','5661'],{cwd:process.cwd()+'/web',env,stdio:'inherit',detached:true})];
console.log('Focus Desk local test console: http://127.0.0.1:5661. Production remains BLOCKED.');
function stop(){for(const p of children)if(p.pid)try{process.kill(-p.pid,'SIGTERM');}catch{}setTimeout(()=>process.exit(0),500);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);for(const child of children)child.on('exit',()=>stop());
