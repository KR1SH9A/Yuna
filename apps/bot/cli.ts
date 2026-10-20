import { runApplicationProcess } from '../../src/platform/runtime/process.js';
import { bootstrap } from './main.js';

await runApplicationProcess('bot', signal => bootstrap(process.env, { signal }));
