# Tickomium Print Agent

Agente local que permite imprimir tickets ESC/POS desde el frontend en producción (Vercel → Railway → impresora local).

## Cómo funciona

```
Frontend (Vercel) → Backend (Railway) genera buffer ESC/POS → Frontend lo envía al agente local → Impresora
```

Si el agente no está corriendo, el frontend descarga el ticket en PDF automáticamente como fallback.

## Instalación

```bash
cd print-agent
npm install
```

## Configuración

Crea un archivo `.env` en `print-agent/`:

```env
PRINTER_NAME=Printer_POS_58_2
PRINT_AGENT_PORT=6441
FRONTEND_ORIGIN=https://app.tickomium.com para prod pero si tiene que ser una env
```

Para ver el nombre de tu impresora:
```bash
lpstat -a
```

## Uso

**Desarrollo:**
```bash
npm run dev
```

**Producción (compilado):**
```bash
npm run build
npm start
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del agente e impresora |
| GET | `/printers` | Lista impresoras disponibles (lpstat) |
| POST | `/print` | Recibe buffer ESC/POS crudo y lo manda a la impresora |

## Auto-inicio en macOS

Crea `~/Library/LaunchAgents/com.tickomium.print-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tickomium.print-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ruta/al/proyecto/print-agent/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRINTER_NAME</key>
    <string>Printer_POS_58_2</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Cargar el servicio:
```bash
launchctl load ~/Library/LaunchAgents/com.tickomium.print-agent.plist
```


# 🖨️ Print Agent con Electron

Aplicación de escritorio ligera que corre en segundo plano, inicia automáticamente con el sistema y permite imprimir tickets desde una app web mediante un endpoint local.

---

# 🚀 Objetivo

* Ejecutarse automáticamente al iniciar la computadora
* Correr en segundo plano (sin ventana visible)
* Mostrar icono en la barra (tray)
* Exponer un endpoint local (`localhost`)
* Recibir peticiones de impresión desde el frontend
* Imprimir directamente sin intervención del usuario

---

# 📦 Tecnologías

* Electron
* Node.js
* Express (para endpoint local)
* Librería de impresión (ej: `node-thermal-printer` o `printer`)

---

# 🛠️ Instalación

```bash
# Crear proyecto
mkdir print-agent
cd print-agent

# Inicializar
npm init -y

# Instalar dependencias
npm install electron express
```

---

# 📁 Estructura básica

```
print-agent/
├── main.js
├── server.js
├── package.json
├── icon.png
```

---

# ⚙️ Configuración (package.json)

```json
{
  "name": "print-agent",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  }
}
```

---

# 🧠 main.js (Electron - núcleo)

```js
const { app, BrowserWindow, Tray } = require('electron');
const path = require('path');

let tray = null;

app.whenReady().then(() => {
  // Crear ventana oculta
  const win = new BrowserWindow({
    show: false
  });

  // Crear tray icon
  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('Print Agent activo');

  // Auto start al iniciar sistema
  app.setLoginItemSettings({
    openAtLogin: true
  });

  // Iniciar servidor local
  require('./server');
});
```

---

# 🌐 server.js (endpoint local)

```js
const express = require('express');
const app = express();

app.use(express.json());

app.post('/print', async (req, res) => {
  const { content } = req.body;

  console.log("Imprimiendo:", content);

  // Aquí conectas tu lógica de impresión
  // Ejemplo:
  // printer.print(content);

  res.json({ ok: true });
});

app.listen(3001, () => {
  console.log('Print agent corriendo en http://localhost:3001');
});
```

---

# 🔌 Uso desde tu frontend (Next.js)

```js
await fetch('http://localhost:3001/print', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content: "Ticket de prueba"
  })
});
```

---

# ▶️ Ejecutar en desarrollo

```bash
npm start
```

---

# 📦 Generar ejecutable (producción)

Instala:

```bash
npm install electron-builder --save-dev
```

Agrega en `package.json`:

```json
"build": {
  "appId": "com.print.agent",
  "mac": { "target": "dmg" },
  "win": { "target": "nsis" }
}
```

Luego:

```bash
npx electron-builder
```

👉 Genera:

* `.dmg` (Mac)
* `.exe` (Windows)

---

# 🧠 Comportamiento final

* Usuario instala una vez
* App inicia automáticamente con el sistema
* Corre en segundo plano
* Escucha en `localhost:3001`
* Tu web le manda tickets
* Imprime sin interacción

---

# ⚠️ Buenas prácticas

* Validar requests (evitar abuso)
* Limitar acceso a localhost
* Manejar errores de impresora
* Loggear eventos importantes

---

# 💡 Mejoras futuras

* Selección de impresora
* Reintentos automáticos
* Logs visibles desde tray
* UI mínima de configuración

---

# 🎯 Resumen

Este agente convierte tu app web en un sistema tipo POS profesional:

✔ impresión automática
✔ sin navegador
✔ sin intervención del usuario
✔ multiplataforma

---
