const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const webpush = require('web-push');
const { createStore } = require('./store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const MAX_TASKS_PER_USER = 500;
const MAX_SUBS_PER_USER = 10;
const RATE_LIMIT_PER_MIN = 240;
const CHECK_EVERY_MS = 30_000;
const MAX_REMIND_MIN = 7 * 24 * 60;

// Minutos de antelación válidos: entero entre 0 y 7 días.
const validRemind = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_REMIND_MIN;

function whenText(min) {
  if (min <= 0) return 'ahora';
  if (min % 1440 === 0) return `en ${min / 1440} ${min === 1440 ? 'día' : 'días'}`;
  if (min % 60 === 0) return `en ${min / 60} ${min === 60 ? 'hora' : 'horas'}`;
  return `en ${min} minutos`;
}

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

  app.set('trust proxy', 1); // detrás del proxy del hosting

  // Límite sencillo de peticiones por IP (en memoria).
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  const rateLimit = (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    n > RATE_LIMIT_PER_MIN ? res.status(429).json({ error: 'too many requests' }) : next();
  };

  const api = express.Router();
  api.use(rateLimit);

  // Endpoint para el Cron del hosting: despierta la app y envía los avisos pendientes.
  api.get('/cron', async (req, res) => {
    if (!CRON_SECRET || !safeEq(String(req.query.key || ''), CRON_SECRET)) return res.status(401).json({ error: 'unauthorized' });
    res.json({ notified: await checkDue() });
  });

  api.use((req, res, next) => {
    if (!APP_PASSWORD) return next();
    if (safeEq(req.get('x-app-password') || '', APP_PASSWORD)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  // Cada navegador envía un token secreto aleatorio; se guarda solo su hash.
  api.use((req, res, next) => {
    if (req.path === '/config') return next();
    const token = req.get('x-user-token') || '';
    if (!/^[a-f0-9]{32,128}$/.test(token)) return res.status(400).json({ error: 'missing user token' });
    req.userId = crypto.createHash('sha256').update(token).digest('hex');
    next();
  });

  api.get('/config', (req, res) => res.json({ vapidPublicKey: vapid.publicKey, authRequired: !!APP_PASSWORD }));

  api.get('/tasks', (req, res) => res.json(store.listTasks(req.userId).map(({ userId, ...t }) => t)));

  api.post('/tasks', (req, res) => {
    const { title, notes, due, remindBefore = 0 } = req.body || {};
    if (!validRemind(remindBefore)) return res.status(400).json({ error: 'invalid remindBefore' });
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
    if (store.countTasks(req.userId) >= MAX_TASKS_PER_USER) return res.status(409).json({ error: 'task limit reached' });
    if (due != null && Number.isNaN(Date.parse(due))) return res.status(400).json({ error: 'invalid due' });
    const { userId: _u, ...created } = store.addTask(req.userId, {
        title: title.trim().slice(0, 200),
        notes: typeof notes === 'string' ? notes.slice(0, 2000) : '',
        due: due ? new Date(due).toISOString() : null,
        remindBefore,
      });
    res.status(201).json(created);
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
    if ('remindBefore' in b) {
      if (!validRemind(b.remindBefore)) return res.status(400).json({ error: 'invalid remindBefore' });
      patch.remindBefore = b.remindBefore;
    }
    if ('due' in b) {
      if (b.due && Number.isNaN(Date.parse(b.due))) return res.status(400).json({ error: 'invalid due' });
      patch.due = b.due ? new Date(b.due).toISOString() : null;
    }
    const task = store.updateTask(req.userId, req.params.id, patch);
    if (!task) return res.status(404).json({ error: 'not found' });
    const { userId: _u, ...out } = task;
    res.json(out);
  });

  api.delete('/tasks/:id', (req, res) =>
    store.deleteTask(req.userId, req.params.id) ? res.status(204).end() : res.status(404).json({ error: 'not found' })
  );

  api.post('/subscribe', (req, res) => {
    const s = req.body;
    if (!s || typeof s.endpoint !== 'string' || !s.keys || !s.keys.p256dh || !s.keys.auth) {
      return res.status(400).json({ error: 'invalid subscription' });
    }
    if (store.countSubscriptions(req.userId) >= MAX_SUBS_PER_USER) return res.status(409).json({ error: 'subscription limit reached' });
    store.addSubscription(req.userId, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    res.status(201).json({ ok: true });
  });

  api.post('/unsubscribe', (req, res) => {
    if (req.body && req.body.endpoint) store.removeSubscription(req.userId, req.body.endpoint);
    res.json({ ok: true });
  });

  api.post('/test-push', async (req, res) => {
    const sent = await broadcast(req.userId, { title: 'Notificación de prueba', body: '¡Las notificaciones funcionan!', url: '/' });
    res.json({ sent });
  });

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Envía un push a todas las suscripciones; elimina las caducadas (404/410).
  async function broadcast(userId, payload) {
    const body = JSON.stringify(payload);
    let sent = 0;
    await Promise.all(
      store.listSubscriptions(userId).map(async (sub) => {
        try {
          await sender.sendNotification(sub, body);
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) store.dropEndpoint(sub.endpoint);
          else console.error('push error', err.statusCode || err.message);
        }
      })
    );
    return sent;
  }

  // Avisa una sola vez por tarea, cuando llega (fecha - antelación elegida).
  async function checkDue(now = Date.now()) {
    const due = store
      .allTasks()
      .filter((t) => !t.done && !t.notified && t.due && Date.parse(t.due) - (t.remindBefore || 0) * 60000 <= now);
    for (const t of due) {
      store.markNotified(t.id);
      const min = t.remindBefore || 0;
      await broadcast(t.userId, {
        title: min > 0 ? `Tarea ${whenText(min)}` : 'Tarea pendiente',
        body: t.title,
        url: '/',
        tag: t.id,
      });
    }
    return due.length;
  }

  return { app, broadcast, checkDue };
}

// Arranca el servidor. Lo usan `npm start` y app.js (punto de entrada del hosting).
function start() {
  const store = createStore(DATA_DIR);
  const vapid = loadVapid();
  const { app, checkDue } = createApp({ store, vapid });
  setInterval(() => checkDue().catch((e) => console.error(e)), CHECK_EVERY_MS).unref();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`App de tareas en http://localhost:${port}`));
}

if (require.main === module) start();

module.exports = { createApp, loadVapid, start };
