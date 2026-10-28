/** Start the worker process using its restricted configuration and shared signal lifecycle. */
import { runApplicationProcess } from '../../src/platform/runtime/process.js';
import { bootstrap } from './main.js';

await runApplicationProcess('ai-worker', (signal, onFailure) => bootstrap(process.env, { signal, onFailure }));
