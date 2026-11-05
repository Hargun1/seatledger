import { setTimeout as pause } from 'node:timers/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { runDeliveryBatch } from '../../apps/api/src/payments/delivery.js';
import { postSimulatedEvent } from '../../apps/api/src/payments/delivery-http.js';

const pool=createPool(readDatabaseConfig().DATABASE_URL);
try {await runDeliveryBatch(pool,{workerId:'delivery-crash-fixture',batchSize:1,leaseSeconds:1,
  callbackUrl:process.env.SIMULATOR_CALLBACK_URL,secret:process.env.SIMULATOR_WEBHOOK_SECRET,
  transport:async(...args)=>{await postSimulatedEvent(...args);process.stdout.write('{"event":"receipt-committed"}\n');await pause(30000);}});
}finally{await pool.end();}
