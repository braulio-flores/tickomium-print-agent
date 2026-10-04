// Firma local ("ad-hoc") de la app de Mac al empaquetar.
//
// Sin firma de Apple, macOS bloquea la app la primera vez. Con una firma local
// VÁLIDA el bloqueo se salta desde Configuración del Sistema → Privacidad y
// seguridad → «Abrir igualmente». Sin firmar (identity: null), la firma que
// trae Electron queda rota al meterle nuestros archivos y macOS dice que la app
// "está dañada", un aviso sin botón para continuar.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
