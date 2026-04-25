#!/bin/bash
APP="/Applications/Tickomium Print Agent.app"

if [ ! -d "$APP" ]; then
  osascript -e 'display dialog "Primero arrastra Tickomium Print Agent a la carpeta Applications, luego ejecuta este instalador otra vez." buttons {"OK"} default button 1 with icon caution with title "Tickomium Print Agent"'
  exit 1
fi

xattr -cr "$APP"

osascript -e 'display dialog "Instalacion completada.\n\nYa puedes abrir Tickomium Print Agent desde Applications." buttons {"OK"} default button 1 with title "Tickomium Print Agent"'

exit 0
