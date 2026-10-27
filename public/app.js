/* BV2MP3 · 前端 */

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  links: $('#links'),
  tally: $('#tally'),
  start: $('#start'),
  jobs: $('#jobs'),
  files: $('#files'),
  fileTally: $('#fileTally'),
  filter: $('#filter'),
  settings: $('#settings'),
  settingsToggle: $('#settingsToggle'),
  outputDir: $('#outputDir'),
  threads: $('#threads'),
  saveSettings: $('#saveSettings'),
  settingsNote: $('#settingsNote'),
  openFolder: $('#openFolder'),
  player: $('#player'),
  toast: $('#toast'),
};

const state = {
  config: null,
  files: [],
  filter: '',
  playing: null,
  playingRow: null,
  jobEls: new Map(),
  sources: new Map(),
};

/* ------------------------------------------------------------ helpers */

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), 2600);
}

function parseLinks(text) {
  const seen = new Set();
  const urls = [];
  let invalid = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bv = /(BV[0-9A-Za-z]{10})/.exec(line);
    let url = null;
    if (bv) url = `https://www.bilibili.com/video/${bv[1]}`;
    else if (/^https?:\/\/(www\.)?bilibili\.com\//i.test(line)) url = line;
    if (!url) {
      invalid += 1;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return { urls, invalid };
}

/* ------------------------------------------------------------ config */

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
    els.outputDir.value = state.config.outputDir || '';
    els.threads.value = state.config.threads || 10;
    if (state.config.ffmpeg === false) {
      els.settingsNote.textContent = '未检测到 ffmpeg，无法转换';
      els.settingsNote.style.color = 'var(--danger)';
    }
  } catch {
    els.settingsNote.textContent = '无法连接本地服务';
    els.settingsNote.style.color = 'var(--danger)';
  }
}

async function saveConfig() {
  const body = {
    outputDir: els.outputDir.value.trim(),
    threads: Number(els.threads.value) || 10,
  };
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      els.settingsNote.textContent = '保存失败：' + (data.error || res.status);
      els.settingsNote.style.color = 'var(--danger)';
      return;
    }
    state.config = { ...state.config, ...data };
    els.outputDir.value = data.outputDir;
    els.settingsNote.style.color = '';
    els.settingsNote.textContent = '已保存';
    setTimeout(() => {
      if (els.settingsNote.textContent === '已保存') els.settingsNote.textContent = '';
    }, 2200);
    refreshFiles();
  } catch (err) {
    els.settingsNote.textContent = String(err.message || err);
    els.settingsNote.style.color = 'var(--danger)';
  }
}

/* ------------------------------------------------------------ jobs */

function jobStatusText(job) {
  if (job.status === 'queued') return '排队中';
  if (job.status === 'running') return job.total ? `转换中 ${job.done}/${job.total}` : '解析中';
  if (job.status === 'done') return job.failed ? `完成 · ${job.failed} 个失败` : '完成';
  if (job.status === 'error') return '出错';
  return '';
}

function createJobEl() {
  const root = document.createElement('article');
  root.className = 'job';

  const head = document.createElement('div');
  head.className = 'job-head';

  const left = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'job-title';
  const sub = document.createElement('p');
  sub.className = 'job-sub';
  left.append(title, sub);

  const st = document.createElement('span');
  st.className = 'job-state';

  head.append(left, st);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('span');
  bar.append(fill);

  const list = document.createElement('ul');
  list.className = 'pages';

  root.append(head, bar, list);
  root._refs = { title, sub, st, fill, list, rows: new Map() };
  return root;
}

