const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const webpush = require('web-push');
const { createStore } = require('./store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const CHECK_EVERY_MS = 30_000;

// Claves VAPID: desde variables de entorno o generadas y guardadas en data/.
function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, 'vapid.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(f, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

function createApp({ store, vapid, sender = webpush }) {
  sender.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const safeEq = (a, b) => {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  const api = express.Router();
  api.use((req, res, next) => {
    if (!APP_PASSWORD) return next();
    if (safeEq(req.get('x-app-password') || '', APP_PASSWORD)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  api.get('/config', (req, res) => res.json({ vapidPublicKey: vapid.publicKey, authRequired: !!APP_PASSWORD }));

  api.get('/tasks', (req, res) => res.json(store.listTasks()));

  api.post('/tasks', (req, res) => {
    const { title, notes, due } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
    if (due != null && Number.isNaN(Date.parse(due))) return res.status(400).json({ error: 'invalid due' });
    res.status(201).json(
      store.addTask({
        title: title.trim().slice(0, 200),
        notes: typeof notes === 'string' ? notes.slice(0, 2000) : '',
        due: due ? new Date(due).toISOString() : null,
      })
    );
  });

  api.patch('/tasks/:id', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if ('title' in b) {
      if (typeof b.title !== 'string' || !b.title.trim()) return res.status(400).json({ error: 'invalid title' });
      patch.title = b.title.trim().slice(0, 200);
    }
    if ('notes' in b) patch.notes = typeof b.notes === 'string' ? b.notes.slice(0, 2000) : '';
    if ('done' in b) patch.done = !!b.done;
    if ('due' in b) {
      if (b.due && Number.isNaN(Date.parse(b.due))) return res.status(400).json({ error: 'invalid due' });
      patch.due = b.due ? new Date(b.due).toISOString() : null;
    }
    const task = store.updateTask(req.params.id, patch);
    task ? res.json(task) : res.status(404).json({ error: 'not found' });
  });

  api.delete('/tasks/:id', (req, res) =>
    store.deleteTask(req.params.id) ? res.status(204).end() : res.status(404).json({ error: 'not found' })
  );

  api.post('/subscribe', (req, res) => {
    const s = req.body;
    if (!s || typeof s.endpoint !== 'string' || !s.keys || !s.keys.p256dh || !s.keys.auth) {
      return res.status(400).json({ error: 'invalid subscription' });
    }
    store.addSubscription({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    res.status(201).json({ ok: true });
  });

  api.post('/unsubscribe', (req, res) => {
    if (req.body && req.body.endpoint) store.removeSubscription(req.body.endpoint);
    res.json({ ok: true });
  });

  api.post('/test-push', async (req, res) => {
    const sent = await broadcast({ title: 'Notificación de prueba', body: '¡Las notificaciones funcionan!', url: '/' });
    res.json({ sent });
  });

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Envía un push a todas las suscripciones; elimina las caducadas (404/410).
  async function broadcast(payload) {
    const body = JSON.stringify(payload);
    let sent = 0;
    await Promise.all(
      store.listSubscriptions().map(async (sub) => {
        try {
          await sender.sendNotification(sub, body);
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) store.removeSubscription(sub.endpoint);
          else console.error('push error', err.statusCode || err.message);
        }
      })
    );
    return sent;
  }

  // Revisa tareas vencidas y avisa una sola vez por tarea.
  async function checkDue(now = Date.now()) {
    const due = store.listTasks().filter((t) => !t.done && !t.notified && t.due && Date.parse(t.due) <= now);
    for (const t of due) {
      store.markNotified(t.id);
      await broadcast({ title: 'Tarea pendiente', body: t.title, url: '/', tag: t.id });
    }
    return due.length;
  }

  return { app, broadcast, checkDue };
}

if (require.main === module) {
  const store = createStore(DATA_DIR);
  const vapid = loadVapid();
  const { app, checkDue } = createApp({ store, vapid });
  setInterval(() => checkDue().catch((e) => console.error(e)), CHECK_EVERY_MS).unref();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`App de tareas en http://localhost:${port}`));
}

module.exports = { createApp, loadVapid };
