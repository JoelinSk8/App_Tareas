const $ = (id) => document.getElementById(id);
let tasks = [];
let filter = 'pending';

// ---------- API ----------
function authHeader() {
  const p = localStorage.getItem('appPassword');
  return p ? { 'x-app-password': p } : {};
}

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const p = prompt('Contraseña de la app:');
    if (p == null) throw new Error('unauthorized');
    localStorage.setItem('appPassword', p);
    return api(method, url, body);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---------- Tareas ----------
function fmt(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function render() {
  const list = $('list');
  list.textContent = '';
  const shown = tasks
    .filter((t) => filter === 'all' || (filter === 'done') === t.done)
    .sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
  $('empty').hidden = shown.length > 0;
  for (const t of shown) {
    const li = document.createElement('li');
    if (t.done) li.className = 'done';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.onchange = () => update(t.id, { done: cb.checked });

    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 't';
    title.textContent = t.title; // textContent: evita XSS
    body.append(title);
    if (t.due) {
      const d = document.createElement('div');
      d.className = 'd' + (!t.done && Date.parse(t.due) < Date.now() ? ' overdue' : '');
      d.textContent = '⏰ ' + fmt(t.due);
      body.append(d);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Eliminar';
    del.onclick = async () => { await api('DELETE', '/tasks/' + t.id); load(); };

    li.append(cb, body, del);
    list.append(li);
  }
}

async function load() { tasks = await api('GET', '/tasks'); render(); }
async function update(id, patch) { await api('PATCH', '/tasks/' + id, patch); load(); }

$('task-form').onsubmit = async (e) => {
  e.preventDefault();
  const due = $('due').value ? new Date($('due').value).toISOString() : null;
  await api('POST', '/tasks', { title: $('title').value, due });
  e.target.reset();
  load();
};

$('filters').onclick = (e) => {
  if (!e.target.dataset.f) return;
  filter = e.target.dataset.f;
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('active', b === e.target));
  render();
};

// ---------- Notificaciones push ----------
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function setMsg(text) { $('notif-msg').textContent = text; $('notif-msg').hidden = !text; }

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshBtn() {
  const btn = $('notif-btn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.hidden = true;
    const ios = /iphone|ipad/i.test(navigator.userAgent);
    setMsg(ios
      ? 'En iPhone/iPad: pulsa Compartir → "Añadir a pantalla de inicio" y abre la app desde ahí para activar las notificaciones.'
      : 'Este navegador no soporta notificaciones push.');
    return;
  }
  if (Notification.permission === 'denied') {
    btn.disabled = true;
    setMsg('Las notificaciones están bloqueadas en los ajustes del navegador.');
    return;
  }
  btn.textContent = (await currentSub()) ? '🔕 Desactivar notificaciones' : '🔔 Activar notificaciones';
}

$('notif-btn').onclick = async () => {
  try {
    const existing = await currentSub();
    if (existing) {
      await api('POST', '/unsubscribe', { endpoint: existing.endpoint });
      await existing.unsubscribe();
    } else {
      if ((await Notification.requestPermission()) !== 'granted') return refreshBtn();
      const { vapidPublicKey } = await api('GET', '/config');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      await api('POST', '/subscribe', sub.toJSON());
      await api('POST', '/test-push');
    }
  } catch (err) {
    setMsg('No se pudo cambiar la suscripción: ' + err.message);
  }
  refreshBtn();
};

// ---------- Inicio ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(refreshBtn);
else refreshBtn();
load();
setInterval(() => { if (!document.hidden) load(); }, 30000);