function upsertJob(job) {
  let el = state.jobEls.get(job.id);
  if (!el) {
    el = createJobEl();
    state.jobEls.set(job.id, el);
    els.jobs.prepend(el);
  }
  const r = el._refs;

  r.title.textContent = `${job.urls} 个链接${job.total ? ` · ${job.total} 个分P` : ''}`;
  r.sub.textContent = fmtTime(job.createdAt);

  r.st.textContent = jobStatusText(job);
  const stateClass =
    job.status === 'error'
      ? ' is-error'
      : job.status === 'done' && job.failed
        ? ' is-warn'
        : job.status === 'running'
          ? ' is-running'
          : '';
  r.st.className = 'job-state' + stateClass;

  const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  r.fill.style.width = `${pct}%`;

  for (const page of job.pages || []) {
    let row = r.rows.get(page.index);
    if (!row) {
      const li = document.createElement('li');
      li.className = 'page';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const t = document.createElement('span');
      t.className = 'page-title';
      const s = document.createElement('span');
      s.className = 'page-state';
      li.append(dot, t, s);
      r.list.append(li);
      row = { li, t, s };
      r.rows.set(page.index, row);
    }
    row.t.textContent = page.title || `第 ${page.index} 分P`;
    row.t.title = page.title || '';
    const cls =
      page.status === 'running'
        ? 'is-running'
        : page.status === 'ok'
          ? 'is-ok'
          : page.status === 'fail'
            ? 'is-fail'
            : 'is-pending';
    row.li.className = `page ${cls}`;
    row.s.textContent =
      page.status === 'ok'
        ? '已保存'
        : page.status === 'fail'
          ? '失败'
          : page.status === 'running'
            ? '转换中'
            : '';
  }
}

function subscribe(id) {
  if (state.sources.has(id)) return;
  const es = new EventSource(`/api/jobs/${id}/stream`);
  state.sources.set(id, es);

  es.addEventListener('job', (ev) => {
    let job;
    try {
      job = JSON.parse(ev.data);
    } catch {
      return;
    }
    upsertJob(job);
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      es.close();
      state.sources.delete(id);
      refreshFiles();
      if (job.status === 'error') toast('转换出错：' + (job.error || '未知错误'));
      else if (job.failed) toast(`完成，${job.failed} 个失败`);
      else toast('转换完成');
    }
  });
}

async function submit() {
  const { urls, invalid } = parseLinks(els.links.value);
  if (urls.length === 0) {
    toast(invalid ? '没有识别到 Bilibili 链接' : '先粘贴至少一个链接');
    return;
  }
  els.start.disabled = true;
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    els.links.value = '';
    updateTally();
    upsertJob(data);
    subscribe(data.id);
    toast(`已加入队列 · ${urls.length} 条`);
  } catch (err) {
    toast('提交失败：' + (err.message || err));
  } finally {
    els.start.disabled = false;
  }
}

async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const data = await res.json();
    for (const job of data.jobs || []) upsertJob(job);
    for (const job of data.jobs || []) {
      if (job.status === 'running' || job.status === 'queued') subscribe(job.id);
    }
  } catch {
    /* 服务未就绪时静默 */
  }
}

/* ------------------------------------------------------------ files */

async function refreshFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    state.files = data.files || [];
    renderFiles();
  } catch {
    /* ignore */
  }
}

function fileRow(file) {
  const row = document.createElement('div');
  row.className = 'file' + (state.playing === file.name ? ' is-playing' : '');
  row.dataset.name = file.name;

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play';
  play.dataset.action = 'play';
  play.setAttribute('aria-label', `播放 ${file.name}`);
  play.append(icon(state.playing === file.name && !els.player.paused ? 'i-pause' : 'i-play'));

  const body = document.createElement('div');
  body.className = 'file-body';

  const name = document.createElement('p');
  name.className = 'file-name';
  name.textContent = file.name;
  name.title = file.name;

  const seek = document.createElement('div');
  seek.className = 'seek';
  seek.dataset.action = 'seek';
  seek.setAttribute('role', 'slider');
  seek.setAttribute('aria-label', `播放进度 ${file.name}`);
  const fill = document.createElement('span');
  fill.className = 'seek-fill';
  seek.append(fill);

  body.append(name, seek);

  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = [fmtDuration(file.duration), fmtSize(file.size)].filter(Boolean).join(' · ');

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'icon-btn';
  reveal.dataset.action = 'reveal';
  reveal.setAttribute('aria-label', `在 Finder 中显示 ${file.name}`);
  reveal.append(icon('i-folder'));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn del';
  del.dataset.action = 'delete';
  del.setAttribute('aria-label', `删除 ${file.name}`);
  del.append(icon('i-trash'));

  actions.append(reveal, del);
  row.append(play, body, meta, actions);
  return row;
}

