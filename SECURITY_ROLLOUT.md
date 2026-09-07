# Despliegue seguro de reservas

Este cambio está preparado para probarse localmente y no está desplegado.

## Estado actual

- `functions/createDispute` crea disputas con transacción de Firestore.
- `requestWhatsappCode` y `verifyWhatsappCode` generan y validan códigos de un solo uso.
- El envío WhatsApp usa Twilio y sus credenciales se leen como secretos; nunca llegan al navegador.
- `createDispute` rechaza cualquier solicitud sin verificación WhatsApp vigente.
- El servidor limita a 2 intentos por combinación IP + contacto en 10 minutos.
- El servidor impide tomar una mesa activa dos veces.
- `expireDisputes` libera disputas vencidas cada 5 minutos.
- El frontend tiene `USE_SECURE_RESERVATION = false` mientras se prueba el backend.
- Las reglas actuales mantienen compatibilidad con el flujo anterior.

## Orden obligatorio antes de producción

1. Ejecutar `npm.cmd install` dentro de `functions`.
2. Configurar una cuenta WhatsApp Business API de Twilio y cargar `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y `TWILIO_WHATSAPP_FROM` como secretos de Functions.
3. Iniciar emuladores de Functions y Firestore.
4. Probar envío y verificación de código WhatsApp.
5. Probar creación simultánea de la misma mesa.
6. Probar el límite de intentos y la expiración.
7. Configurar Firebase App Check para el dominio real.
8. Cambiar `USE_SECURE_RESERVATION` a `true`.
9. Cambiar `allow create` de `reservas` a `false`; las reservas públicas deben entrar solo por la Function.
10. Probar nuevamente sin borrar la colección `reservas` existente.
11. Desplegar Functions y reglas primero.
12. Desplegar Hosting después y verificar una reserva real controlada.

No activar la bandera del frontend ni cerrar `allow create` hasta que la Function esté desplegada y App Check configurado; de lo contrario, los clientes no podrán crear disputas.
