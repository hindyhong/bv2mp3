#!/usr/bin/env node
/**
 * BV2MP3 · 本地服务
 * 静态页面 + 任务队列 + SSE 进度 + 音频流。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const WORKER = path.join(__dirname, 'worker.mjs');

const DEFAULT_CONFIG = {
  outputDir: path.join(__dirname, 'output'),
  threads: 10,
  naming: 'AUTHOR-TITLE',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

let config = { ...DEFAULT_CONFIG, outputDir: DEFAULT_CONFIG.outputDir };

/** 内存中的任务表 */
const jobs = new Map();
const jobOrder = [];
const queue = [];
let activeJob = null;
const sseClients = new Map();

const MAX_JOBS = 60;

// ---------------------------------------------------------------- config

async function loadConfig() {
  try {
    const raw = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
    config = { ...DEFAULT_CONFIG, ...raw };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(config.outputDir, { recursive: true });
}

async function saveConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------- helpers

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: 'not found' });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJoin(dir, name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return null;
  return path.join(dir, base);
}

// ---------------------------------------------------------------- jobs

function publicJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    status: job.status,
    urls: job.urls.length,
    total: job.total,
    done: job.done,
    failed: job.failed,
    pages: job.pages,
    files: job.files,
    error: job.error,
  };
}

