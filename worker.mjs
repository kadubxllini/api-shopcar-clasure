import { loadPrivateConfig } from './core.mjs';
import { validateWorkerConfig, processNext } from './worker-client.mjs';
const config = loadPrivateConfig(process.env.IMPORTER_WORKER_CONFIG, validateWorkerConfig);
while (true) {
  try {
    const code = await processNext(config);
    if (code) console.log(JSON.stringify({ code }));
  } catch { console.log(JSON.stringify({ code: 'UNAVAILABLE' })); }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
