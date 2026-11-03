# Validación en el Mac y el Apple Watch

La compilación de Swift/watchOS y la prueba de voz con OpenAI no se pueden realizar en el entorno Linux de este proyecto. No deben darse por superadas por el resultado de las pruebas del servidor.

## En el Mac

- `xcodebuild -version` debe mostrar la versión completa de Xcode.
- Instala la plataforma watchOS compatible con tu reloj; genera el proyecto con `xcodegen generate`.
- Ejecuta el comando de compilación para watchsimulator del README. Corrige cualquier incompatibilidad detectada por el SDK antes de instalar.
- Selecciona el equipo de firma y un identificador único para instalar en un reloj físico.

## En el servidor

- Configura las credenciales en `.env` y arranca `npm start`.
- Verifica `GET /healthz` a través del dominio HTTPS.
- Comprueba que el proxy admite el upgrade WebSocket y mantiene `Authorization`.
- Con un token incorrecto `/realtime` debe devolver 401.
- Con el token válido, el evento `relay.ready` solo debe llegar cuando OpenAI acepta la sesión.
- No habilites logs de cuerpos, cabeceras de autenticación ni audio en el proxy.

## En el reloj real

1. Guarda una URL WSS válida y el token; cierra y abre la app y confirma que puede reconectar.
2. Rechaza el permiso de micrófono: debe aparecer un error; habilítalo en los ajustes para continuar.
3. Pulsa Hablar: comprueba un intercambio hablado en español y las transcripciones.
4. Interrumpe hablando y con el botón durante una respuesta larga. Comprueba que deja de reproducirse y que la siguiente respuesta tiene sentido.
5. Repite con auriculares Bluetooth y con la salida integrada que admita el reloj; comprueba eco y selección de ruta. Si hay realimentación acústica, usa auriculares.
6. Silencia el micrófono y confirma que no se transmiten nuevos fragmentos capturados mientras está silenciado.
7. Pulsa Terminar, cambia de app y provoca una interrupción de audio: el micrófono y el servidor deben cerrar la sesión. Una conexión cortada debe liberar el upstream.
8. Prueba sin red, con token inválido y con el servidor detenido: la interfaz debe permitir volver a intentarlo sin sesiones duplicadas.
9. Prueba en wifi y en la conectividad real de tu reloj. Mide tiempo hasta la primera respuesta y consumo de batería; no se promete una latencia determinada.
10. Revisa uso y coste en tu cuenta API y el límite de duración de la sesión.