function broadcast(job) {
  const clients = sseClients.get(job.id);
  if (!clients || clients.size === 0) return;
  const payload = `event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
  const terminal = job.status === 'done' || job.status === 'error' || job.status === 'cancelled';
  for (const res of [...clients]) {
    try {
      res.write(payload);
      if (terminal) {
        res.end();
        clients.delete(res);
      }
    } catch {
      clients.delete(res);
    }
  }
  if (clients.size === 0) sseClients.delete(job.id);
}

function createJob(urls) {
  const job = {
    id: 'j_' + randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: 'queued',
    urls,
    total: 0,
    done: 0,
    failed: 0,
    pages: [],
    files: [],
    error: null,
    lastMessageAt: Date.now(),
    child: null,
  };
  jobs.set(job.id, job);
  jobOrder.push(job.id);
  while (jobOrder.length > MAX_JOBS) {
    const old = jobOrder.shift();
    if (old === activeJob?.id) {
      jobOrder.push(old);
      break;
    }
    jobs.delete(old);
  }
  queue.push(job);
  pump();
  return job;
}

function onWorkerLine(job, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  job.lastMessageAt = Date.now();
  if (msg.t === 'pages') {
    const urlErrors = Array.isArray(msg.urlErrors) ? msg.urlErrors : [];
    job.total = msg.total + urlErrors.length;
    job.failed = urlErrors.length;
    job.done = urlErrors.length;
    job.pages = [
      ...msg.pages.map((p) => ({ index: p.index, title: p.title, status: 'pending' })),
      ...urlErrors.map((e, i) => ({
        index: msg.total + i + 1,
        title: e.url,
        status: 'fail',
        error: e.error,
      })),
    ];
  } else if (msg.t === 'start') {
    const p = job.pages.find((x) => x.index === msg.index);
    if (p) p.status = 'running';
  } else if (msg.t === 'ok') {
    const p = job.pages.find((x) => x.index === msg.index);
    if (p) {
      p.status = 'ok';
      p.name = msg.name;
    }
    job.files.push({ index: msg.index, name: msg.name });
  } else if (msg.t === 'fail') {
    const p = job.pages.find((x) => x.index === msg.index);
    if (p) {
      p.status = 'fail';
      p.error = msg.error;
    }
    job.failed += 1;
  } else if (msg.t === 'progress') {
    job.done = msg.done;
  } else if (msg.t === 'end') {
    job.done = msg.done;
    job.failed = msg.failed;
  } else if (msg.t === 'fatal') {
    job.error = msg.error;
  }
  broadcast(job);
}

function pump() {
  if (activeJob || queue.length === 0) return;
  const job = queue.shift();
  activeJob = job;
  job.status = 'running';
  broadcast(job);

  const child = spawn(process.execPath, [WORKER], {
    cwd: config.outputDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  job.child = child;
  job.lastMessageAt = Date.now();

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onWorkerLine(job, line);
    }
  });

  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errBuf += chunk;
    if (errBuf.length > 8000) errBuf = errBuf.slice(-8000);
  });

  child.on('error', (err) => {
    job.error = String(err.message || err);
  });

  child.on('close', (code) => {
    if (!job.error && code !== 0) job.error = (errBuf.trim() || `worker exited ${code}`).slice(0, 400);
    if (job.status === 'running') {
      job.status = job.error ? 'error' : 'done';
    }
    job.finishedAt = new Date().toISOString();
    activeJob = null;
    broadcast(job);
    pump();
  });

  try {
    child.stdin.end(JSON.stringify({ urls: job.urls, threads: config.threads, naming: config.naming }));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- durations

const durationCache = new Map();

async function probeDuration(filePath, mtimeMs) {
  const key = `${filePath}:${mtimeMs}`;
  if (durationCache.has(key)) return durationCache.get(key);
  let value = null;
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 10000 },
    );
    const n = Number.parseFloat(String(stdout).trim());
    if (Number.isFinite(n) && n > 0) value = n;
  } catch {
    value = null;
  }
  durationCache.set(key, value);
  return value;
}

async function listFiles() {
  let entries = [];
  try {
    entries = await fsp.readdir(config.outputDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (!lower.endsWith('.mp3') && !lower.endsWith('.flv')) continue;
    const full = path.join(config.outputDir, e.name);
    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      continue;
    }
    items.push({ name: e.name, size: st.size, mtime: st.mtimeMs, full });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

async function withDurations(items) {
  const missing = items.filter((i) => i.name.toLowerCase().endsWith('.mp3') && durationCache.get(`${i.full}:${i.mtime}`) === undefined);
  const CONCURRENCY = 6;
  let cursor = 0;
  async function run() {
    while (cursor < missing.length) {
      const item = missing[cursor++];
      await probeDuration(item.full, item.mtime);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, run));
  return items.map((i) => ({
    name: i.name,
    size: i.size,
    mtime: i.mtime,
    duration: durationCache.get(`${i.full}:${i.mtime}`) ?? null,
  }));
}

// ---------------------------------------------------------------- static

async function serveStatic(req, res, relPath) {
  const filePath = path.join(PUBLIC_DIR, relPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    return notFound(res);
  }
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(resolved).pipe(res);
}

async function streamAudio(req, res, name) {
  const full = safeJoin(config.outputDir, name);
  if (!full) return notFound(res);
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  const type = 'audio/mpeg';
  const range = req.headers.range;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (m) {
      const rawStart = m[1];
      const rawEnd = m[2];
      let start;
      let end;
      if (rawStart === '' && rawEnd !== '') {
        const suffix = Number.parseInt(rawEnd, 10);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = Number.parseInt(rawStart || '0', 10);
        end = rawEnd === '' ? stat.size - 1 : Number.parseInt(rawEnd, 10);
      }
      if (!Number.isFinite(start) || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------- router

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && pathname === '/api/config') {
      return json(res, 200, {
        outputDir: config.outputDir,
        threads: config.threads,
        naming: config.naming,
        ffmpeg: await hasFfmpeg(),
      });
    }

    if (req.method === 'PUT' && pathname === '/api/config') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const next = { ...config };
      if (typeof body.outputDir === 'string' && body.outputDir.trim()) {
        const dir = body.outputDir.trim().replace(/^~(?=$|\/)/, process.env.HOME || '');
        const abs = path.isAbsolute(dir) ? dir : path.resolve(__dirname, dir);
        await fsp.mkdir(abs, { recursive: true });
        next.outputDir = abs;
      }
      if (Number.isInteger(body.threads) && body.threads >= 1 && body.threads <= 16) {
        next.threads = body.threads;
      }
      config = next;
      await saveConfig();
      return json(res, 200, { outputDir: config.outputDir, threads: config.threads, naming: config.naming });
    }

    if (req.method === 'POST' && pathname === '/api/jobs') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const urls = Array.isArray(body.urls) ? body.urls : [];
      const clean = [];
      for (const raw of urls) {
        const u = normalizeUrl(raw);
        if (u && !clean.includes(u)) clean.push(u);
      }
      if (clean.length === 0) return json(res, 400, { error: '没有可用的 Bilibili 链接' });
      const job = createJob(clean);
      return json(res, 201, publicJob(job));
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      const list = jobOrder.map((id) => jobs.get(id)).filter(Boolean).map(publicJob);
      return json(res, 200, { jobs: list, active: activeJob?.id ?? null });
    }

    const jobMatch = /^\/api\/jobs\/(j_[a-z0-9]+)(\/stream)?$/.exec(pathname);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return notFound(res);
      if (jobMatch[2]) return openStream(req, res, job);
      return json(res, 200, publicJob(job));
    }

    if (req.method === 'GET' && pathname === '/api/files') {
      const items = await listFiles();
      return json(res, 200, { files: await withDurations(items), outputDir: config.outputDir });
    }

    if (req.method === 'GET' && pathname === '/api/audio') {
      return streamAudio(req, res, url.searchParams.get('name'));
    }

    if (req.method === 'POST' && pathname === '/api/files/reveal') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const full = safeJoin(config.outputDir, body.name);
      if (!full) return json(res, 400, { error: 'bad name' });
      await revealItem(full);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && pathname === '/api/files') {
      const full = safeJoin(config.outputDir, url.searchParams.get('name'));
      if (!full) return json(res, 400, { error: 'bad name' });
      try {
        await fsp.unlink(full);
      } catch {
        return json(res, 404, { error: '文件不存在' });
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/folder') {
      await revealItem(config.outputDir, true);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') return serveStatic(req, res, 'index.html');
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      return serveStatic(req, res, pathname.slice(1));
    }

    notFound(res);
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
}

function openStream(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`);

  if (!sseClients.has(job.id)) sseClients.set(job.id, new Set());
  sseClients.get(job.id).add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    const set = sseClients.get(job.id);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(job.id);
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const bv = /(BV[0-9A-Za-z]{10})/.exec(text);
  if (bv) return `https://www.bilibili.com/video/${bv[1]}`;
  if (/^https?:\/\/(www\.)?bilibili\.com\//i.test(text)) return text;
  return null;
}

