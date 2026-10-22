# funnelchat-cli

La CLI de Funnelchat para **exportar tus conversaciones y tus contactos** desde la API pública, y consultar tus números, tus plantillas y tus MACs, con tu clave de integrador. Escribe archivos que se pueden verificar, nunca pisa uno que ya existe y, si se corta, sigue desde donde quedó.

```bash
funnelchat contacts export --output-dir ./mis-contactos
funnelchat conversations export --since 2026-10-01 --output-dir ./octubre
```

> **Estado: v0.** La API pública está en v0 y puede cambiar. La CLI usa solo lo que la API tiene en producción; lo que se suma después está en [Lo que viene](#lo-que-viene). La referencia de la API está en el [portal de desarrolladores](https://developers-portal.funnelchat.app/docs/).

## Qué hace y qué no

- **Solo lee.** No manda mensajes, no crea ni modifica nada en tu cuenta: todas sus llamadas son `GET`.
- **Exporta paginando la API pública**, porque la API no tiene una exportación del lado del servidor. Una cuenta grande lleva su tiempo: la CLI va a un ritmo bajo a propósito para no frenar tu panel.
- **No guarda ni muestra tu clave** en ningún lado salvo en tu archivo de configuración, si usas `funnelchat login`.

## Instalación

Necesitas Node 18 o posterior.

```bash
npm install --global funnelchat-cli
funnelchat --version
```

O sin instalarla: `npx funnelchat-cli --version`.

### Un ejemplo mínimo

```bash
funnelchat login                                   # pega tu clave; no se muestra
funnelchat whoami                                  # a qué cuenta pertenece
funnelchat contacts export --output-dir ./mis-contactos
```

Deja `mis-contactos/contacts.csv` y `mis-contactos/manifest.json`, con el SHA-256 de cada archivo.

### Desde el código

```bash
git clone https://github.com/Funnelchat20/funnelchat-cli.git
cd funnelchat-cli
npm install
npm run build
npm link            # deja el comando `funnelchat` disponible en tu terminal
```

Sin `npm link`, ejecuta `node dist/cli.js` en lugar de `funnelchat`.

## Autenticación

La CLI usa una clave de API de tu cuenta: `<id>|fc_live_...`, completa, tal como la muestra la pantalla **Desarrolladores** al crearla. Los permisos que pide cada comando:

| Comando | Permiso |
|---|---|
| `contacts export`, `conversations export`, `templates`, `mac status` | `conversations:read` |
| `whoami`, `numbers` | `accounts:read` |

Hay dos formas de dársela:

**Con una variable de entorno**, para scripts y servidores:

```bash
export FUNNELCHAT_API_KEY='<id>|fc_live_...'   # entre comillas: lleva un |
funnelchat whoami
```

**Con `funnelchat login`**, que la guarda en tu archivo de configuración con permisos `0600` (solo tú puedes leerlo):

```bash
funnelchat login
# Pega tu clave de API de Funnelchat (no se muestra) y presiona Enter:
```

```
Clave guardada en el perfil "default" (/Users/ana/.config/funnelchat/config.json, permisos 0600).
Cuenta: Mi Empresa (hola@miempresa.com)
```

Antes de guardarla, `login` la prueba contra `GET /api/v1/me`: si la API la rechaza, no se guarda. También la lee de la entrada estándar (`funnelchat login < clave.txt`). La CLI **nunca** toma la clave de una opción de la línea de comandos, para que no quede en el historial de tu terminal.

**Qué clave usa.** Si pasas `--profile`, la de ese perfil. Si no, `FUNNELCHAT_API_KEY` si está definida. Si no, la del perfil activo (el último con el que hiciste `login`, o el de `FUNNELCHAT_PROFILE`).

**Perfiles.** Para varias cuentas o entornos:

```bash
funnelchat login --profile cliente-b
funnelchat login --profile pruebas --staging
funnelchat profiles                 # lista los perfiles, nunca las claves
funnelchat profiles use cliente-b   # elige el activo
funnelchat --profile pruebas whoami
funnelchat logout --profile pruebas # borra la clave de ese perfil
```

**La URL base.** Por defecto, `https://api.funnelchat.com`. `--staging` usa `https://api-staging.funnelchat.com`; `--base-url` (o `FUNNELCHAT_BASE_URL`) cualquier otra, siempre `https`. Solo se acepta `http` para tu propia máquina, por ejemplo el [sandbox](https://github.com/Funnelchat20/funnelchat-sandbox):

```bash
FUNNELCHAT_API_KEY='1|fc_live_sandbox' funnelchat --base-url http://127.0.0.1:4010 contacts export
```

**El archivo de configuración** está en `~/.config/funnelchat/config.json` (o en `$XDG_CONFIG_HOME/funnelchat/`, o en `%APPDATA%\funnelchat\` en Windows; `FUNNELCHAT_CONFIG_DIR` lo cambia). Si otros usuarios de tu máquina pueden leerlo, la CLI te avisa.

## Comandos

Cada comando acepta `--json` para usarlo desde scripts y `--help` para ver todas sus opciones.

### `funnelchat whoami`

A qué cuenta pertenece la clave, sin mostrar la clave.

```bash
funnelchat whoami
```

```
Cuenta: Mi Empresa (hola@miempresa.com)
  id 42 · rol owner · zona horaria America/Argentina/Buenos_Aires · idioma es
Clave: de la variable FUNNELCHAT_API_KEY (no se muestra)
URL base: https://api.funnelchat.com
```

Muestra solo estos datos de `GET /api/v1/me`: id, nombre, email, rol, zona horaria, idioma y los límites de números y agentes. Esa ruta también devuelve un token de sesión: la CLI nunca lo muestra, ni con `--json`.

### `funnelchat numbers list`

Tus números, con su conexión y lo que la CLI puede exportar o leer de cada uno. Sirve para elegir qué exportar.

```bash
funnelchat numbers list
```

```
id  alias      número         conexión  conectado  salud      qué lee la CLI
3   Ventas     5491100000001  oficial   sí         AVAILABLE  contactos, conversaciones, plantillas, salud y límite
4   Soporte    5491100000002  QR        sí         -          contactos, conversaciones
```

«Qué lee la CLI» lo deduce la CLI del tipo de conexión (`provider`): los números oficiales (API de WhatsApp Cloud) tienen plantillas y salud; los de QR, no. Con `--json` sale como `cli_capabilities`. El campo `capabilities` de cada número es otra cosa: lo que la API puede hacer con él (tipos de mensaje, grupos, estados que informa), tal como lo devuelve `GET /api/v1/devices`, sin tocar.

### `funnelchat numbers health`

La salud de tus números oficiales: estado, calidad, límite de mensajes por día y throughput, del último dato que guardó Funnelchat (no consulta a Meta en el momento).

```bash
funnelchat numbers health        # todos los oficiales
funnelchat numbers health 3      # uno
```

```
id  estado     calidad  límite   por día  throughput  actualizado                viejo
3   AVAILABLE  GREEN    TIER_1K  1.000    STANDARD    2026-10-16T10:00:00+00:00  no
```

### `funnelchat contacts export`

Todos tus contactos, con sus etiquetas y sus campos personalizados, en CSV (por defecto) o JSONL.

```bash
funnelchat contacts export --output-dir ./contactos
funnelchat contacts export --format jsonl --tag 4001 --created-from 2026-10-01 --created-to 2026-10-15 -o ./nuevos-clientes
```

```
Exportando contactos a /Users/ana/contactos
  contactos: 100 de 436
  …
Exportación completa: 436 contactos en /Users/ana/contactos/contacts.csv.
Manifiesto: /Users/ana/contactos/manifest.json (sha256 9f2c…)
```

| Opción | Qué hace |
|---|---|
| `-o`, `--output-dir <carpeta>` | Una carpeta nueva o vacía. Por defecto, `funnelchat-contacts-export-<fecha>`. |
| `--format csv\|jsonl` | CSV para planillas (por defecto) o JSONL, un contacto por línea tal como lo devuelve la API. |
| `--tag <id>` | Solo contactos con esa etiqueta. Se puede repetir (`--tag 1 --tag 2`) o separar con comas. |
| `--tag-mode any\|all\|exclude` | Con varias etiquetas: alguna, todas, o ninguna. |
| `--created-from`, `--created-to` | Creados entre esas fechas (`AAAA-MM-DD`, los dos días enteros). Van juntas: la API pide las dos. |
| `--only-with-phone` | Solo contactos a los que se les puede escribir. |
| `--no-tags`, `--no-custom-fields` | Sin etiquetas o sin campos: cada una ahorra una llamada por contacto. |
| `--resume` | Retoma una exportación cortada. Ver [Retomar](#retomar). |

- **El CSV** trae una columna por dato del contacto (`id`, `name`, `phone`, `email`, `whatsapp_id`, `country_code`, `created_at`, `lead_score`…), `tags` (los nombres, separados por `; `) y `tag_ids`, y una columna `custom_field:<nombre>` por cada campo personalizado de tu cuenta. Va con BOM UTF-8 y fin de línea CRLF, para que Excel muestre bien los acentos.
- **Una celda que empieza con `=`, `+`, `-` o `@`** (y no es un número) lleva un `'` adelante: los nombres los escriben tus contactos, y así tu planilla no los ejecuta como fórmulas.
- **Tarda más con etiquetas y campos:** el listado de contactos no los trae, así que la CLI hace dos llamadas más por contacto. Al ritmo por defecto (1 por segundo), 1.000 contactos con todo son unas 2.010 llamadas, unos 35 minutos. Si no los necesitas, `--no-tags --no-custom-fields` lo baja a 10 llamadas.
- **El orden** es por `id` ascendente.

### `funnelchat conversations export`

Los mensajes de cada conversación (el historial de cada contacto), en partes JSONL, con `conversations.jsonl` y un manifiesto.

```bash
funnelchat conversations export --output-dir ./conversaciones
funnelchat conversations export --since 2026-10-01 -o ./octubre
funnelchat conversations export --contact 2001 --contact 2002 -o ./dos-clientes
funnelchat conversations export --device 3 --part-size 10000 -o ./ventas
```

```
Exportando conversaciones a /Users/ana/octubre
  conversaciones: 340
  conversación 1 de 340 (contacto 2001): 128 mensajes · total 128
  …
Exportación completa: 340 conversaciones y 21.450 mensajes en 1 parte, en /Users/ana/octubre.
```

| Opción | Qué hace |
|---|---|
| `-o`, `--output-dir <carpeta>` | Una carpeta nueva o vacía. Por defecto, `funnelchat-conversations-export-<fecha>`. |
| `--since <fecha>` | Conversaciones y mensajes **creados o modificados** desde esa fecha. `AAAA-MM-DD` es desde las 00:00 UTC; también acepta fecha y hora con zona (`2026-10-01T09:00:00-03:00`). |
| `--contact <id>` | Solo la conversación de ese contacto (el `id` de la API). Se puede repetir o separar con comas. |
| `--device <id>` | Solo las conversaciones de ese número, y de ellas solo sus mensajes. |
| `--part-size <n>` | Mensajes por parte. Por defecto, 50.000. |
| `--resume` | Retoma una exportación cortada. Ver [Retomar](#retomar). |

Lo que queda en la carpeta:

```
octubre/
├── conversations.jsonl     una conversación por línea, como la devuelve GET /api/v1/conversations
├── messages-00001.jsonl    un mensaje por línea, como lo devuelve GET /api/v1/contacts/{contactId}/messages
├── messages-00002.jsonl
└── manifest.json
```

- **El orden:** las conversaciones en el orden de `conversations.jsonl`, de la de actividad más vieja a la más nueva; dentro de cada una, del mensaje más nuevo al más viejo (así los devuelve la API).
- **Una parte se cierra al terminar una página**, así que puede pasarse de `--part-size` hasta en 100 mensajes.
- **`--since` filtra por fecha de modificación**, no de envío: un mensaje viejo cuyo estado cambió después de esa fecha también entra. La API no tiene un filtro «hasta».
- **`--device`** elige las conversaciones del lado de la API (`deviceId`); los mensajes los filtra la CLI, porque la API no filtra mensajes por número.
- **Si un contacto se borra** mientras se exporta, se saltea y queda contado en el manifiesto (`vanished_contacts`).

### `funnelchat templates list`

Tus plantillas de WhatsApp, con su estado y su número.

```bash
funnelchat templates list --device 3 --status APPROVED
```

```
id  nombre      idioma  categoría  estado    número
45  bienvenida  es      UTILITY    APPROVED  3
```

### `funnelchat mac status`

Cuántos contactos activos del mes (MACs) llevas en el período, el límite y cuántos te quedan. Si tu cuenta tiene el control de MAC por contacto, también cuántos contactos quedaron inactivos: a esos la API no les deja mandar mensajes con clave (`429 mac_lockout_24h`).

```bash
funnelchat mac status
```

```
MACs del período: 120 de 1.000 (12 %) · quedan 880
  estado normal · control del tope activado
```

## Las exportaciones

> **Datos personales.** Lo que exportas tiene datos personales de tus contactos: nombres, teléfonos y mensajes. Guárdalo en un lugar seguro, no lo compartas sin necesidad y bórralo cuando ya no lo uses.

### Archivos que se pueden verificar

- **Nada se escribe con su nombre final hasta que está completo:** cada archivo se escribe como `<nombre>.part` y recién al terminar toma su nombre.
- **Nunca se pisa un archivo:** la carpeta tiene que ser nueva o estar vacía, y el nombre final se toma de una forma que falla si alguien creó ese archivo mientras tanto.
- **El manifiesto** (`manifest.json`) dice qué se exportó, de dónde y cómo verificarlo. Nunca incluye tu clave.

```json
{
  "manifest_version": 1,
  "kind": "conversations",
  "generator": { "name": "funnelchat-cli", "version": "0.1.0" },
  "api": { "base_url": "https://api.funnelchat.com", "spec": { "commit": "0ef4abb…", "sha256": "8bbbae5…" }, "routes": [ … ] },
  "started_at": "2026-10-16T12:00:00.000Z",
  "finished_at": "2026-10-16T12:41:10.000Z",
  "runs": 2,
  "api_calls": 1873,
  "options": { "contact_ids": [], "device_id": null, "since": "2026-10-01T00:00:00+00:00", "part_size": 50000 },
  "range": { "since": "2026-10-01T00:00:00+00:00", "until": null, "observed_first_message_time": "2026-10-01 08:12:44", "observed_last_message_time": "2026-10-16 11:58:02" },
  "counts": { "conversations": 340, "messages": 21450, "message_parts": 1, "vanished_contacts": 0 },
  "files": [
    { "path": "conversations.jsonl", "rows": 340, "bytes": 182044, "sha256": "…" },
    { "path": "messages-00001.jsonl", "rows": 21450, "bytes": 9811230, "sha256": "…" }
  ],
  "notes": [ "…" ]
}
```

Para verificar una parte:

```bash
shasum -a 256 octubre/messages-00001.jsonl    # en Linux: sha256sum
```

`runs` dice cuántas veces se corrió (1 más una por cada `--resume`) y `observed_*_message_time` es el campo `time` de los mensajes, tal como lo devuelve la API (sin zona horaria).

### Retomar

Si una exportación se corta (Ctrl+C, la red, un límite de la API), lo exportado hasta la última página completa queda guardado y la CLI te dice cómo seguir:

```
error: No se pudo conectar con la API de Funnelchat (api.funnelchat.com).
  Revisa tu conexión y la URL base, y vuelve a intentar.
  Lo exportado hasta la última página completa quedó guardado. Para seguir desde ahí:
  funnelchat contacts export --output-dir ./contactos --resume
```

```bash
funnelchat contacts export --output-dir ./contactos --resume
```

- **No se repite ninguna fila:** el estado se guarda después de cada página, y al retomar se descarta lo que se haya escrito después del último guardado.
- **Con `--resume` no hace falta repetir las opciones:** se usan las de la exportación original. Si pasas una distinta, la CLI no sigue (para no mezclar dos exportaciones distintas en una carpeta). Retómala con la misma clave y la misma URL base.
- **El estado** vive en `<carpeta>/.funnelchat-export.json` mientras la exportación no termina. Se borra al terminar.
- **Si se borran contactos mientras se exporta**, la paginación por número de página de `GET /api/v1/contacts` puede saltear alguno: compara `counts.contacts` con `counts.api_total_at_start` en el manifiesto.

## Ser buen ciudadano con la API

- **Ritmo bajo:** como máximo 1 llamada por segundo, reintentos incluidos. Lo cambias con `--rate` (mayor que 0 y hasta 10; `0.5` es una cada dos segundos) o `FUNNELCHAT_RATE`. Los límites por minuto de la API se cuentan por usuario y tu panel los comparte: súbelo con cuidado.
- **`429` y `503`:** la CLI espera exactamente lo que dice `Retry-After` y reintenta. Si pide más de 60 segundos (`--max-wait` lo cambia), corta con código `5` y te dice cuándo se reinicia.
- **Errores del servidor y de red:** reintenta con espera exponencial (1 s, 2 s, 4 s… hasta 30 s), hasta 4 veces; también un `502 origin_unreachable` de la entrada de la API. **Solo reintenta lecturas**; la CLI no hace otra cosa. Un `500 edge_misconfigured` no se reintenta: es un problema de configuración de nuestro lado y esperar no lo arregla.
- **El tope diario:** accounts y communities admiten hasta 10.000 llamadas por día por clave, cada una por su lado; conversations no tiene tope diario. Las exportaciones de contactos y conversaciones usan solo conversations; `whoami` y `numbers` usan accounts. Si se alcanza, la CLI corta con un mensaje claro y la hora del reinicio, y la exportación queda para retomar.

## Para scripts

**`--json`** en cualquier comando: el resultado sale en stdout como un solo documento JSON; el progreso y los avisos van a stderr. Un error es un objeto JSON en stderr:

```json
{"error":{"code":"daily_cap_exceeded","message":"Se alcanzó el tope diario de llamadas de accounts para esta clave. Se reinicia en 8 h 30 min (a las 20:30 UTC del 2026-10-16).","hint":"Id del pedido (X-Request-Id): 3f6c1a52-8d0e-4b7a-9c1e-5a2b7d4e9f10. Cítalo, con la hora aproximada, si lo reportas a soporte.","exit_code":5,"status":429,"route":"GET /api/v1/devices","api_error":"daily_cap_exceeded","retry_after":30600,"request_id":"3f6c1a52-8d0e-4b7a-9c1e-5a2b7d4e9f10","resets_at":"2026-10-16T20:30:00.000Z"}}
```

**El id del pedido.** Cada respuesta de la API trae `X-Request-Id`, también los errores. La CLI lo muestra en cada error que vino de la API (en `request_id` con `--json`) y en cada respuesta con `--verbose`. Si reportas un problema, cítalo junto con la hora aproximada: con ese id soporte encuentra la llamada. Un error de red no tiene id: la API nunca respondió.

**Otras opciones globales:** `-q`/`--quiet` (sin progreso), `-v`/`--verbose` (cada pedido a la API, con método, URL, código, tiempo y `X-Request-Id`; nunca la clave).

### Códigos de salida

| Código | Qué pasó |
|---|---|
| `0` | Todo bien. |
| `1` | Un error inesperado. |
| `2` | Uso incorrecto: una opción o un valor inválido, o `--resume` con opciones distintas de las originales. |
| `3` | Sin clave, una clave que la API rechaza (`401`) o sin el permiso que pide la ruta (`403`). |
| `4` | No existe en tu cuenta (`404`), o la ruta no existe en la API (`404 route_not_found`). |
| `5` | Un límite de la API que la CLI no espera sola: el tope diario o un `Retry-After` largo. Se puede retomar. |
| `6` | La API falló (`5xx`, `422`…) o no se pudo conectar, después de los reintentos. |
| `7` | La salida ya existe: la CLI nunca pisa un archivo. |
| `130` | Interrumpido con Ctrl+C. Una exportación se puede retomar. |

## Lo que la API todavía no permite

La CLI usa solo rutas que existen en la especificación pública (`spec/routes-used.json` las lista y la generación falla si una no está). Lo que buscamos y no está:

- **Una exportación del lado del servidor** (como la de otras plataformas): por eso la CLI pagina.
- **Un listado de mensajes de toda la cuenta:** solo existe el historial por contacto, así que la CLI recorre las conversaciones y pide el de cada una.
- **Un filtro «hasta»** en conversaciones y mensajes, ni un filtro por fecha de envío: solo `updated_since`, por fecha de modificación.
- **Un filtro por número en los mensajes:** con `--device` filtra la CLI.
- **Etiquetas y campos en el listado de contactos:** se piden contacto por contacto.
- **Un filtro de contactos por fecha de modificación,** para una exportación incremental de contactos: solo hay fecha de alta.
- **Métricas de mensajes** (enviados, entregados y leídos por día), ni de la cuenta ni por plantilla.
- **Los datos de la propia clave** (su nombre y sus permisos): `whoami` muestra la cuenta, no la clave.

## Lo que viene

- **`templates metrics`**: lo que Meta informa de cada plantilla por día (enviados, entregados, leídos, clics y costo). Vuelve a la CLI cuando la API tenga la ruta en producción (`GET /api/v1/templates/{template}/metrics`, hoy en un cambio de conversations sin desplegar). Se sacó el 22-10 para limitarse a lo que la API ya tiene.

## De dónde sale la especificación

`spec/funnelchat.json` es la instantánea unificada del portal (developers-portal, rama `feat/openapi-unificada` @ `0ef4abb`, mergeada en `main` el 2026-10-21), armada con las instantáneas de los dominios del 13-10. El 22-10 se revisó cada comando contra el código en producción (conversations `v1.18.10`, accounts `v1.4.24`, api-edge `v0.3.0`): las rutas y los parámetros que usa la CLI no cambiaron.

## Desarrollo

```bash
npm install
npm test              # sin red ni claves reales
npm run lint && npm run typecheck
npm run build
```

Para desarrollar necesitas Node 20 o posterior (por las herramientas de tests); la CLI que se construye corre en Node 18.

**Los tests** usan respuestas simuladas, con las mismas formas que la API (páginas por número y por cursor). Cubren la paginación, retomar, los `429`, que la clave no aparezca en ninguna salida ni en ningún archivo, que no se pise un archivo y el SHA-256 del manifiesto.

**De punta a punta contra el sandbox.** Con un checkout de [funnelchat-sandbox](https://github.com/Funnelchat20/funnelchat-sandbox) ya construido (`npm install && npm run build` en su carpeta), este test lo levanta en el mismo proceso, en un puerto libre, y corre la CLI contra él. No toca el repo del sandbox:

```bash
FUNNELCHAT_SANDBOX_DIR=../funnelchat-sandbox npm run test:e2e
```

Sin esa variable, `npm test` lo saltea.

**La especificación.** Se copia y se regenera con un solo script, que guarda de dónde salió en `spec/procedencia.json` y comprueba que cada ruta y cada parámetro que usa la CLI existan:

```bash
npm run generate -- --spec ../developers-portal/out/specs/funnelchat.json   # una instantánea nueva
npm run generate                                                             # regenerar
npm run generate:check                                                       # ¿está al día?
```

`spec/pending.json` es para una ruta que todavía no está en la instantánea; hoy está vacío. Cuando una instantánea nueva trae una ruta de ahí, la generación avisa que se puede borrar.

## Licencia

MIT. Ver [LICENSE](LICENSE).
