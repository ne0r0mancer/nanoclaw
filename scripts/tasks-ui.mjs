// Tiny web UI for NanoClaw scheduled tasks: list, pause, resume, remove.
// Runs as its own process next to NanoClaw and edits store/messages.db directly;
// the scheduler re-reads the table on every poll, so changes apply on its next tick.
//
//   node scripts/tasks-ui.mjs            (HOST/PORT/TZ from env, default 127.0.0.1:8100)
//
// No auth: bind it to localhost or a private interface (e.g. your Tailscale IP).
// Run as a launchd service from the template in launchd/:
//
//   sed -e "s#{{NODE_PATH}}#$(which node)#" -e "s#{{PROJECT_ROOT}}#$PWD#g" \
//       -e "s#{{TASKS_UI_HOST}}#127.0.0.1#" launchd/com.nanoclaw.tasks-ui.plist \
//       > ~/Library/LaunchAgents/com.nanoclaw.tasks-ui.plist
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.tasks-ui.plist

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8100);
const TZ = process.env.TZ || 'Europe/Paris';

const db = new Database(path.join(ROOT, 'store', 'messages.db'));
db.pragma('busy_timeout = 5000');

const listTasks = db.prepare(`
  SELECT t.id, t.group_folder, t.prompt, t.script, t.schedule_type, t.schedule_value,
         t.status, t.next_run, t.last_run, t.last_result, t.created_at, t.context_mode,
         (SELECT status FROM task_run_logs l WHERE l.task_id = t.id ORDER BY run_at DESC LIMIT 1) AS last_status,
         (SELECT COUNT(*) FROM task_run_logs l WHERE l.task_id = t.id) AS runs
  FROM scheduled_tasks t
  ORDER BY t.status = 'active' DESC, t.next_run
`);
const getTask = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?');
const setStatus = db.prepare('UPDATE scheduled_tasks SET status = ?, next_run = ? WHERE id = ?');
const removeTask = db.transaction((id) => {
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes;
});

// When resuming, a next_run left in the past would fire the task at once.
// Move recurring tasks to their next real slot instead (one-off tasks keep theirs).
function nextRunOnResume(task) {
  const now = Date.now();
  if (task.next_run && Date.parse(task.next_run) > now) return task.next_run;
  if (task.schedule_type === 'cron') {
    return CronExpressionParser.parse(task.schedule_value, { tz: TZ }).next().toISOString();
  }
  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (ms > 0) return new Date(now + ms).toISOString();
  }
  return task.next_run;
}

function act(id, action) {
  const task = getTask.get(id);
  if (!task) return [404, { error: 'task not found' }];
  if (action === 'pause') {
    if (task.status !== 'active') return [409, { error: `task is ${task.status}` }];
    setStatus.run('paused', task.next_run, id);
  } else if (action === 'resume') {
    if (task.status !== 'paused') return [409, { error: `task is ${task.status}` }];
    setStatus.run('active', nextRunOnResume(task), id);
  } else if (action === 'delete') {
    removeTask(id);
  } else {
    return [400, { error: 'unknown action' }];
  }
  console.log(new Date().toISOString(), action, id);
  return [200, { ok: true }];
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/tasks') return send(res, 200, { tz: TZ, tasks: listTasks.all() });
      const m = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|delete)$/);
      if (req.method === 'POST' && m) {
        // Same-origin only: refuse cross-site form posts.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'bad origin' });
        const [code, body] = act(decodeURIComponent(m[1]), m[2]);
        return send(res, code, body);
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: String(err.message || err) });
    }
  })
  .listen(PORT, HOST, () => console.log(`NanoClaw tasks UI on http://${HOST}:${PORT} (TZ ${TZ})`));

