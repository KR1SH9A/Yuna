import { runApplicationProcess } from '../../src/platform/runtime/process.js';
import { bootstrap } from './main.js';

await runApplicationProcess('ai-worker', signal => bootstrap(process.env, { signal }));