function renderFiles() {
  const q = state.filter.trim().toLowerCase();
  const list = q ? state.files.filter((f) => f.name.toLowerCase().includes(q)) : state.files;

  els.fileTally.textContent = q ? `${list.length} / ${state.files.length}` : `${state.files.length} 个`;

  els.files.textContent = '';
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (state.files.length === 0) {
      const lead = document.createElement('p');
      lead.className = 'empty-lead';
      lead.textContent = '还没有导出文件';
      const p = document.createElement('p');
      p.textContent = '在左边粘贴链接，按「开始转换」。成品会保存到本地输出目录，命名格式为 UP主-标题.mp3。';
      empty.append(lead, p);
    } else {
      const p = document.createElement('p');
      p.textContent = '没有匹配的文件。';
      empty.append(p);
    }
    els.files.append(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const file of list) frag.append(fileRow(file));
  els.files.append(frag);
}

function paintRows() {
  for (const row of els.files.querySelectorAll('.file')) {
    const on = row.dataset.name === state.playing;
    row.classList.toggle('is-playing', on);
    const btn = row.querySelector('.play');
    if (btn) btn.replaceChildren(icon(on && !els.player.paused ? 'i-pause' : 'i-play'));
    if (!on) {
      const fill = row.querySelector('.seek-fill');
      if (fill) fill.style.width = '0%';
    }
  }
}

function findRow(name) {
  for (const row of els.files.querySelectorAll('.file')) {
    if (row.dataset.name === name) return row;
  }
  return null;
}

function togglePlay(name) {
  if (state.playing === name) {
    if (els.player.paused) els.player.play().catch(() => {});
    else els.player.pause();
    return;
  }
  state.playing = name;
  state.playingRow = findRow(name);
  els.player.src = `/api/audio?name=${encodeURIComponent(name)}`;
  els.player.play().catch(() => toast('无法播放该文件'));
  paintRows();
}

async function revealFile(name) {
  try {
    await fetch('/api/files/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch {
    toast('无法打开 Finder');
  }
}

async function removeFile(name) {
  if (!window.confirm(`删除「${name}」？此操作不可撤销。`)) return;
  try {
    const res = await fetch('/api/files?name=' + encodeURIComponent(name), { method: 'DELETE' });
    if (!res.ok) throw new Error();
    if (state.playing === name) {
      els.player.pause();
      els.player.removeAttribute('src');
      els.player.load();
      state.playing = null;
      state.playingRow = null;
    }
    toast('已删除');
    refreshFiles();
  } catch {
    toast('删除失败');
  }
}

/* ------------------------------------------------------------ bind */

function updateTally() {
  const { urls, invalid } = parseLinks(els.links.value);
  const parts = [`${urls.length} 条`];
  if (invalid) parts.push(`${invalid} 条无效`);
  els.tally.textContent = parts.join(' · ');
}

function bind() {
  els.links.addEventListener('input', updateTally);
  els.links.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });

  els.start.addEventListener('click', submit);

  els.filter.addEventListener('input', () => {
    state.filter = els.filter.value;
    renderFiles();
  });

  els.settingsToggle.addEventListener('click', () => {
    const open = els.settings.hidden;
    els.settings.hidden = !open;
    els.settingsToggle.setAttribute('aria-expanded', String(open));
  });

  els.saveSettings.addEventListener('click', saveConfig);

  els.openFolder.addEventListener('click', async () => {
    try {
      await fetch('/api/folder', { method: 'POST' });
    } catch {
      toast('无法打开目录');
    }
  });

  els.files.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-action]');
    if (!target) return;
    const row = target.closest('.file');
    if (!row) return;
    const name = row.dataset.name;
    const action = target.dataset.action;

    if (action === 'play') togglePlay(name);
    else if (action === 'reveal') revealFile(name);
    else if (action === 'delete') removeFile(name);
    else if (action === 'seek') {
      if (state.playing !== name) {
        togglePlay(name);
        return;
      }
      const rect = target.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      if (Number.isFinite(els.player.duration) && els.player.duration > 0) {
        els.player.currentTime = ratio * els.player.duration;
      }
    }
  });

  els.player.addEventListener('play', paintRows);
  els.player.addEventListener('pause', paintRows);
  els.player.addEventListener('ended', paintRows);
  els.player.addEventListener('timeupdate', () => {
    if (!state.playing || !state.playingRow) return;
    const d = els.player.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const fill = state.playingRow.querySelector('.seek-fill');
    if (fill) fill.style.width = `${(els.player.currentTime / d) * 100}%`;
  });
}

/* ------------------------------------------------------------ boot */

async function init() {
  bind();
  updateTally();
  await loadConfig();
  await Promise.all([refreshFiles(), loadJobs()]);
}

init();
