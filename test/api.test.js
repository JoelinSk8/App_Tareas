const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const webpush = require('web-push');
const { createApp } = require('../server/index');
const { createStore } = require('../server/store');

function setup() {
  const sent = [];
  const sender = {
    setVapidDetails() {},
    async sendNotification(sub, body) {
      if (sub.endpoint.includes('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      sent.push({ sub, body: JSON.parse(body) });
    },
  };
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tareas-')));
  const ctx = createApp({ store, vapid: webpush.generateVAPIDKeys(), sender });
  return new Promise((resolve) => {
    const server = ctx.app.listen(0, () => {
      const base = `http://localhost:${server.address().port}/api`;
      const call = async (method, url, body) => {
        const r = await fetch(base + url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, body: r.status === 204 ? null : await r.json() };
      };
      resolve({ call, sent, store, ctx, close: () => server.close() });
    });
  });
}

const sub = (name) => ({ endpoint: 'https://push.example/' + name, keys: { p256dh: 'p', auth: 'a' } });

test('CRUD de tareas y validación', async () => {
  const t = await setup();
  assert.strictEqual((await t.call('POST', '/tasks', { title: '  ' })).status, 400);
  assert.strictEqual((await t.call('POST', '/tasks', { title: 'x', due: 'nope' })).status, 400);
  const created = (await t.call('POST', '/tasks', { title: 'Comprar pan' })).body;
  assert.strictEqual(created.done, false);
  const upd = await t.call('PATCH', '/tasks/' + created.id, { done: true });
  assert.strictEqual(upd.body.done, true);
  assert.strictEqual((await t.call('GET', '/tasks')).body.length, 1);
  assert.strictEqual((await t.call('DELETE', '/tasks/' + created.id)).status, 204);
  assert.strictEqual((await t.call('DELETE', '/tasks/' + created.id)).status, 404);
  t.close();
});

test('suscripción inválida se rechaza', async () => {
  const t = await setup();
  assert.strictEqual((await t.call('POST', '/subscribe', { endpoint: 'x' })).status, 400);
  t.close();
});

test('notifica una sola vez las tareas vencidas y no las hechas', async () => {
  const t = await setup();
  await t.call('POST', '/subscribe', sub('a'));
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3600e3).toISOString();
  await t.call('POST', '/tasks', { title: 'vencida', due: past });
  await t.call('POST', '/tasks', { title: 'futura', due: future });
  const done = (await t.call('POST', '/tasks', { title: 'hecha', due: past })).body;
  await t.call('PATCH', '/tasks/' + done.id, { done: true });

  assert.strictEqual(await t.ctx.checkDue(), 1);
  assert.deepStrictEqual(t.sent.map((s) => s.body.body), ['vencida']);
  assert.strictEqual(await t.ctx.checkDue(), 0); // no repite
  t.close();
});

test('elimina suscripciones caducadas (410)', async () => {
  const t = await setup();
  await t.call('POST', '/subscribe', sub('gone'));
  await t.call('POST', '/subscribe', sub('ok'));
  const res = await t.call('POST', '/test-push');
  assert.strictEqual(res.body.sent, 1);
  assert.deepStrictEqual(t.store.listSubscriptions().map((s) => s.endpoint), ['https://push.example/ok']);
  t.close();
});

test('avisa con la antelación elegida (10 min antes)', async () => {
  const t = await setup();
  await t.call('POST', '/subscribe', sub('a'));
  const due = new Date(Date.now() + 8 * 60000).toISOString(); // vence en 8 min
  const early = (await t.call('POST', '/tasks', { title: '10 antes', due, remindBefore: 10 })).body;
  await t.call('POST', '/tasks', { title: '5 antes', due, remindBefore: 5 });
  await t.call('POST', '/tasks', { title: 'a la hora', due });

  // Hoy faltan 8 min: solo toca la de 10 min antes.
  assert.strictEqual(await t.ctx.checkDue(), 1);
  assert.strictEqual(t.sent[0].body.body, '10 antes');
  assert.strictEqual(t.sent[0].body.title, 'Tarea en 10 minutos');

  // 4 min antes del vencimiento: toca la de 5 min.
  assert.strictEqual(await t.ctx.checkDue(Date.parse(due) - 4 * 60000), 1);
  assert.strictEqual(t.sent[1].body.body, '5 antes');

  // Al vencer: la de "a la hora".
  assert.strictEqual(await t.ctx.checkDue(Date.parse(due) + 1000), 1);
  assert.strictEqual(t.sent[2].body.title, 'Tarea pendiente');

  // Cambiar la antelación reprograma el aviso.
  await t.call('PATCH', '/tasks/' + early.id, { remindBefore: 30 });
  assert.strictEqual((await t.call('GET', '/tasks')).body.find((x) => x.id === early.id).notified, false);
  t.close();
});

test('remindBefore inválido se rechaza', async () => {
  const t = await setup();
  for (const v of [-1, 1.5, 'x', 99999]) {
    assert.strictEqual((await t.call('POST', '/tasks', { title: 'x', remindBefore: v })).status, 400);
  }
  const ok = (await t.call('POST', '/tasks', { title: 'x' })).body;
  assert.strictEqual(ok.remindBefore, 0);
  assert.strictEqual((await t.call('PATCH', '/tasks/' + ok.id, { remindBefore: -5 })).status, 400);
  t.close();
});
