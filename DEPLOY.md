# Despliegue en cPanel (MochaHost u otro con "Setup Node.js App")

## 0. Genera las claves de notificación (una sola vez, en tu PC)
```bash
npx web-push generate-vapid-keys
```
Guarda la **Public Key** y la **Private Key**. Si las pierdes o cambian, todos los usuarios tendrán que volver a activar las notificaciones.

Inventa también un texto largo y aleatorio para `CRON_SECRET`.

## 1. Dominio con HTTPS
En cPanel → *SSL/TLS Status*, asegúrate de que el dominio (o subdominio, p. ej. `tareas.tudominio.com`) tiene un certificado activo (AutoSSL). Sin HTTPS no funcionan las notificaciones.

## 2. Sube el código
1. Descarga el repositorio como ZIP (o haz `git clone` y comprime **sin** `node_modules` ni `data`).
2. En *File Manager*, sube y extrae el ZIP en una carpeta **fuera de `public_html`**, por ejemplo `/home/TU_USUARIO/app_tareas`.
3. Crea otra carpeta vacía para los datos: `/home/TU_USUARIO/app_tareas_data`.

## 3. Crea la aplicación Node.js
cPanel → *Setup Node.js App* → **Create Application**:

| Campo | Valor |
|---|---|
| Node.js version | 18 o superior (la más reciente disponible) |
| Application mode | Production |
| Application root | `app_tareas` |
| Application URL | tu dominio/subdominio |
| Application startup file | `app.js` |

En **Environment variables** añade:

| Variable | Valor |
|---|---|
| `VAPID_PUBLIC_KEY` | la Public Key del paso 0 |
| `VAPID_PRIVATE_KEY` | la Private Key del paso 0 |
| `VAPID_SUBJECT` | `mailto:tu-correo@ejemplo.com` |
| `CRON_SECRET` | el texto aleatorio del paso 0 |
| `DATA_DIR` | `/home/TU_USUARIO/app_tareas_data` |

**No definas `APP_PASSWORD`** si quieres que la use cualquiera (bloquearía a todos).

Pulsa **Run NPM Install** y después **Restart**. Abre tu dominio: debe cargar la app.

## 4. Cron (imprescindible para los avisos)
Algunos hostings compartidos duermen las apps Node cuando no hay visitas. Para que los avisos salgan a tiempo, cPanel → *Cron Jobs* → añade uno **cada minuto** (`* * * * *`):

```
curl -fsS "https://TU_DOMINIO/api/cron?key=TU_CRON_SECRET" > /dev/null
```
(Si `curl` no está disponible, usa `wget -qO- "https://..." > /dev/null`.)

Cada llamada despierta la app y envía los avisos pendientes. Es lo que garantiza que lleguen aunque nadie esté usando la app.

## 5. Comprueba
- `https://TU_DOMINIO/api/cron?key=TU_CRON_SECRET` debe responder `{"notified":0}`.
- Desde el celular abre el dominio, instala la app y pulsa 🔔 Activar notificaciones.
- Crea una tarea para dentro de unos minutos con aviso "5 min antes".

## Actualizar
Sube los archivos nuevos (sin pisar `DATA_DIR`), pulsa **Run NPM Install** si cambió `package.json` y **Restart**.

## Notas
- Cada navegador es un usuario anónimo distinto (token secreto en `localStorage`). Borrar los datos del navegador o desinstalar la app implica perder sus tareas. En iPhone, la app instalada en la pantalla de inicio es un usuario distinto al de Safari.
- Los datos se guardan en un archivo JSON: es adecuado para un uso pequeño o mediano. Con mucho tráfico habría que pasar a una base de datos.
- Si tu plan limita procesos o memoria, revisa los logs en *Setup Node.js App*.
