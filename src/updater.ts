import { app, net, shell } from "electron";
import { execFile, spawn } from "child_process";
import { createWriteStream } from "fs";
import { access, chmod, constants, mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import { PRINT_AGENT_PORT } from "./server";

// Actualizar desde la propia app, siempre a petición del usuario (nunca solo).
// Orden seguro: primero se descarga y se verifica la versión nueva sin tocar
// la que funciona; la vieja solo se borra cuando la nueva ya responde. Si algo
// falla, la app actual sigue igual. Cuando no se puede hacer solo (sin
// permiso de escritura, app fuera de Aplicaciones), se abre el instalador para
// hacerlo a mano.

const execFileAsync = promisify(execFile);

const RELEASES_API =
  "https://api.github.com/repos/braulio-flores/tickomium-print-agent/releases/latest";
const ASSET_NAME =
  process.platform === "win32" ? "Tickomium-Print-Agent-Setup.exe" : "Tickomium-Print-Agent.dmg";

export interface UpdateInfo {
  version: string;
  url: string;
  size: number;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up_to_date"; latest: string }
  | { status: "available"; update: UpdateInfo }
  | { status: "downloading"; update: UpdateInfo; progress: number }
  | { status: "installing"; update: UpdateInfo };

/** restarting: la app debe cerrarse ya. manual: se abrió el instalador. */
export type InstallOutcome = "restarting" | "manual";

let state: UpdateState = { status: "idle" };
const listeners = new Set<(s: UpdateState) => void>();

function setState(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l(state));
}

export function getUpdateState(): UpdateState {
  return state;
}

export function onUpdateState(listener: (s: UpdateState) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Última versión conocida para este sistema (null si no se pudo revisar). */
export function latestKnownVersion(): string | null {
  switch (state.status) {
    case "up_to_date":
      return state.latest;
    case "available":
    case "downloading":
    case "installing":
      return state.update.version;
    default:
      return null;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pregunta a GitHub por la última versión publicada. Solo cuenta como
 * disponible si ya trae el instalador de este sistema (el release se arma en
 * paralelo para Mac y Windows). Si falla, regresa a "idle" sin molestar.
 */
export async function checkForUpdate(): Promise<UpdateState | { status: "error" }> {
  if (state.status === "downloading" || state.status === "installing") return state;
  const previous = state;
  setState({ status: "checking" });
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Tickomium-Print-Agent" },
    });
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
    const release = (await res.json()) as {
      tag_name: string;
      assets: { name: string; browser_download_url: string; size: number }[];
    };
    const latest = release.tag_name.replace(/^v/, "");
    const asset = release.assets.find((a) => a.name === ASSET_NAME);
    if (asset && compareVersions(latest, app.getVersion()) > 0) {
      setState({
        status: "available",
        update: { version: latest, url: asset.browser_download_url, size: asset.size },
      });
    } else {
      setState({ status: "up_to_date", latest: asset ? latest : app.getVersion() });
    }
    return state;
  } catch (err) {
    console.error("No se pudo revisar actualizaciones:", err);
    setState(previous.status === "checking" ? { status: "idle" } : previous);
    return { status: "error" };
  }
}

async function download(update: UpdateInfo, dir: string): Promise<string> {
  const file = path.join(dir, ASSET_NAME);
  const res = await net.fetch(update.url);
  if (!res.ok || !res.body) throw new Error(`La descarga respondió ${res.status}`);

  const total = update.size || Number(res.headers.get("content-length")) || 0;
  let received = 0;
  let lastProgress = -1;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const progress = total ? Math.min(99, Math.floor((received * 100) / total)) : 0;
    if (progress !== lastProgress) {
      lastProgress = progress;
      setState({ status: "downloading", update, progress });
    }
  });
  await pipeline(body, createWriteStream(file));

  if (update.size && received !== update.size) {
    throw new Error("La descarga llegó incompleta");
  }
  return file;
}

// ─────────────────────────────── Windows ───────────────────────────────

