#!/usr/bin/env node
/**
 * Pulse development orchestrator
 * - Starts MongoDB (Docker) if needed
 * - Starts backend + frontend
 * - Public tunnel via Cloudflare (cloudflared) — preferred over ngrok
 * - Auto-detects public URL and configures CORS / client env
 *
 * Tunnel modes (first match wins):
 * 1) PULSE_PUBLIC_URL or CLOUDFLARE_PUBLIC_URL — use existing URL (you run cloudflared yourself)
 * 2) TUNNEL_TOKEN / CLOUDFLARE_TUNNEL_TOKEN — `cloudflared tunnel run --token …`
 * 3) Quick tunnel — `cloudflared tunnel --url http://127.0.0.1:5173` (trycloudflare.com)
 * 4) Fallback: ngrok if cloudflared unavailable
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
// Prefer 5050 — macOS AirPlay Receiver often binds :5000
const BACKEND_PORT = process.env.PORT || 5050;
const FRONTEND_PORT = process.env.FRONTEND_PORT || 5173;
const children = [];

function log(msg) {
  console.log(`\x1b[36m[pulse]\x1b[0m ${msg}`);
}

function warn(msg) {
  console.warn(`\x1b[33m[pulse]\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m[pulse]\x1b[0m ${msg}`);
}

function secret() {
  return crypto.randomBytes(48).toString('hex');
}

function ensureEnv() {
  const backendEnv = path.join(ROOT, 'backend', '.env');
  if (!fs.existsSync(backendEnv)) {
    execSync('node scripts/setup-env.js', { cwd: ROOT, stdio: 'inherit' });
  }
}

function updateEnvKey(filePath, key, value) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(filePath, content);
}

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      execSync(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`,
        { stdio: 'ignore' }
      );
    } else {
      execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, {
        stdio: 'ignore',
        shell: '/bin/bash',
      });
    }
  } catch {
    /* */
  }
}

function spawnProc(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...opts.env },
    stdio: opts.stdio || 'inherit',
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  });
  child._pulseName = name;
  children.push(child);
  child.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL' && code && code !== 0) {
      warn(`${name} exited with code ${code}`);
    }
  });
  return child;
}

function killChild(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* */
    }
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        timeout,
        headers: {
          'ngrok-skip-browser-warning': 'true',
          'User-Agent': 'pulse-start-dev',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function extractHttpsUrl(text) {
  if (!text) return null;
  // Prefer trycloudflare / cfargotunnel style hostnames first
  const preferred =
    text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i) ||
    text.match(/https:\/\/[a-z0-9.-]+\.cfargotunnel\.com/i);
  if (preferred) return preferred[0].replace(/\/$/, '');
  const any = text.match(/https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:\/[^\s"'<>]*)?/);
  if (!any) return null;
  const url = any[0].replace(/[),.;]+$/, '').replace(/\/$/, '');
  // Ignore Cloudflare API / dash hosts
  if (/cloudflare\.com|api\.cloudflare|developers\.cloudflare/i.test(url)) return null;
  return url;
}

async function waitForUrl(url, attempts = 60, delay = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await httpGet(url);
      if (res.status && res.status < 500) return true;
    } catch {
      /* retry */
    }
    await wait(delay);
  }
  return false;
}

function which(cmd) {
  try {
    return execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
      encoding: 'utf8',
    }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

async function ensureMongo() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/pulse';
  if (uri.includes('mongodb+srv') || uri.includes('mongodb.net')) {
    log('Using MongoDB Atlas connection from environment');
    return;
  }

  // Try local connection via docker compose
  const docker = which('docker');
  if (!docker) {
    warn('Docker not found. Ensure MongoDB is running at ' + uri);
    return;
  }

  try {
    log('Starting MongoDB via Docker…');
    execSync('docker compose up -d mongodb', {
      cwd: ROOT,
      stdio: 'pipe',
    });
    success('MongoDB container started');
    await wait(2500);
  } catch (err) {
    warn('Could not start MongoDB container: ' + (err.message || err));
    warn('If you use MongoDB Atlas, set MONGODB_URI in backend/.env');
  }
}

