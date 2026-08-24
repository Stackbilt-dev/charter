import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const chromeBinary = process.env.CHARTER_CHROME_BIN || 'google-chrome';
const profileDir = mkdtempSync(join(tmpdir(), 'charter-launch-render-'));
const activePortPath = join(profileDir, 'DevToolsActivePort');
const assets = [
  ['docs/assets/context-routing-benchmark.svg', 'docs/assets/context-routing-benchmark.png'],
  ['docs/assets/adf-spec-card.svg', 'docs/assets/adf-spec-card.png'],
];

const chrome = spawn(chromeBinary, [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--hide-scrollbars',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  'about:blank',
], {
  stdio: 'ignore',
});

try {
  const port = await waitForDevToolsPort(activePortPath);
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const page = pages.find((entry) => entry.type === 'page');
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('Chrome did not expose a debuggable page.');
  }

  const client = await createDevToolsClient(page.webSocketDebuggerUrl);
  try {
    await client.command('Page.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 630,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const [sourceRelative, outputRelative] of assets) {
      const sourcePath = join(repoRoot, sourceRelative);
      const outputPath = join(repoRoot, outputRelative);
      if (!existsSync(sourcePath)) throw new Error(`Missing source asset: ${sourceRelative}`);

      const loaded = client.event('Page.loadEventFired');
      await client.command('Page.navigate', { url: pathToFileURL(sourcePath).href });
      await loaded;
      const screenshot = await client.command('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 },
      });
      writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
      console.log(`Rendered ${outputRelative}`);
    }
  } finally {
    client.close();
  }
} finally {
  chrome.kill('SIGTERM');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`Warning: could not remove temporary Chrome profile ${profileDir}: ${error.message}\n`);
  }
}

async function waitForDevToolsPort(filePath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(filePath)) {
      const [port] = readFileSync(filePath, 'utf8').split(/\r?\n/);
      if (port) return port;
    }
    if (chrome.exitCode !== null) {
      throw new Error(`${chromeBinary} exited before opening DevTools.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${chromeBinary} DevTools.`);
}

async function createDevToolsClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }

    const queue = listeners.get(message.method);
    if (!queue?.length) return;
    listeners.set(message.method, queue.slice(1));
    queue[0](message.params);
  });

  return {
    command(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveCommand, rejectCommand) => {
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    event(method) {
      return new Promise((resolveEvent) => {
        const queue = listeners.get(method) || [];
        listeners.set(method, [...queue, resolveEvent]);
      });
    },
    close() {
      socket.close();
    },
  };
}
