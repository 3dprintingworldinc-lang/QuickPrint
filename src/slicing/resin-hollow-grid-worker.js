'use strict';

const { parentPort,workerData } = require('node:worker_threads');
const { auditResinHollowGrid } = require('./resin-hollow-grid');

if (!parentPort) throw new Error('The hollow grid audit must be launched by its managed worker wrapper.');
try {
  parentPort.postMessage({ ok:true,result:auditResinHollowGrid(workerData) });
} catch (error) {
  parentPort.postMessage({ ok:false,error:{
    code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,100}$/.test(error.code)?error.code:'RESIN_HOLLOW_GRID_WORKER_FAILED',
    status:Number.isSafeInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:500,
    message:String(error?.message||'The hollow grid worker failed.').slice(0,2000),
  } });
} finally { parentPort.close(); }
