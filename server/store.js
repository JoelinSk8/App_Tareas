const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Almacenamiento simple en un archivo JSON (escritura atómica).
// Tareas y suscripciones pertenecen a un usuario (userId) para que nadie vea los datos de otro.
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

  const mine = (userId, id) => db.tasks.find((t) => t.id === id && t.userId === userId);

  return {
    listTasks: (userId) => db.tasks.filter((t) => t.userId === userId),
    countTasks: (userId) => db.tasks.filter((t) => t.userId === userId).length,
    allTasks: () => db.tasks, // solo para el planificador interno
    addTask(userId, { title, notes = '', due = null, remindBefore = 0 }) {
      const task = {
        id: crypto.randomUUID(),
        userId,
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
    updateTask(userId, id, patch) {
      const task = mine(userId, id);
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
    deleteTask(userId, id) {
      const n = db.tasks.length;
      db.tasks = db.tasks.filter((t) => !(t.id === id && t.userId === userId));
      save();
      return db.tasks.length < n;
    },
    listSubscriptions: (userId) => db.subscriptions.filter((s) => s.userId === userId),
    countSubscriptions: (userId) => db.subscriptions.filter((s) => s.userId === userId).length,
    addSubscription(userId, sub) {
      // Un mismo endpoint pertenece a un solo usuario (el último que lo registra).
      db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
      db.subscriptions.push({ ...sub, userId });
      save();
    },
    removeSubscription(userId, endpoint) {
      db.subscriptions = db.subscriptions.filter((s) => !(s.endpoint === endpoint && s.userId === userId));
      save();
    },
    // Borrado por caducidad del servicio push (404/410), sin importar el usuario.
    dropEndpoint(endpoint) {
      db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== endpoint);
      save();
    },
  };
}

module.exports = { createStore };
