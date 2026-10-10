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

## Actualizaciones (desde la v1.2.0)

La app revisa GitHub al arrancar y cada 6 horas. **Nunca se instala sola**: si hay versión nueva, aparece "Actualizar a la versión X…" en el menú del ícono y un aviso en su ventana, y solo actualiza cuando el usuario lo confirma. `/health` reporta `version` y `latestVersion`, y Tickomium avisa en Configuración cuando la app está desactualizada.

Orden seguro: se descarga y verifica la versión nueva sin tocar la que funciona; la vieja solo se borra cuando la nueva ya responde. La configuración (impresora elegida, arranque automático) vive fuera de la app y no se toca.

- **Windows:** corre el instalador descargado en modo silencioso (`/S --updated --force-run`); reemplaza la app en su lugar y la vuelve a abrir.
- **Mac (app sin firmar):** monta el `.dmg`, copia la app nueva junto a la actual (`.Tickomium Print Agent.app.update`), verifica su versión, y un script aparte espera a que la app cierre, pone la nueva en su lugar con la vieja como respaldo (`.app.old`), la abre y espera a que `/health` responda con la versión nueva. Si no responde en ~30 s, regresa la anterior. Registro en `~/Library/Logs/Tickomium Print Agent/actualizaciones.log`.
- Si no se puede reemplazar sola (sin permiso de escritura en Aplicaciones, o la app corre fuera de ahí), abre el `.dmg` y explica cómo terminar a mano.

Las versiones anteriores a la 1.2.0 no traen el actualizador: esa instalación es a mano (Tickomium la detecta porque no reportan versión).

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

### Mac sin firma de Apple

La app no está firmada con una cuenta de desarrollador de Apple. Al empaquetar, `scripts/adhoc-sign.js` (hook `afterPack`) le pone una **firma local válida** (`codesign --sign -`). Eso importa: sin firma, la que trae Electron queda rota y macOS dice que la app "está dañada", un aviso sin salida. Con firma local válida, macOS solo dice que no pudo verificarla y se permite una vez por Mac desde **Configuración del Sistema → Privacidad y seguridad → «Abrir igualmente»** (pide contraseña de administrador). Tickomium muestra esos pasos al instalar.

macOS guarda ese permiso en la marca de cuarentena del propio `.app`. Si no puede escribirla (la app se abrió desde la ventana del `.dmg`, que es de solo lectura, o desde una copia temporal), vuelve a pedir permiso en cada apertura. Por eso, desde la v1.2.1 (`src/mac-install.ts`), al arrancar:
- si la app no está en Aplicaciones, ofrece moverla (`app.moveToApplicationsFolder`) y se reabre sola desde ahí;
- ya en Aplicaciones (y corriendo, o sea permitida por el usuario), se quita su propia marca de cuarentena para que macOS no vuelva a preguntar, ni al reabrirla ni al encender la computadora.

No se usa un script de "instalación" dentro del `.dmg`: al venir de internet, macOS lo bloquea igual que a la app. Las actualizaciones desde la propia app no traen la marca de internet, así que ya no piden permiso.

Comprobar una compilación: `codesign --verify --deep --strict "release/mac-arm64/Tickomium Print Agent.app"`.

Hoy solo se compila para Apple Silicon (el runner `macos-latest` es arm64): en Mac con procesador Intel no abre.

macOS puede pedir aprobar el arranque automático en Configuración del Sistema → General → Ítems de inicio.
