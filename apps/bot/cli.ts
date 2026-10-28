/** Start the bot process with validated configuration and graceful shutdown handling. */
import { runApplicationProcess } from '../../src/platform/runtime/process.js';
import { bootstrap } from './main.js';

await runApplicationProcess('bot', (signal, onFailure) => bootstrap(process.env, { signal, onFailure }));
