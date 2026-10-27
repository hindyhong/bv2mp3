/**
 * BV2MP3 · 转换进程
 * 由 server.mjs 派生，cwd 指向输出目录。
 * stdin 收 { urls, threads, naming }，stdout 逐行回 NDJSON 进度。
 */
import axios from 'axios';
import fs from 'node:fs';
import { fetchPages } from './node_modules/bv2mp3/src/bilibili/fetchPages.js';
import { download } from './node_modules/bv2mp3/src/download/downloadTask.js';
import { flv2mp3 } from './node_modules/bv2mp3/src/convert/flv2mp3.js';

axios.defaults.headers = {
  referer: 'https://www.bilibili.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0',
};
axios.defaults.timeout = 0;

const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

const MAX_RETRY = 3;

async function main() {
  const payload = JSON.parse((await readStdin()) || '{}');
  const urls = Array.isArray(payload.urls) ? payload.urls : [];
  const threads = Math.max(1, Math.min(16, Number(payload.threads) || 10));
  const naming = payload.naming || 'AUTHOR-TITLE';

  // 各链接并行抓取页面信息；单条失败不拖垮整批
  const results = await Promise.all(
    urls.map(async (url) => {
      for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
        try {
          return { url, pages: await fetchPages([url]) };
        } catch (err) {
          if (attempt === MAX_RETRY - 1) {
            return { url, error: String(err?.message || err) };
          }
          await sleep(1200 * (attempt + 1));
        }
      }
      return { url, error: 'unknown error' };
    }),
  );

  const pages = [];
  const urlErrors = [];
  for (const r of results) {
    if (r.error) {
      urlErrors.push({ url: r.url, error: r.error });
      continue;
    }
    for (const p of r.pages) pages.push({ ...p, index: pages.length + 1 });
  }

  const totalAll = pages.length + urlErrors.length;
  emit({
    t: 'pages',
    pages: pages.map((p) => ({ index: p.index, title: p.title, url: p.url })),
    total: pages.length,
    urlErrors,
  });

  let cursor = 0;
  let done = urlErrors.length;
  let failed = urlErrors.length;

  async function runOne(page) {
    emit({ t: 'start', index: page.index });
    let ok = false;
    let name = null;
    let lastErr = null;

    for (let attempt = 0; attempt < MAX_RETRY && !ok; attempt += 1) {
      try {
        const { filename } = await download(page.url, page.index, { naming });
        await flv2mp3(filename, '');
        name = filename.replace('.flv', '.mp3');
        try {
          await fs.promises.unlink(filename);
        } catch {
          /* 转换后原文件已由 ffmpeg 读取，删除失败不影响结果 */
        }
        ok = true;
      } catch (err) {
        lastErr = err;
        await sleep(1500 * (attempt + 1));
      }
    }

    if (ok) {
      emit({ t: 'ok', index: page.index, name });
    } else {
      failed += 1;
      emit({ t: 'fail', index: page.index, error: String(lastErr?.message || lastErr) });
    }
    done += 1;
    emit({ t: 'progress', done, total: totalAll });
  }

  async function lane() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= pages.length) return;
      await runOne(pages[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(threads, Math.max(pages.length, 1)) }, lane));
  emit({ t: 'end', done, failed });
}

main().catch((err) => {
  emit({ t: 'fatal', error: String(err?.stack || err?.message || err) });
  process.exit(1);
});
