import { app, dialog } from "electron";
import { execFile } from "child_process";
import * as path from "path";

// La primera vez el usuario permite la app en Privacidad y seguridad
// («Abrir igualmente»). macOS guarda ese permiso en la marca de "descargado de
// internet" del propio archivo de la app; si no puede escribirla (la app se
// abrió desde la ventana del .dmg, que es de solo lectura, o desde una copia
// temporal), vuelve a pedir permiso en cada apertura y al encender la
// computadora. Estas dos funciones evitan que el cajero se quede en ese ciclo.

function isMacInstalledApp(): boolean {
  return process.platform === "darwin" && app.isPackaged;
}

/**
 * Si la app no está en Aplicaciones, ofrece moverla. Regresa true cuando la
 * movió: la app se cierra y se vuelve a abrir sola desde Aplicaciones, así que
 * quien llama no debe seguir arrancando.
 */
export async function offerMoveToApplications(): Promise<boolean> {
  if (!isMacInstalledApp() || app.isInApplicationsFolder()) return false;

  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Tickomium Print Agent",
    message: "Vamos a moverla a Aplicaciones",
    detail:
      "La app se abrió desde fuera de la carpeta Aplicaciones (por ejemplo, desde la ventana del instalador). " +
      "Así la Mac te pediría permiso cada vez y no se abriría sola al encender la computadora.\n\n" +
      "Se moverá a Aplicaciones y se volverá a abrir sola en unos segundos.",
    buttons: ["Mover a Aplicaciones", "Ahora no"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;

  try {
    // Si ya hay otra copia en Aplicaciones (sin abrir), se reemplaza.
    return app.moveToApplicationsFolder({ conflictHandler: () => true });
  } catch (err) {
    console.error("No se pudo mover a Aplicaciones:", err);
    dialog.showErrorBox(
      "No se pudo mover",
      "Arrastra Tickomium Print Agent a la carpeta Aplicaciones y ábrela desde ahí."
    );
    return false;
  }
}

/**
 * Si la app ya está corriendo es que el usuario la permitió; se quita la marca
 * de "descargado de internet" para que macOS no vuelva a preguntar (ni al
 * reabrirla ni al encender la computadora). Si no tiene permiso para hacerlo,
 * no pasa nada: la app sigue funcionando igual.
 */
export function rememberMacApproval() {
  if (!isMacInstalledApp() || !app.isInApplicationsFolder()) return;
  const bundle = path.resolve(app.getPath("exe"), "..", "..", "..");
  execFile("xattr", ["-dr", "com.apple.quarantine", bundle], (err) => {
    if (err) console.error("No se pudo guardar el permiso de macOS:", err.message);
  });
}
