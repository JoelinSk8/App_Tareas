# App de Tareas

App de tareas (PWA) que funciona en **web, escritorio y celular**, con recordatorios por **notificaciones push** (Web Push / VAPID). Llegan aunque la app esté cerrada.

- **Backend:** Node + Express, almacenamiento en `data/db.json`, envío de push con `web-push`.
- **Frontend:** HTML/JS sin build, service worker, instalable (manifest).

## Uso

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Variables de entorno opcionales:

| Variable | Descripción |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `APP_PASSWORD` | Si se define, la API exige esta contraseña (la app la pide una vez). **Recomendado en producción.** |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves VAPID. Si faltan, se generan y guardan en `data/vapid.json` |
| `VAPID_SUBJECT` | `mailto:` de contacto para VAPID |
| `DATA_DIR` | Carpeta de datos |

## Requisito clave: HTTPS

Las notificaciones push solo funcionan en **HTTPS** (`localhost` está exento). Para que lleguen al celular hay que desplegar la app con un dominio HTTPS (Render, Fly.io, Railway, un VPS con Caddy/nginx…) o exponerla temporalmente con un túnel (`cloudflared tunnel --url http://localhost:3000`, ngrok…). Conserva la carpeta `data/` (o fija las claves VAPID por variables de entorno): si cambian las claves, hay que volver a activar las notificaciones en cada dispositivo.

## Instalar y activar notificaciones

- **Escritorio (Chrome/Edge):** abre la URL → icono de instalar en la barra de direcciones → la app queda como ventana independiente.
- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone/iPad (iOS 16.4+):** Safari → Compartir → *Añadir a pantalla de inicio*, abre la app desde el icono (requisito de Apple para push).
- En cada dispositivo pulsa **🔔 Activar notificaciones**; recibirás una de prueba.

## Cómo funciona

1. Al activar, el navegador crea una suscripción push que se guarda en el servidor.
2. Cada tarea tiene fecha/hora y una antelación elegible (a la hora, 5, 10, 15, 30 min, 1 hora o 1 día antes). Cada 30 s el servidor busca las tareas pendientes cuyo momento de aviso (fecha − antelación) ya llegó y envía un push una sola vez por tarea.
3. El service worker (`public/sw.js`) muestra la notificación; al pulsarla abre/enfoca la app.
4. Las suscripciones caducadas (404/410) se eliminan automáticamente.

## Limitaciones

Es una app de un solo usuario/equipo (todas las tareas se comparten entre los dispositivos suscritos). Para cuentas separadas habría que añadir usuarios.
