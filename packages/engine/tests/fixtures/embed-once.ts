// Runs one embed through the subprocess embedder with the worker given as argv[2], so a
// test can read this process's own stdout and stderr.
import { createSubprocessEmbedder } from '../../src/search/embedder-host.js';

const embedder = createSubprocessEmbedder({ modelsDir: '', workerPath: process.argv[2]! });
await embedder.embedDocument('text');
await embedder.shutdown();