let ffmpegChecked = null;
async function hasFfmpeg() {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 8000 });
    ffmpegChecked = true;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

function revealItem(target, isFolder = false) {
  return new Promise((resolve) => {
    const platform = process.platform;
    if (platform === 'darwin') {
      const args = isFolder ? [target] : ['-R', target];
      const child = spawn('open', args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve());
      child.on('spawn', () => resolve());
      child.unref();
    } else {
      resolve();
    }
  });
}

// ---------------------------------------------------------------- boot

async function main() {
  await loadConfig();

  // 卡死看门狗：3 分钟无任何进度则终止子进程
  setInterval(() => {
    if (!activeJob || !activeJob.child) return;
    if (Date.now() - (activeJob.lastMessageAt || 0) > 180000) {
      try {
        activeJob.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      activeJob.error = '子进程长时间无响应，已终止';
    }
  }, 30000).unref();

  const open = process.argv.includes('--open');
  const preferred = Number(process.env.PORT) || 7788;

  let server;
  for (let port = preferred; port < preferred + 20; port += 1) {
    server = http.createServer(handle);
    const ok = await new Promise((resolve) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') resolve(false);
        else {
          console.error(err);
          resolve(false);
        }
      });
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      console.log(`\n  BV2MP3 已启动  ${url}`);
      console.log(`  输出目录    ${config.outputDir}`);
      console.log(`  停止服务    Ctrl+C\n`);
      if (process.platform === 'darwin') {
        try {
          spawn('pbcopy').stdin.end(url);
        } catch {
          /* 复制失败不影响使用 */
        }
      }
      if (open) {
        spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      }
      break;
    }
    server.close();
    server = null;
  }
  if (!server) {
    console.error('无法启动服务：端口被占用');
    process.exit(1);
  }

  const shutdown = () => {
    for (const set of sseClients.values()) for (const res of set) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