async function getNgrokTunnels() {
  try {
    const res = await httpGet('http://127.0.0.1:4040/api/tunnels');
    const json = JSON.parse(res.data);
    return json.tunnels || [];
  } catch {
    return [];
  }
}

async function getCloudflaredQuickHostname(metricsPort = 2000) {
  try {
    const res = await httpGet(`http://127.0.0.1:${metricsPort}/quicktunnel`);
    if (res.status === 200 && res.data) {
      const json = JSON.parse(res.data);
      const host = json.hostname || json.Hostname;
      if (host) {
        return host.startsWith('http') ? host.replace(/\/$/, '') : `https://${host}`;
      }
    }
  } catch {
    /* metrics not ready */
  }
  return null;
}

/**
 * Start a public tunnel to the Vite frontend (API/socket proxied same-origin).
 *
 * Prefer Cloudflare (cloudflared). Override with PULSE_TUNNEL=ngrok if needed.
 * Audio path is base64 PCM + iOS HTMLAudio playout (survives CF + Safari mic).
 */
async function startPublicTunnel(port) {
  // Explicit public URL (you manage the tunnel yourself)
  const preset =
    process.env.PULSE_PUBLIC_URL ||
    process.env.CLOUDFLARE_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    '';
  if (preset.startsWith('https://') || preset.startsWith('http://')) {
    success(`Using configured public URL: ${preset.replace(/\/$/, '')}`);
    return preset.replace(/\/$/, '');
  }

  const prefer = String(process.env.PULSE_TUNNEL || 'cloudflare').toLowerCase();
  const ngrokPath = which('ngrok');
  const cloudflared = which('cloudflared');

  // Optional: force ngrok
  if ((prefer === 'ngrok' || prefer === 'ngrok-only') && ngrokPath) {
    const url = await startNgrok(port);
    if (url) return url;
    warn('ngrok failed — trying Cloudflare…');
  }

  const tunnelToken =
    process.env.TUNNEL_TOKEN ||
    process.env.CLOUDFLARE_TUNNEL_TOKEN ||
    process.env.CF_TUNNEL_TOKEN ||
    '';

  if (cloudflared && tunnelToken) {
    log('Starting Cloudflare named tunnel (token)…');
    spawnProc('cloudflared', cloudflared, ['tunnel', '--no-autoupdate', 'run', '--token', tunnelToken], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const namedUrl =
      process.env.PULSE_PUBLIC_URL ||
      process.env.CLOUDFLARE_PUBLIC_URL ||
      process.env.PUBLIC_URL;
    if (namedUrl) {
      success(`Cloudflare tunnel token mode — public URL: ${namedUrl}`);
      return namedUrl.replace(/\/$/, '');
    }
    warn(
      'Named tunnel started with token, but no PULSE_PUBLIC_URL / CLOUDFLARE_PUBLIC_URL set.'
    );
    warn('Set that env to your tunnel hostname (e.g. https://pulse.example.com).');
    return null;
  }

  if (cloudflared) {
    const metricsPort = Number(process.env.CLOUDFLARED_METRICS_PORT || 2000);
    killPort(metricsPort);

    log(`Starting Cloudflare quick tunnel → http://127.0.0.1:${port}…`);
    let capturedUrl = null;
    const cf = spawnProc(
      'cloudflared',
      cloudflared,
      [
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'http2',
        '--url',
        `http://127.0.0.1:${port}`,
        '--metrics',
        `127.0.0.1:${metricsPort}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const onChunk = (d) => {
      const s = d.toString();
      if (process.env.PULSE_DEBUG) process.stdout.write(`[cloudflared] ${s}`);
      const found = extractHttpsUrl(s);
      if (found) capturedUrl = found;
    };
    cf.stdout?.on('data', onChunk);
    cf.stderr?.on('data', onChunk);

    for (let i = 0; i < 50; i++) {
      await wait(400);
      if (capturedUrl) {
        success(`Cloudflare tunnel: ${capturedUrl}`);
        return capturedUrl;
      }
      const fromMetrics = await getCloudflaredQuickHostname(metricsPort);
      if (fromMetrics) {
        success(`Cloudflare tunnel: ${fromMetrics}`);
        return fromMetrics;
      }
    }

    warn('cloudflared started but public URL not detected yet.');
    warn('Check cloudflared output, or set PULSE_PUBLIC_URL manually.');
    if (capturedUrl) return capturedUrl;
  }

  // Last resort: ngrok if we skipped it earlier
  if (ngrokPath) return startNgrok(port);

  warn('Neither ngrok nor cloudflared found on PATH. Skipping public tunnel.');
  warn('Install: brew install ngrok   (recommended for calls)');
  warn('Or:      brew install cloudflared');
  return null;
}

async function startNgrok(port) {
  const ngrokPath = which('ngrok');
  if (!ngrokPath) return null;

  const existing = await getNgrokTunnels();
  for (const t of existing) {
    const addr = String(t.config?.addr || '');
    if (addr.includes(String(port)) || addr.endsWith(`:${port}`)) {
      const url = t.public_url?.startsWith('https')
        ? t.public_url
        : existing.find((x) => x.public_url?.startsWith('https'))?.public_url || t.public_url;
      if (url) {
        success(`Reusing existing ngrok tunnel: ${url}`);
        return url;
      }
    }
  }

  log(`Starting ngrok http ${port}…`);
  const ngrok = spawnProc(
    'ngrok',
    ngrokPath,
    ['http', String(port), '--log=stdout'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  ngrok.stdout?.on('data', (d) => {
    if (process.env.PULSE_DEBUG) process.stdout.write(`[ngrok] ${d}`);
  });
  ngrok.stderr?.on('data', (d) => {
    if (process.env.PULSE_DEBUG) process.stderr.write(`[ngrok] ${d}`);
  });

  for (let i = 0; i < 40; i++) {
    await wait(500);
    const tunnels = await getNgrokTunnels();
    const httpsTunnel =
      tunnels.find(
        (t) =>
          t.public_url?.startsWith('https') &&
          (String(t.config?.addr || '').includes(String(port)) || tunnels.length === 1)
      ) || tunnels.find((t) => t.public_url?.startsWith('https'));

    if (httpsTunnel?.public_url) {
      success(`ngrok tunnel: ${httpsTunnel.public_url}`);
      return httpsTunnel.public_url;
    }
  }

  warn('ngrok started but public URL not detected yet. Check http://127.0.0.1:4040');
  return null;
}

async function configureForPublicUrl(publicUrl) {
  if (!publicUrl) return;

  const backendEnv = path.join(ROOT, 'backend', '.env');
  const frontendEnv = path.join(ROOT, 'frontend', '.env');

  // Single public origin → Vite proxies /api, /uploads, /socket.io (same as ngrok setup)
  updateEnvKey(backendEnv, 'CLIENT_URL', publicUrl);
  updateEnvKey(backendEnv, 'API_URL', publicUrl);
  updateEnvKey(
    backendEnv,
    'CORS_ORIGINS',
    `${publicUrl},http://localhost:5173,http://localhost:3000`
  );
  updateEnvKey(backendEnv, 'COOKIE_SECURE', 'true');

  // Empty VITE_API_URL → frontend uses same origin (Vite proxy)
  updateEnvKey(frontendEnv, 'VITE_API_URL', '');
  updateEnvKey(frontendEnv, 'VITE_SOCKET_URL', '');

  success(`Configured CORS and env for: ${publicUrl}`);
}

function shutdown() {
  log('Shutting down…');
  for (const child of children) {
    killChild(child);
  }
  killPort(BACKEND_PORT);
  killPort(FRONTEND_PORT);
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  console.log('\n');
  console.log('  ██████╗ ██╗   ██╗██╗     ███████╗███████╗');
  console.log('  ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝');
  console.log('  ██████╔╝██║   ██║██║     ███████╗█████╗  ');
  console.log('  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  ');
  console.log('  ██║     ╚██████╔╝███████╗███████║███████╗');
  console.log('  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝');
  console.log('  Real-time messaging platform\n');

  ensureEnv();
  await ensureMongo();

  // Free ports from previous runs
  killPort(BACKEND_PORT);
  killPort(FRONTEND_PORT);
  await wait(500);

  // 1) Frontend first (Vite proxies API/socket)
  log(`Starting frontend on :${FRONTEND_PORT}…`);
  spawnProc('frontend', 'npm', ['run', 'dev', '-w', 'frontend'], {
    env: {
      VITE_PROXY_TARGET: `http://127.0.0.1:${BACKEND_PORT}`,
    },
  });

  const frontendOk = await waitForUrl(`http://127.0.0.1:${FRONTEND_PORT}`, 45, 1000);
  if (!frontendOk) {
    warn('Frontend did not become ready in time');
  } else {
    success(`Frontend ready at http://localhost:${FRONTEND_PORT}`);
  }

  // 2) Public tunnel → frontend (Cloudflare preferred; PULSE_TUNNEL=ngrok to force ngrok)
  const publicUrl = await startPublicTunnel(FRONTEND_PORT);
  let backendEnv = {
    PORT: String(BACKEND_PORT),
  };

  if (publicUrl) {
    await configureForPublicUrl(publicUrl);
    backendEnv = {
      ...backendEnv,
      CLIENT_URL: publicUrl,
      API_URL: publicUrl,
      CORS_ORIGINS: `${publicUrl},http://localhost:${FRONTEND_PORT},http://localhost:3000`,
      COOKIE_SECURE: 'true',
    };
  }

  // 3) Backend once, with correct CORS / public URLs
  log(`Starting backend on :${BACKEND_PORT}…`);
  spawnProc('backend', 'npm', ['run', 'dev', '-w', 'backend'], {
    env: backendEnv,
  });

  const backendOk = await waitForUrl(`http://127.0.0.1:${BACKEND_PORT}/api/health`, 60, 1000);
  if (!backendOk) {
    warn('Backend health check timed out — continuing anyway');
  } else {
    success(`Backend ready at http://localhost:${BACKEND_PORT}`);
  }

  console.log('\n' + '═'.repeat(56));
  success('Pulse is running!');
  console.log(`  Local frontend : http://localhost:${FRONTEND_PORT}`);
  console.log(`  Local API      : http://localhost:${BACKEND_PORT}`);
  console.log(`  API health     : http://localhost:${BACKEND_PORT}/api/health`);
  if (publicUrl) {
    const viaCf = /trycloudflare\.com|cfargotunnel\.com/i.test(publicUrl);
    const viaNgrok = /ngrok/i.test(publicUrl);
    const label = viaCf ? 'Cloudflare' : viaNgrok ? 'ngrok' : 'tunnel';
    console.log(`  \x1b[1m\x1b[32mPublic URL (${label}): ${publicUrl}\x1b[0m`);
    if (viaCf) {
      console.log(
        `  cloudflared metrics: http://127.0.0.1:${process.env.CLOUDFLARED_METRICS_PORT || 2000}/metrics`
      );
    }
    if (viaNgrok) {
      console.log('  ngrok inspector : http://127.0.0.1:4040');
    }
  } else {
    console.log('  Public URL     : (tunnel not available — install ngrok or cloudflared)');
  }
  console.log('═'.repeat(56) + '\n');
  log('Press Ctrl+C to stop all services.\n');
}

main().catch((err) => {
  console.error(err);
  shutdown();
  process.exit(1);
});