// El instalador de electron-builder reemplaza la app en su lugar y conserva
// los datos del usuario. /S = sin ventanas, --updated = es actualización,
// --force-run = abrir la app al terminar.
async function installWindows(installer: string): Promise<InstallOutcome> {
  const child = spawn(installer, ["/S", "--updated", "--force-run"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return "restarting";
}

// ──────────────────────────────── macOS ────────────────────────────────

// Espera a que la app cierre, pone la nueva en su lugar con la vieja como
// respaldo, la abre y espera a que responda con la versión nueva. Si no
// responde, regresa la anterior. Corre aparte porque la app debe estar cerrada.
const MAC_SWAP_SCRIPT = `#!/bin/sh
PID="$1"; CURRENT="$2"; STAGED="$3"; BACKUP="$4"; VERSION="$5"; PORT="$6"; LOG="$7"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
log "Actualizando a $VERSION"

i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1))
  if [ $i -gt 150 ]; then log "La app no cerró; se cancela"; rm -rf "$STAGED"; exit 1; fi
  sleep 0.2
done

rm -rf "$BACKUP"
if ! mv "$CURRENT" "$BACKUP"; then
  log "No se pudo respaldar la versión actual"; rm -rf "$STAGED"; open "$CURRENT"; exit 1
fi
if ! mv "$STAGED" "$CURRENT"; then
  log "No se pudo colocar la versión nueva; se restaura la anterior"
  mv "$BACKUP" "$CURRENT"; open "$CURRENT"; exit 1
fi

open "$CURRENT"
i=0
while [ $i -lt 60 ]; do
  if curl -s -m 2 "http://127.0.0.1:$PORT/health" | grep -q "\\"version\\":\\"$VERSION\\""; then
    rm -rf "$BACKUP"; log "Listo: $VERSION"; exit 0
  fi
  i=$((i+1)); sleep 0.5
done

log "La versión nueva no respondió; se regresa la anterior"
pkill -f "$CURRENT/Contents/MacOS/" 2>/dev/null
sleep 1
rm -rf "$CURRENT"
mv "$BACKUP" "$CURRENT"
open "$CURRENT"
exit 1
`;

function currentMacBundle(): string {
  // .../Tickomium Print Agent.app/Contents/MacOS/Tickomium Print Agent
  return path.resolve(app.getPath("exe"), "..", "..", "..");
}

async function canReplaceInPlace(bundle: string): Promise<boolean> {
  if (!bundle.endsWith(".app")) return false;
  // macOS corre desde una copia temporal de solo lectura si la app conserva la
  // cuarentena; reemplazar esa copia no serviría de nada.
  if (bundle.includes("/AppTranslocation/")) return false;
  try {
    await access(path.dirname(bundle), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function installMac(dmg: string, dir: string, update: UpdateInfo): Promise<InstallOutcome> {
  const bundle = currentMacBundle();
  if (!(await canReplaceInPlace(bundle))) {
    await shell.openPath(dmg);
    return "manual";
  }

  const parent = path.dirname(bundle);
  const staged = path.join(parent, `.${path.basename(bundle)}.update`);
  const backup = path.join(parent, `.${path.basename(bundle)}.old`);
  await rm(staged, { recursive: true, force: true });

  // Copiar la app nueva junto a la actual (mismo disco: el cambio final es un
  // simple renombrado). ditto conserva los enlaces internos de Electron.
  const mount = path.join(dir, "mnt");
  await mkdir(mount);
  await execFileAsync("hdiutil", ["attach", dmg, "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mount]);
  try {
    const appName = (await readdir(mount)).find((n) => n.endsWith(".app"));
    if (!appName) throw new Error("El instalador no trae la app");
    await execFileAsync("ditto", [path.join(mount, appName), staged]);
  } finally {
    await execFileAsync("hdiutil", ["detach", mount, "-force"]).catch(() => {});
  }

  try {
    await execFileAsync("xattr", ["-cr", staged]).catch(() => {});
    const { stdout } = await execFileAsync("defaults", [
      "read",
      path.join(staged, "Contents", "Info"),
      "CFBundleShortVersionString",
    ]);
    if (stdout.trim() !== update.version) {
      throw new Error(`Se descargó la versión ${stdout.trim()} en lugar de ${update.version}`);
    }
  } catch (err) {
    await rm(staged, { recursive: true, force: true });
    throw err;
  }

  const script = path.join(dir, "actualizar.sh");
  await writeFile(script, MAC_SWAP_SCRIPT);
  await chmod(script, 0o755);
  const logFile = path.join(app.getPath("logs"), "actualizaciones.log");
  await mkdir(path.dirname(logFile), { recursive: true });
  spawn(
    "/bin/sh",
    [script, String(process.pid), bundle, staged, backup, update.version, String(PRINT_AGENT_PORT), logFile],
    { detached: true, stdio: "ignore" }
  ).unref();
  return "restarting";
}

/**
 * Descarga e instala. Si regresa "restarting", quien llama debe cerrar la app
 * de inmediato (el instalador o el script esperan a que cierre). Si lanza
 * error, la app actual quedó intacta.
 */
export async function downloadAndInstall(update: UpdateInfo): Promise<InstallOutcome> {
  if (!app.isPackaged) {
    // En desarrollo no hay app instalada que reemplazar.
    await shell.openExternal(update.url);
    return "manual";
  }

  setState({ status: "downloading", update, progress: 0 });
  try {
    const dir = await mkdtemp(path.join(app.getPath("temp"), "tickomium-actualizacion-"));
    const file = await download(update, dir);
    setState({ status: "installing", update });
    const outcome =
      process.platform === "win32" ? await installWindows(file) : await installMac(file, dir, update);
    if (outcome === "manual") setState({ status: "available", update });
    return outcome;
  } catch (err) {
    setState({ status: "available", update });
    throw err;
  }
}
