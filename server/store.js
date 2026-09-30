const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Almacenamiento simple en un archivo JSON (escritura atómica).
function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let db = { tasks: [], subscriptions: [] };
  if (fs.existsSync(file)) db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    listTasks: () => db.tasks,
    addTask({ title, notes = '', due = null, remindBefore = 0 }) {
      const task = {
        id: crypto.randomUUID(),
        title,
        notes,
        due,
        remindBefore,
        done: false,
        notified: false,
        createdAt: new Date().toISOString(),
      };
      db.tasks.push(task);
      save();
      return task;
    },
    updateTask(id, patch) {
      const task = db.tasks.find((t) => t.id === id);
      if (!task) return null;
      for (const k of ['title', 'notes', 'due', 'remindBefore', 'done']) if (k in patch) task[k] = patch[k];
      // Si cambia la fecha o la antelación, se vuelve a notificar.
      if ('due' in patch || 'remindBefore' in patch) task.notified = false;
      save();
      return task;
    },
    markNotified(id) {
      const task = db.tasks.find((t) => t.id === id);
      if (task) {
        task.notified = true;
        save();
      }
    },
    deleteTask(id) {
      const n = db.tasks.length;
      db.tasks = db.tasks.filter((t) => t.id !== id);
      save();
      return db.tasks.length < n;
    },
    listSubscriptions: () => db.subscriptions,
    addSubscription(sub) {
      db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
      db.subscriptions.push(sub);
      save();
    },
    removeSubscription(endpoint) {
      db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== endpoint);
      save();
    },
  };
}

module.exports = { createStore };
