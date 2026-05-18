# RESPUESTAS

## 1. Problemas encontrados

### Problema 1 — Webhook no idempotente (CRÍTICO)
- **Descripción:** `processPaycashWebhook` insertaba en `payment_webhook_logs` y luego procesaba el pago sin verificar si `provider_event_id` ya había sido procesado. El mismo evento podía aplicarse múltiples veces.
- **Cómo lo reproduje:** El seed ya incluye dos filas con `evt-dup-001` en `payment_webhook_logs`, evidencia directa del problema. Un segundo POST con el mismo `eventId` aplicaba el cobro de nuevo.
- **Impacto operativo:** Un cobro duplicado acumula `paid_amount` por encima del `total_amount` real, corrompiendo el balance de la orden y los reportes de recaudo.
- **Solución aplicada:** Antes de insertar el log, se consulta `SELECT id FROM payment_webhook_logs WHERE provider = 'paycash' AND provider_event_id = $1`. Si existe, se retorna `{ applied: false, reason: 'Duplicate event' }` inmediatamente sin tocar la orden.

### Problema 2 — Reporte diario incluye órdenes canceladas (CRÍTICO)
- **Descripción:** El SQL en `getDailyCashReport` usaba `status IN ('paid', 'cancelled')`, sumando `paid_amount` de órdenes canceladas en el total de recaudo del día.
- **Cómo lo reproduje:** Una consulta directa a `/api/reports/daily-cash?date=<fecha>` en una fecha con órdenes canceladas devuelve un total inflado si esas órdenes tienen `paid_amount > 0`.
- **Impacto operativo:** El reporte de caja no cuadra con el dinero real recibido; produce descuadres contables.
- **Solución aplicada:** Cambié el filtro a `status = 'paid'`. Solo las órdenes completamente cobradas deben contar.

### Problema 3 — Filtro de status ignorado cuando se combina con fechas (CRÍTICO)
- **Descripción:** En `listOrders` la condición era `if (filters.status && !filters.from && !filters.to)`, lo que descartaba silenciosamente el filtro de status cuando también se enviaban filtros de fecha.
- **Cómo lo reproduje:** `GET /api/orders?status=cancelled&from=2024-01-01` devolvía todas las órdenes del rango de fecha, sin filtrar por status.
- **Impacto operativo:** Los operadores no pueden buscar "órdenes canceladas en enero"; el sistema responde sin error pero con datos incorrectos.
- **Solución aplicada:** Removí la condición extra. Ahora es simplemente `if (filters.status)`.

### Problema 4 — Órdenes canceladas aceptan pagos (ALTO)
- **Descripción:** `payOrderService` solo validaba `status === 'paid'` pero no bloqueaba órdenes con `status === 'cancelled'`.
- **Cómo lo reproduje:** `PATCH /api/orders/4/pay` con `{ amount: 100, source: "manual" }` sobre ORD-1004 (cancelada) actualizaba `paid_amount` y podía cambiar el status a `paid`.
- **Impacto operativo:** Una orden cancelada podía quedar como pagada, corrompiendo el estado del flujo y generando cobros sobre entregas que ya no existen.
- **Solución aplicada:** Agregué guard después del check de `'paid'`: `if (order.status === 'cancelled') throw new Error('Cannot pay a cancelled order')`.

### Problema 5 — Webhook aplica pago a órdenes canceladas (ALTO)
- **Descripción:** `processPaycashWebhook` no verificaba el status de la orden antes de aplicar el cobro.
- **Cómo lo reproduje:** POST a `/api/webhooks/paycash` con `folio: 'ORD-1004'` aplicaba el pago sin restricción.
- **Impacto operativo:** Mismo riesgo que el Problema 4, pero por vía automática (webhook del proveedor de pagos).
- **Solución aplicada:** Después de resolver la orden por folio, agregué `if (order.status === 'cancelled') return { applied: false, reason: 'Order is cancelled' }`.

### Problema 6 — Crash con `recipient_name` null (ALTO)
- **Descripción:** `mapRowToOrder` llamaba `row.recipient_name.trim()` sin verificar null. ORD-1005 tiene `recipient_name = NULL` en el seed.
- **Cómo lo reproduje:** `GET /api/orders/5` devolvía un error 500 con `TypeError: Cannot read properties of null (reading 'trim')`.
- **Impacto operativo:** Cualquier endpoint que retorne esta orden rompe la respuesta completa, incluyendo listados paginados.
- **Solución aplicada:** `row.recipient_name?.trim() ?? null`.

---

## 2. Cambios realizados

