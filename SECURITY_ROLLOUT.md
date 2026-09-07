# Despliegue seguro de reservas

Este cambio está preparado para probarse localmente y no está desplegado.

## Estado actual

- `functions/createDispute` crea disputas con transacción de Firestore.
- El servidor limita a 2 intentos por combinación IP + contacto en 10 minutos.
- El servidor impide tomar una mesa activa dos veces.
- `expireDisputes` libera disputas vencidas cada 5 minutos.
- El frontend tiene `USE_SECURE_RESERVATION = false` mientras se prueba el backend.
- Las reglas actuales mantienen compatibilidad con el flujo anterior.

## Orden obligatorio antes de producción

1. Ejecutar `npm.cmd install` dentro de `functions`.
2. Iniciar emuladores de Functions y Firestore.
3. Probar creación simultánea de la misma mesa.
4. Probar el límite de intentos y la expiración.
5. Configurar Firebase App Check para el dominio real.
6. Cambiar `USE_SECURE_RESERVATION` a `true`.
7. Cambiar `allow create` de `reservas` a `false`; las reservas públicas deben entrar solo por la Function.
8. Probar nuevamente sin borrar la colección `reservas` existente.
9. Desplegar Functions y reglas primero.
10. Desplegar Hosting después y verificar una reserva real controlada.

No activar la bandera del frontend ni cerrar `allow create` hasta que la Function esté desplegada y App Check configurado; de lo contrario, los clientes no podrán crear disputas.