const PAGE = /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw tasks</title>
<style>
  :root {
    --bg: #f6f5f2; --card: #fff; --ink: #1c1c1a; --muted: #6b6a65; --line: #e4e2dc;
    --active: #1f7a4d; --paused: #a26a00; --done: #6b6a65; --error: #b3261e; --btn: #f0eee9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161615; --card: #1f1f1d; --ink: #ecebe6; --muted: #9b9a94; --line: #33322f;
      --active: #5fc58f; --paused: #e0a63a; --done: #9b9a94; --error: #f2857c; --btn: #2a2a27;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 28px 16px 60px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .task { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
  .top { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
  .title { font-weight: 600; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 13px; margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .meta b { color: var(--ink); font-weight: 500; }
  .pill { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
  .s-active { color: var(--active); } .s-paused { color: var(--paused); }
  .s-completed { color: var(--done); } .s-error { color: var(--error); }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line);
           background: var(--btn); color: var(--ink); cursor: pointer; }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: .5; cursor: default; }
  button.danger { color: var(--error); }
  button.danger.armed { background: var(--error); color: #fff; border-color: var(--error); }
  details { margin-top: 10px; font-size: 13px; }
  summary { cursor: pointer; color: var(--muted); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line);
        border-radius: 8px; padding: 10px; margin: 8px 0 0; max-height: 340px; overflow: auto; font-size: 12.5px; }
  .empty, .err { color: var(--muted); padding: 30px 0; text-align: center; }
  .err { color: var(--error); }
  #toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--ink); color: var(--bg);
           padding: 8px 14px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<main>
  <header>
    <h1>NanoClaw · tâches</h1>
    <span class="sub" id="sub"></span>
  </header>
  <div id="list"><div class="empty">Chargement…</div></div>
</main>
<div id="toast"></div>
<script>
const list = document.getElementById('list');
let tz = 'Europe/Paris';

const fmt = (iso) => iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: tz, weekday: 'short', day: 'numeric',
  month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const STATUS = { active: 'active', paused: 'en pause', completed: 'terminée', error: 'erreur' };

function scheduleText(t) {
  if (t.schedule_type === 'cron') return 'cron ' + t.schedule_value;
  if (t.schedule_type === 'interval') {
    const m = Math.round(parseInt(t.schedule_value, 10) / 60000);
    return m >= 60 && m % 60 === 0 ? 'toutes les ' + m / 60 + ' h' : 'toutes les ' + m + ' min';
  }
  return 'une fois';
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200);
}

async function act(id, action, btn) {
  btn.disabled = true;
  try {
    const r = await fetch('/api/tasks/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    toast({ pause: 'Tâche mise en pause', resume: 'Tâche reprise', delete: 'Tâche supprimée' }[action]);
  } catch (e) {
    toast('Échec : ' + e.message);
  }
  load();
}

function card(t) {
  const firstLine = t.prompt.split('\\n').find((l) => l.trim()) || t.id;
  const title = firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
  const meta = el('div', { className: 'meta' },
    el('span', {}, el('b', { textContent: scheduleText(t) })),
    el('span', { textContent: 'groupe ' + t.group_folder }),
    t.status === 'active' ? el('span', {}, 'prochaine : ', el('b', { textContent: fmt(t.next_run) })) : null,
    el('span', { textContent: 'dernière : ' + fmt(t.last_run) + (t.last_status ? ' (' + t.last_status + ')' : '') }),
    el('span', { textContent: t.runs + ' exécution' + (t.runs > 1 ? 's' : '') }),
  );

  const actions = el('div', { className: 'actions' });
  if (t.status === 'active') {
    const b = el('button', { textContent: 'Mettre en pause' });
    b.onclick = () => act(t.id, 'pause', b);
    actions.append(b);
  }
  if (t.status === 'paused') {
    const b = el('button', { textContent: 'Reprendre' });
    b.onclick = () => act(t.id, 'resume', b);
    actions.append(b);
  }
  const del = el('button', { className: 'danger', textContent: 'Supprimer' });
  del.onclick = () => {
    if (!del.classList.contains('armed')) {
      del.classList.add('armed'); del.textContent = 'Confirmer la suppression';
      setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Supprimer'; }, 4000);
      return;
    }
    act(t.id, 'delete', del);
  };
  actions.append(del);

  const details = el('details', {},
    el('summary', { textContent: 'Prompt et dernier résultat' }),
    el('pre', { textContent: t.prompt }),
    t.script ? el('pre', { textContent: 'script:\\n' + t.script }) : null,
    t.last_result ? el('pre', { textContent: t.last_result }) : null,
    el('div', { className: 'sub', style: 'margin-top:6px', textContent: t.id + ' · contexte ' + (t.context_mode || 'isolated') }),
  );

  return el('div', { className: 'task' },
    el('div', { className: 'top' },
      el('div', {}, el('div', { className: 'title', textContent: title }), meta),
      el('span', { className: 'pill s-' + t.status, textContent: STATUS[t.status] || t.status }),
    ),
    actions, details);
}

async function load() {
  try {
    const r = await fetch('/api/tasks');
    const data = await r.json();
    tz = data.tz;
    const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.closest('.task')?.dataset.id));
    list.replaceChildren(...(data.tasks.length ? data.tasks.map((t) => {
      const c = card(t); c.dataset.id = t.id;
      if (open.has(t.id)) c.querySelector('details').open = true;
      return c;
    }) : [el('div', { className: 'empty', textContent: 'Aucune tâche programmée.' })]));
    const active = data.tasks.filter((t) => t.status === 'active').length;
    document.getElementById('sub').textContent = active + ' active' + (active > 1 ? 's' : '') + ' / ' + data.tasks.length + ' · ' + tz;
  } catch (e) {
    list.replaceChildren(el('div', { className: 'err', textContent: 'Impossible de charger : ' + e.message }));
  }
}

load();
setInterval(() => { if (!document.hidden && !list.querySelector('.armed')) load(); }, 30000);
</script>
</body>
</html>`;