| Archivo | Cambio |
|---|---|
| `src/modules/orders/orders.repository.ts` | `recipient_name?.trim() ?? null` para null safety; removida condición `!filters.from && !filters.to` del filtro de status |
| `src/modules/orders/orders.service.ts` | Guard para `status === 'cancelled'` en `payOrderService` |
| `src/modules/payments/payments.service.ts` | Idempotency check con SELECT antes del INSERT; guard para `status === 'cancelled'` antes de aplicar pago |
| `src/modules/reports/reports.service.ts` | SQL corregido a `status = 'paid'` |

Total: 4 archivos de producción modificados. Sin nuevas dependencias. Sin cambios de stack.

---

## 3. Pruebas agregadas o modificadas

Se convirtieron 7 tests de `.todo()` a implementaciones reales:

**`orders.test.ts`**
- `does not allow paying a cancelled order` — PATCH sobre ORD-1004, espera 500 con mensaje de error correcto
- `handles orders with null recipient_name` — GET sobre ORD-1005, espera 200 con `recipient_name: null`
- `applies status filter correctly when combined with date filters` — GET con `status=cancelled&from=<hace 7 días>`, espera exactamente ORD-1004

**`payments.test.ts`**
- `does not process the same webhook event twice` — envía el mismo payload dos veces, verifica que el segundo retorna `applied: false, reason: 'Duplicate event'`
- `does not apply payment to cancelled orders from webhook` — webhook apuntando a ORD-1004, verifica `applied: false, reason: 'Order is cancelled'`

**`reports.test.ts`**
- `does not include cancelled orders in daily cash report` — reporte de ayer, verifica total = 950 (solo ORD-1006 paid)
- `returns the expected total cash for a known seeded date` — misma fecha, verifica date y totalCash exactos

---

## 4. Riesgos pendientes

- **Race condition en idempotencia:** La solución actual hace SELECT + INSERT en dos operaciones separadas. Dos requests simultáneos con el mismo `eventId` podrían ambos pasar el SELECT antes de que el primero haga el INSERT. En producción se necesita un constraint `UNIQUE (provider, provider_event_id)` a nivel de base de datos con manejo de `ON CONFLICT`.
- **Sin transacción en el webhook:** El INSERT en `payment_webhook_logs`, el `updateOrderPayment` y el `createAuditLog` no son atómicos. Si el servidor cae entre operaciones, los datos quedan en estado inconsistente.
- **Audit solo en transición a `paid`:** La auditoría registra únicamente cuando una orden llega a status `paid`. Pagos parciales (cuando `nextStatus` es `undefined`) no generan registro de auditoría.
- **Tests de reporte limitados por seed:** ORD-1004 tiene `paid_amount = 0`, así que el test del reporte produce el mismo resultado con o sin el fix del SQL. La cobertura es válida como ancla de regresión, pero no detectaría el bug activamente si se restaurara.

---

## 5. Qué haría diferente en producción

- Agregar `UNIQUE (provider, provider_event_id)` en `payment_webhook_logs` y usar `INSERT ... ON CONFLICT DO NOTHING` para garantizar idempotencia a nivel de DB.
- Envolver `processPaycashWebhook` en una transacción de base de datos para atomicidad completa.
- Implementar una máquina de estados explícita para las transiciones de órdenes, con una tabla de transiciones válidas, en lugar de guards dispersos en el código.
- Mover la creación de audit logs a un mecanismo centralizado (middleware o event emitter) para desacoplarlos de la lógica de negocio.
- Ampliar la auditoría para registrar también pagos parciales, no solo la transición final a `paid`.
- Separar la base de datos de pruebas de la de desarrollo mediante variables de entorno por ambiente.

---

## 6. Uso de IA

Utilicé **Claude Code (claude-sonnet-4-6)** como asistente durante esta prueba en las siguientes tareas:

- **Exploración del codebase:** Usé agentes de exploración para leer todos los archivos fuente, tests, migraciones y seed en paralelo, acelerando la fase de diagnóstico.
- **Planificación:** Usé un agente de planificación para diseñar el orden de implementación y las versiones exactas de código antes/después de cada fix.

**Cómo validé las respuestas:**
- Leí personalmente cada archivo fuente crítico para confirmar que los bugs identificados por la IA correspondían exactamente al código real (línea a línea).
- Verifiqué que los cambios propuestos eran mínimos y correctos antes de aplicarlos.
- Ejecuté los tests al final para confirmar que todos pasan y que no hay regresiones.

Todas las decisiones técnicas (qué bugs priorizar, cómo corregirlos, qué riesgos documentar) fueron tomadas por mí y validadas contra el código real del repositorio.
