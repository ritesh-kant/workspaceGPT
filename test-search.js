const { fork } = require('child_process');
const path = require('path');
const os = require('os');

const processPath = path.join(
  __dirname,
  'apps/vscode-extensions/dist/workers/confluence/searchProcess.js'
);
const embeddingDirPath = path.join(
  os.homedir(),
  'Library/Application Support/Antigravity/User/globalStorage/riteshkant.workspacegpt-extension',
  'ado/embeddings'
);

const worker = fork(processPath, [], {
  execArgv: ['--max-old-space-size=4096'],
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
});

worker.on('message', (msg) => {
  if (msg.type === 'ready') {
    console.log('Worker ready. Sending search query...');
    worker.send({ type: 'search', query: 'tell me about 1224706', namespace: 'ADO' });
  } else if (msg.type === 'results') {
    console.log('Got results!');
    msg.data.forEach((r, i) => {
      console.log(`[${i}] Score: ${r.score} - File: ${r.data.fileName}`);
    });
    worker.kill();
  } else if (msg.type === 'error') {
    console.error('Error from worker:', msg.message);
    worker.kill();
  }
});

worker.stdout.on('data', (data) => console.log('WORKER OUT:', data.toString().trim()));
worker.stderr.on('data', (data) => console.error('WORKER ERR:', data.toString().trim()));

console.log('Initializing worker at:', embeddingDirPath);
worker.send({ type: 'init', embeddingDirPath, namespace: 'ADO' });
