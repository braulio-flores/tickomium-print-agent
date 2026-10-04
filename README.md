# Tickomium Print Agent

App de escritorio (Electron) que permite a Tickomium, que corre en el navegador, imprimir tickets en la impresora térmica de la computadora. El navegador no puede hablar con impresoras locales; esta app sí.

## Cómo funciona

```
Tickomium (navegador) ──► backend genera el ticket ESC/POS
        │
        └──► POST http://localhost:6441/print ──► impresora (lp en Mac, PowerShell en Windows)
```

- Corre en segundo plano: sin ventana ni ícono en el Dock, solo un ícono junto al reloj. Al hacerle clic se abre la configuración (elegir impresora e imprimir una prueba).
- Se abre sola al encender la computadora (se puede apagar desde el menú del ícono: "Abrir al encender la computadora").
- Instancia única: si se abre otra vez estando corriendo, muestra la ventana de la que ya está abierta.
- Puerto fijo **6441**. No es configurable: Tickomium siempre busca la app ahí. Si otro programa lo ocupa, la app avisa al iniciar.
- Solo acepta peticiones de `https://www.tickomium.com` (producción; `tickomium.com` redirige ahí), `https://tickomium.com` y `localhost` (desarrollo). Cualquier otro origen recibe 403. Si el frontend se publica en otro dominio, hay que agregarlo en `isAllowedOrigin` (`src/server.ts`) y sacar versión nueva.

Si la app está cerrada, Tickomium lo detecta (`GET /health`) y le explica al cajero cómo abrirla o instalarla.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado de la app y de la impresora (`printerStatus`: `enabled`, `disabled`, `not_found`, `not_configured`) |
| GET | `/printers` | Impresoras instaladas en el sistema |
| GET | `/config` | Impresora elegida |
| POST | `/print` | Recibe el ticket ESC/POS crudo (`application/octet-stream`) y lo manda a la impresora |

## Desarrollo

```bash
npm install
npm run dev          # compila y abre la app de Electron
npm run dev:server   # solo el servidor, sin Electron
```

El servidor suelto acepta `PRINTER_NAME` y `PRINT_AGENT_PORT` como variables de entorno (útil para levantar una segunda copia de prueba en otro puerto). La app instalada siempre usa 6441 y la impresora elegida en su ventana.

Para ver los nombres de impresoras en Mac: `lpstat -a`.

En desarrollo (`app.isPackaged === false`) no se registra el arranque automático, para no dejar el binario de Electron en los ítems de inicio.

## Publicar una versión

1. Sube la versión en `package.json` (`npm version x.y.z --no-git-tag-version`).
2. Haz commit y empuja un tag `vx.y.z`. El workflow `release.yml` compila el `.dmg` (macOS) y el `.exe` (Windows) y los adjunta al release.
3. Tickomium descarga siempre `releases/latest`, así que el nuevo instalador queda disponible al instante.

La app de Mac no está firmada: el `.dmg` incluye `Instalar.command`, que le quita la cuarentena para que macOS la deje abrir. Por lo mismo, macOS puede pedir aprobar el arranque automático en Configuración del Sistema → General → Ítems de inicio.
