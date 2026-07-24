/**
 * The approval console.
 *
 * Single self-contained HTML page — no build step, no CDN. Reviewing image and
 * text posts is the one thing a terminal genuinely cannot do well, which is why
 * this exists at all; everything else stays in the CLI.
 */
export function renderApp(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MediaBot</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e8ee;
    --muted:#8b93a7; --accent:#4ade80; --danger:#f87171; --warn:#fbbf24;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#e3e6ec; --text:#1a1d24; --muted:#666e80; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex;
    align-items:center; gap:16px; flex-wrap:wrap; }
  h1 { font-size:17px; margin:0; font-weight:700; letter-spacing:.3px; }
  .stats { display:flex; gap:14px; flex-wrap:wrap; margin-left:auto; color:var(--muted); font-size:13px; }
  .stats b { color:var(--text); }
  main { padding:20px 24px; max-width:900px; margin:0 auto; }
  .tabs { display:flex; gap:6px; margin-bottom:18px; flex-wrap:wrap; }
  .tab { padding:6px 14px; border:1px solid var(--line); border-radius:999px;
    background:transparent; color:var(--muted); cursor:pointer; font-size:13px; }
  .tab.on { background:var(--panel); color:var(--text); border-color:var(--muted); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:16px; margin-bottom:14px; }
  .meta { display:flex; gap:10px; align-items:center; font-size:12px; color:var(--muted);
    margin-bottom:10px; flex-wrap:wrap; }
  .pill { border:1px solid var(--line); border-radius:999px; padding:2px 9px; }
  .title { font-weight:700; margin-bottom:6px; }
  textarea { width:100%; min-height:120px; background:var(--bg); color:var(--text);
    border:1px solid var(--line); border-radius:8px; padding:10px; font:inherit; resize:vertical; }
  .media { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .media img { max-height:110px; border-radius:8px; border:1px solid var(--line); }
  .row { display:flex; gap:8px; margin-top:12px; align-items:center; flex-wrap:wrap; }
  button { border:0; border-radius:8px; padding:8px 16px; font:inherit; cursor:pointer; font-weight:600; }
  .ok { background:var(--accent); color:#0b1a10; }
  .no { background:transparent; color:var(--danger); border:1px solid var(--danger); }
  input[type=datetime-local] { background:var(--bg); color:var(--text);
    border:1px solid var(--line); border-radius:8px; padding:7px; font:inherit; }
  .empty { color:var(--muted); text-align:center; padding:48px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td,th { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; }
  .s-published,.s-ok { color:var(--accent); }
  .s-failed,.s-dead,.s-error { color:var(--danger); }
  .s-queued,.s-running { color:var(--warn); }
  a { color:inherit; }
</style>
</head>
<body>
<header>
  <h1>MediaBot</h1>
  <div class="stats" id="stats"></div>
</header>
<main>
  <div class="tabs">
    <button class="tab on" data-view="queue">待审批</button>
    <button class="tab" data-view="posts">发布记录</button>
    <button class="tab" data-view="sources">情报</button>
    <button class="tab" data-view="runs">运行日志</button>
  </div>
  <div id="view"></div>
</main>

<script>
const $ = (s) => document.querySelector(s);
let view = 'queue';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when = (ms) => ms ? new Date(ms).toLocaleString() : '—';

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

async function refreshStats() {
  const s = await api('/api/status');
  $('#stats').innerHTML = [
    ['待审', s.pending], ['已发布', s.published], ['失败', s.failed],
    ['情报', s.sourceItems], ['新评论', s.comments],
  ].map(([k, v]) => \`<span>\${k} <b>\${v}</b></span>\`).join('');
}

async function render() {
  const el = $('#view');
  if (view === 'queue') {
    const { approvals } = await api('/api/approvals?state=pending');
    if (!approvals.length) { el.innerHTML = '<div class="empty">没有待审批的内容</div>'; return; }
    el.innerHTML = approvals.map(card).join('');
    return;
  }
  const cfg = {
    posts:   ['/api/posts',   'posts',  ['平台','状态','链接','时间','错误'],
              p => [p.platform, st(p.state), p.url ? \`<a href="\${esc(p.url)}" target="_blank">打开</a>\` : '—',
                    when(p.published_at || p.scheduled_for), esc(p.error || '')]],
    sources: ['/api/sources', 'items',  ['来源','标题','时间'],
              i => [i.provider_id, i.url ? \`<a href="\${esc(i.url)}" target="_blank">\${esc(i.title)}</a>\` : esc(i.title),
                    when(i.published_at || i.fetched_at)]],
    runs:    ['/api/runs',    'runs',   ['类型','状态','详情','时间'],
              r => [r.kind, st(r.state), esc(r.detail || ''), when(r.started_at)]],
  }[view];

  const [path, key, heads, row] = cfg;
  const rows = (await api(path))[key];
  if (!rows.length) { el.innerHTML = '<div class="empty">暂无记录</div>'; return; }
  el.innerHTML = '<div class="card"><table><tr>' + heads.map(h => \`<th>\${h}</th>\`).join('') +
    '</tr>' + rows.map(r => '<tr>' + row(r).map(c => \`<td>\${c}</td>\`).join('') + '</tr>').join('') +
    '</table></div>';
}

const st = (s) => \`<span class="s-\${esc(s)}">\${esc(s)}</span>\`;

function card(a) {
  const p = a.payload || {};
  const imgs = (p.media || []).filter(m => m.kind === 'image')
    .map(m => \`<img src="/media?path=\${encodeURIComponent(m.path)}" alt="">\`).join('');
  return \`
  <div class="card" data-id="\${esc(a.id)}">
    <div class="meta">
      <span class="pill">\${esc(p.platform || a.kind)}</span>
      <span>\${esc(a.id)}</span>
      <span>建于 \${when(a.createdAt)}</span>
    </div>
    \${p.title ? \`<div class="title">\${esc(p.title)}</div>\` : ''}
    <textarea class="body">\${esc(p.body || '')}</textarea>
    <div class="media">\${imgs}</div>
    <div class="row">
      <button class="ok" onclick="decide('\${esc(a.id)}','approve')">批准并发布</button>
      <input type="datetime-local" class="at">
      <button class="ok" onclick="decide('\${esc(a.id)}','approve',true)">定时发布</button>
      <button class="no" onclick="decide('\${esc(a.id)}','reject')">拒绝</button>
    </div>
    \${a.grantEntry ? \`<div class="meta">
      <button onclick="allow('\${esc(a.id)}','\${esc(a.grantEntry)}')">以后不用问我</button>
      <span>仅对 \${esc(a.grantEntry)}（\${esc(a.grantConsequence || '')}）生效，可随时撤销</span>
    </div>\` : ''}
  </div>\`;
}

async function allow(id, entry) {
  // Spelled out in full: this is the one control that decides on behalf of the
  // human next time, so the exact scope has to be visible before, not after.
  if (!confirm(\`以后自动批准「\${entry}」，不再询问。\\n只对这个确切目标生效，改配置或换目标后失效。\\n随时可撤销：mediabot revoke "\${entry}"\`)) return;
  try {
    await api(\`/api/approvals/\${id}/allow\`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    await Promise.all([render(), refreshStats()]);
  } catch (e) { alert(e.message); }
}

async function decide(id, action, scheduled) {
  const card = document.querySelector(\`[data-id="\${id}"]\`);
  const body = { };
  if (action === 'approve') {
    const original = card.querySelector('.body').defaultValue;
    const edited = card.querySelector('.body').value;
    // Only send a payload when the text actually changed, so an untouched item
    // keeps the exact snapshot it was queued with.
    if (edited !== original) body.payload = { ...JSON.parse(card.dataset.payload || '{}'), body: edited };
    const at = card.querySelector('.at').value;
    if (scheduled && at) { body.scheduledFor = new Date(at).getTime(); body.executeNow = false; }
  } else {
    body.reason = prompt('拒绝原因（可选）') || undefined;
  }
  try {
    await api(\`/api/approvals/\${id}/\${action}\`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await Promise.all([render(), refreshStats()]);
  } catch (e) { alert(e.message); }
}

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
  t.classList.add('on');
  view = t.dataset.view;
  render();
});

refreshStats(); render();
setInterval(() => { refreshStats(); if (view === 'queue') render(); }, 15000);
</script>
</body>
</html>`;
}
