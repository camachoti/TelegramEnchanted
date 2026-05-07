import { spawn } from 'child_process';
import net from 'net';

const DEFAULT_PORT = 5173;
const HOST = '127.0.0.1';
const requestedPort = Number(process.env.VITE_DEV_SERVER_PORT || DEFAULT_PORT);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, HOST);
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }

  throw new Error(`No available dev server port found from ${startPort} to ${startPort + 99}`);
}

function waitForPort(port, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, HOST);

      socket.once('connect', () => {
        socket.end();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for Vite on port ${port}`));
          return;
        }

        setTimeout(tryConnect, 250);
      });
    };

    tryConnect();
  });
}

function spawnProcess(command, args, env) {
  return spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

const port = await findAvailablePort(requestedPort);
const devServerUrl = `http://localhost:${port}`;

console.log(`Starting Vite on ${devServerUrl}`);

const vite = spawnProcess('npm', ['run', 'start', '--', '--host', HOST, '--port', String(port)], {
  VITE_DEV_SERVER_PORT: String(port),
});

let electron;
let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (electron && !electron.killed) {
    electron.kill();
  }

  if (!vite.killed) {
    vite.kill();
  }

  process.exit(exitCode);
}

vite.once('exit', code => {
  if (!shuttingDown) {
    shutdown(code || 1);
  }
});

try {
  await waitForPort(port);
} catch (error) {
  console.error(error.message);
  shutdown(1);
}

electron = spawnProcess('npm', ['run', 'electron'], {
  NODE_ENV: 'development',
  VITE_DEV_SERVER_PORT: String(port),
  VITE_DEV_SERVER_URL: devServerUrl,
});

electron.once('exit', code => {
  shutdown(code || 0);
});

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
