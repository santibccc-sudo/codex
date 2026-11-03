# Codex Voz para Apple Watch

App nativa de **watchOS 10 o posterior**, escrita en SwiftUI, para conversar por voz con un asistente de OpenAI. Transmite el micrófono y reproduce la respuesta en streaming, con detección de turnos, interrupciones, transcripción, silencio y cierre de sesión.

**Es un proyecto inicial: el servidor se puede probar en Linux; la app necesita compilarse y probarse en Xcode y en un Apple Watch real.** No conecta con esta conversación de ChatGPT/Codex, no hereda su memoria ni sus herramientas y no controla tu Mac. Usa una sesión independiente de la API Realtime. El nombre del proyecto no implica que sea una app oficial de OpenAI.

## Arquitectura

```text
Apple Watch (SwiftUI + AVAudioEngine)
        │ WSS, token de dispositivo, PCM16 mono a 24 kHz
        ▼
Proxy HTTPS con certificado válido
        │ WebSocket /realtime → localhost:8787
        ▼
Servidor Node.js → API Realtime de OpenAI
```

La clave de OpenAI permanece en el servidor. El reloj guarda el token de acceso al servidor en su llavero; la URL se guarda en preferencias. El servidor no escribe audio ni transcripciones en disco; las transcripciones de la app solo viven en memoria y se borran al empezar una nueva conversación. El proveedor procesa el audio conforme a las condiciones de tu cuenta API. La suscripción a ChatGPT no incluye necesariamente crédito de API.

## 1. Comprobar tu Mac

En el Terminal **de tu Mac**, ejecuta:

```sh
xcodebuild -version
xcode-select -p
```

Si solo hay Command Line Tools, el primer comando puede fallar aunque exista Xcode en otra ubicación. Busca `Xcode` en Aplicaciones. Instala Xcode desde la App Store si falta, ábrelo y completa la instalación de la plataforma watchOS. En Xcode → Settings → Locations, selecciona la versión instalada de Command Line Tools. Este entorno en la nube no permite inspeccionar tu Mac.

Necesitas un Apple Watch con watchOS 10+, conexión a Internet y un Mac con una versión de Xcode compatible con el watchOS del reloj. Empareja el reloj con tu iPhone y habilita el modo de desarrollador para instalar desde Xcode. Usa auriculares Bluetooth si el altavoz produce eco.

## 2. Preparar el servidor

Requisitos: Node.js 22 o posterior y una cuenta API de OpenAI con crédito y acceso al modelo elegido.

```sh
cd server
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edita `.env` localmente: añade `OPENAI_API_KEY` y utiliza la cadena generada como `WATCH_ACCESS_TOKEN`. **No pegues claves en el chat ni las subas a Git.** El token del reloj también permite consumir tu cuota; mantenlo privado y cámbialo si se filtra. `REALTIME_MODEL` permite elegir otro modelo Realtime compatible disponible en tu cuenta.

```sh
npm test
npm run check
npm start
```

El servidor escucha en `127.0.0.1:8787` por defecto. `GET /healthz` verifica el proceso, pero no la cuota ni la conexión con OpenAI. Solo comienza a aceptar audio cuando OpenAI confirma la configuración. Limita cada sesión a 15 minutos y dos conexiones simultáneas por defecto. Esos límites no sustituyen el control de gasto de tu cuenta API. Respeta `HTTPS_PROXY` si está configurado.

Para el reloj necesitas un dominio propio o servicio de alojamiento con **HTTPS/WSS y certificado válido** que dirija `/realtime` al servidor. Ejemplo de Caddy en [docs/Caddyfile](docs/Caddyfile): sustituye el dominio y ejecuta Caddy en tu servidor siguiendo su instalación oficial. Conserva el puerto 8787 privado. No se ha desplegado ningún servicio ni creado un dominio desde este repositorio. Si el alojamiento usa contenedores o una red separada, configura `HOST` según sus requisitos y limita el acceso con su red privada/firewall.

## 3. Generar y abrir la app en Xcode

Instala [XcodeGen](https://github.com/yonaskolb/XcodeGen), por ejemplo con Homebrew si ya lo utilizas:

```sh
brew install xcodegen
cd /ruta/a/codex
xcodegen generate
open CodexVoice.xcodeproj
```

En Xcode:

1. Selecciona el target **CodexVoice** y tu equipo de firma en **Signing & Capabilities**. Cambia el bundle identifier a uno único de tu equipo.
2. Selecciona el reloj emparejado como destino. Pulsa **Run** y acepta el permiso del micrófono.
3. En el reloj abre **Ajustes** (engranaje). Introduce `wss://tu-dominio/realtime` y el **WATCH_ACCESS_TOKEN**, nunca la clave de OpenAI. Para textos largos puedes usar la entrada del teclado del iPhone cuando el sistema la ofrezca.
4. Pulsa **Hablar** y espera a **Escuchando**. Habla con naturalidad; el asistente responde al detectar que has terminado. Puedes hablar para interrumpir o pulsar **Interrumpir respuesta**.
5. Pulsa **Terminar** para cerrar micrófono, reproducción y conexión. La app también termina la sesión al pasar a segundo plano: no ofrece escucha permanente ni activación por una palabra clave.

Comprobación de compilación sin firma, desde el Mac con XcodeGen y el SDK de watchOS instalados:

```sh
xcodegen generate
xcodebuild -project CodexVoice.xcodeproj -scheme CodexVoice \
  -sdk watchsimulator -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build
```

El simulador ayuda a compilar y revisar la interfaz, pero no valida micrófono, enrutamiento, latencia o consumo del reloj real.

## Validación y límites

`server/test/relay.test.js` prueba el relay con un servidor WebSocket local que simula OpenAI: autenticación, esquema de sesión, audio, eventos de transcripción, interrupción, errores, límites y liberación de conexiones. No consume crédito de API ni demuestra calidad o latencia de voz real.

Consulta [docs/VALIDATION.md](docs/VALIDATION.md) para las pruebas pendientes de Xcode y del dispositivo. No se incluyen persistencia de conversaciones, acceso a repositorios, ejecución de órdenes ni integración con una sesión existente de Codex. La clave API y un despliegue WSS son requisitos pendientes para una conversación real.
