# @funnelchat-hq/cli

The Funnelchat CLI. **Connect a WhatsApp number, send a message and watch it get read**, in three commands, without writing code or a webhook:

```bash
npm install --global @funnelchat-hq/cli

funnelchat login                                        # 1. paste your API key; it is not shown
funnelchat connect                                      # 2. open the link it prints and scan the QR with WhatsApp
funnelchat send 5491122334455 "Hello from Funnelchat"   # 3. and watch it: queued → sent → delivered → read
```

```
Sending to 5491122334455 from Support (5491100000002)…
  queued
  sent       after 1 s
  delivered  after 2 s
  read       after 14 s
Message 98765 to 5491122334455: read 14 s after sending.
```

The phone does not need to be a contact yet: the send creates it. Send it to your own phone to see it arrive.

**Handing it to an AI agent?** Agents are good at running commands. Three things help them: `funnelchat api list --json` gives them every function of the API to call ([Using it from an AI agent](#using-it-from-an-ai-agent)), `funnelchat connect --no-wait` prints the link and ends at once (the agent shows it to you, and `funnelchat numbers list` says when the number is connected), and `--json` on any command gives one JSON document to read.

**Already have a number in Funnelchat?** Look first with `funnelchat numbers list`. If one is connected, use it: `send` takes it. If it is disconnected, `funnelchat connect --device <id>` reconnects that same number, without adding another. With none, connect yours by QR (`funnelchat connect`) or ask for a US number of Funnelchat on the official WhatsApp API (`funnelchat connect --us-number`).

The same key also **follows your WhatsApp groups** (`funnelchat groups`), **exports your conversations and your contacts** to files you can verify, and checks your numbers, templates and MACs:

```bash
funnelchat groups                                       # the groups of your number, as WhatsApp has them
funnelchat contacts export --output-dir ./my-contacts
funnelchat conversations export --since 2026-10-01 --output-dir ./october
```

And it **calls any other function of the API**, from the spec it carries: `funnelchat api list` lists them by group, and `funnelchat api <function>` calls one.

```bash
funnelchat api list difusiones                          # the functions about broadcasts
funnelchat api broadcast.index --perPage 50             # call one: the answer, as JSON
```

> **Status: v0.** The public API is at v0 and may change. The CLI uses only what the developer portal publishes, which is what an API key can use in production ([Where the spec comes from](#where-the-spec-comes-from)). The API reference is on the [developer portal](https://developers-portal.funnelchat.app/docs/).

## What it does and what it does not

- **It writes only when you ask it to.** `connect` creates a connect link, `send` sends a message (and creates the contact if the phone is new), `groups follow` imports a group into your account, and `funnelchat api` calls the function you name, which writes if it is not a `GET`. Every other command only reads: each call it makes is a `GET`.
- **What cannot be undone asks first.** A function of `funnelchat api` that the spec marks as not undoable asks you to confirm it; without a terminal, it needs `--yes`.
- **A write is sent once.** The CLI never repeats it on its own; if the network fails halfway, it says the write may have arrived, so you can check before repeating it.
- **It exports by paging through the public API**, because the API has no server-side export. A large account takes a while: the CLI goes at a low pace on purpose, so it does not slow down your panel.
- **It never stores or shows your key** anywhere except your configuration file, if you use `funnelchat login`.

## Installation

You need Node 18 or later.

```bash
npm install --global @funnelchat-hq/cli
funnelchat --version
```

Or without installing it: `npx @funnelchat-hq/cli --version`.

### An export example

```bash
funnelchat login                                   # paste your key; it is not shown
funnelchat whoami                                  # which account it belongs to
funnelchat contacts export --output-dir ./my-contacts
```

It leaves `my-contacts/contacts.csv` and `my-contacts/manifest.json`, with the SHA-256 of every file.

### From the source

```bash
git clone https://github.com/Funnelchat20/funnelchat-cli.git
cd funnelchat-cli
npm install
npm run build
npm link            # makes the `funnelchat` command available in your terminal
```

Without `npm link`, run `node dist/cli.js` instead of `funnelchat`.

## Authentication

The CLI uses an API key of your account: `<id>|fc_live_...`, complete, as the **Developers** screen shows it when you create it. The permission each command needs:

| Command | Permission |
|---|---|
| `connect` | `accounts:operate` (WhatsApp numbers → Create, connect and delete) and `accounts:read` to wait for the number; with `--device`, `accounts:read` always (to know how the number connects) |
| `send` | `conversations:send`; to a phone that is not a contact yet, `conversations:write` (it creates the contact); `conversations:read` to watch the status; `accounts:read` to pick the number without `--device` |
| `groups` | `communities:read`; `accounts:read` without `--device` |
| `groups follow` | `communities:operate` (Groups and campaigns → Manage groups); `accounts:read` without `--device` |
| `contacts export`, `conversations export`, `templates`, `mac status` | `conversations:read` |
| `whoami`, `numbers` | `accounts:read` |
| `api <function>` | the one the function says: `funnelchat api <function> --help`, or `permission` in `funnelchat api list --json` (`api list` itself makes no call) |

For the first use, a key with **WhatsApp numbers** (view and connect) and **Contacts and conversations** (view, edit and send) is enough.

There are two ways to give it the key:

**With an environment variable**, for scripts and servers:

```bash
export FUNNELCHAT_API_KEY='<id>|fc_live_...'   # in quotes: it contains a |
funnelchat whoami
```

**With `funnelchat login`**, which saves it in your configuration file with `0600` permissions (only you can read it):

```bash
funnelchat login
# Paste your Funnelchat API key (it is not shown) and press Enter:
```

```
Key saved in the "default" profile (/Users/ana/.config/funnelchat/config.json, 0600 permissions).
Account: Acme
```

Before saving it, `login` checks it against `GET /api/v1/me`: if the API rejects it, it is not saved. It also reads it from standard input (`funnelchat login < key.txt`). The CLI **never** takes the key from a command-line option, so it does not end up in your shell history.

**Which key it uses.** With `--profile`, that profile's. Otherwise `FUNNELCHAT_API_KEY`, if it is set. Otherwise the active profile's (the last one you ran `login` with, or `FUNNELCHAT_PROFILE`).

**Profiles.** For several accounts or environments:

```bash
funnelchat login --profile client-b
funnelchat login --profile testing --staging
funnelchat profiles                 # lists the profiles, never the keys
funnelchat profiles use client-b    # chooses the active one
funnelchat --profile testing whoami
funnelchat logout --profile testing # deletes that profile's key
```

**The base URL.** By default, `https://api.funnelchat.com`. `--staging` uses `https://api-staging.funnelchat.com`; `--base-url` (or `FUNNELCHAT_BASE_URL`) any other, always `https`. `http` is accepted only for your own machine, for example the [sandbox](https://github.com/Funnelchat20/funnelchat-sandbox):

```bash
FUNNELCHAT_API_KEY='1|fc_live_sandbox' funnelchat --base-url http://127.0.0.1:4010 contacts export
```

**The configuration file** is at `~/.config/funnelchat/config.json` (or in `$XDG_CONFIG_HOME/funnelchat/`, or in `%APPDATA%\funnelchat\` on Windows; `FUNNELCHAT_CONFIG_DIR` changes it). If other users of your machine can read it, the CLI warns you.

## Commands

Every command takes `--json` for use from scripts and `--help` to see all its options.

### `funnelchat connect`

Connects a WhatsApp number to your account by QR code. It creates a connect link (`POST /api/v1/connect-links` with `type: "qr"`), prints it, and waits until the number is connected. With `--us-number`, the link gives a new US number of Funnelchat instead; with `--device <id>`, it reconnects a number you already have.

```bash
funnelchat connect
```

```
Open this link, tap the button and scan the QR code with WhatsApp on the phone you are connecting (Linked devices → Link a device):

  https://…

It works once and expires at 2026-11-05T21:00:00+00:00; after tapping the button there are 10 minutes to scan the QR.
Whoever has the link can connect a number to your account: do not share it.

Waiting for the number to connect… (Ctrl+C to stop)
Connected: Support (5491100000002), id 4.
Send a first message: funnelchat send <phone> "Hello from Funnelchat"
```

| Option | What it does |
|---|---|
| `--no-wait` | Prints the link and ends, without waiting. For scripts and agents: `funnelchat numbers list` then shows when the number is connected. |
| `--timeout <seconds>` | How long to wait for the number. By default, 900 (15 minutes). |
| `--us-number` | A new US number of Funnelchat on the official WhatsApp API, instead of a QR. |
| `--device <id>` | Reconnects that number of your account, with a link of its own type. It never adds a number. Not with `--us-number`. |

- **The link** is a page on Funnelchat's domain. Opening it does not use it; tapping its button creates the number and shows the QR, which renews itself every 5 seconds. Treat it as a secret: it comes only in this answer, and whoever has it can connect a number to your account.
- **How it knows:** it lists your numbers before creating the link and then every 5 seconds (`GET /api/v1/devices`), and stops at the first one that was not connected before. Each listing counts toward the daily cap of accounts (about 180 calls in 15 minutes, of 10,000 a day).
- **With `--json`**, the link goes to stderr as soon as it exists, and stdout gets one document at the end, with the link and the number.
- **No QR in the terminal:** the page shows the QR that WhatsApp scans.
- If nobody scans the QR within 10 minutes of tapping the button, the link fails and the number it created is deleted: run `funnelchat connect` again. If the CLI stops waiting before (`--timeout`, exit code `8`, or Ctrl+C), the link still works until it expires.

**A US number of Funnelchat** (`--us-number`): the link is `type: "meta"` with `allowed_connection_types: ["dedicated"]` and `provision_us_number: true`.

```bash
funnelchat connect --us-number
```

- **On the page,** the person taps the button to use a Funnelchat US number and logs in with Facebook (Meta's signup, the same as the panel's). The number is new and dedicated to the API (it is not in the WhatsApp Business app).
- **Meta charges its messages** to the payment method of the WhatsApp Business account: it has to be added in Meta.
- If the Facebook login or Meta fails, the same link can be tried again, up to 5 failed attempts.
- **It is an official number:** free text only reaches a contact who wrote to it in the last 24 hours (`422 window_closed` otherwise), so write to it first from the phone you send to.
- Connecting an official number of your own by Facebook is done from the panel.

**Reconnecting a number** (`--device <id>`): the link carries `device_id`, so it reconnects that number and takes no new place.

```bash
funnelchat numbers list            # the id, and whether it is connected
funnelchat connect --device 4
```

- **Of its own type:** a number connected by QR gets a QR link (`type: "qr"`); an official one gets a Facebook link (`type: "meta"`, with its connection, `coexistence` or `dedicated`, as `allowed_connection_types`). The CLI lists your numbers first to know which, even with `--no-wait`.
- **Already connected:** the CLI says so and creates no link (exit code `0`).
- **Not one of your numbers:** exit code `4`, and no link is created.
- The wait ends when that number is connected.

### `funnelchat send <phone> <text>`

Sends a text message to a phone and shows its status live, until it is `read`, it `failed` or `--timeout` ends.

```bash
funnelchat send 5491122334455 "Hello from Funnelchat"
funnelchat send "+54 9 11 2233-4455" "Hello" --device 4 --timeout 300
```

| Option | What it does |
|---|---|
| `--device <id>` | The number it sends from. By default, the only connected number of your account; with several, the CLI asks for this. |
| `--timeout <seconds>` | How long to watch the status. By default, 90. `0` sends and does not watch. |

- **The phone**, with its country code. Spaces, dashes, dots, parentheses and a leading `+` are dropped; a phone with spaces goes in quotes, so that it reaches the CLI as one argument. It does not need to be a contact yet: the send creates it (`POST /api/v1/message/send-message`, with `device_id`, `phone` and `text`).
- **The status:** `queued` (in line, not sent yet), `sent`, `delivered` and `read`, or `failed` with the reason. The CLI reads it with `GET /api/v1/contacts/{contact}/messages/{message}`, 1 second after each change and then less and less often (2 s, 4 s… up to 10 s). If the recipient turned read receipts off, it stays `delivered`.
- **Exit codes:** `0` when it is read, or still on its way when `--timeout` ends; `6` when it failed (`code` `message_failed`, with the reason in `--json`). Ctrl+C stops watching (`130`); the message was already sent.
- **On an official number** (WhatsApp Cloud API), free text only goes out within 24 hours of the contact's last message, so the first message to a new contact has to be a template: the API answers `422 window_closed` and nothing is sent. A number connected by QR has no such window.
- **Rejections say what happened in plain words,** and that nothing was sent when the API guarantees it: `window_closed`, `recipient_mismatch`, `antiblock_*`, `device_unavailable`, `403` (the permission missing) and `429` (how long to wait). A send is never repeated on its own.
- **With `--json`**, one document with the message, every status with the seconds it took, and `outcome`: `read`, `timeout`, `unknown` (the provider never confirmed it: it will not change) or `not_watched`.

### `funnelchat groups`

The WhatsApp groups of a number connected by QR, as WhatsApp has them, and which ones you follow.

```bash
funnelchat groups
funnelchat groups --device 4
```

```
uid                         name           followed
120363000000000001@g.us     Launch Nov     yes
120363000000000002@g.us     Clients VIP    no
```

- **Live:** `GET /api/v1/devices/{device}/groups` reads them from WhatsApp, and reuses the list for up to a minute per number: a group just created can take that long to show.
- **The number:** `--device`, or the only number of your account connected by QR.

### `funnelchat groups follow <group>`

Follows a group: imports it to your account, as importing it from the panel does. From then on, who joins and who leaves arrives as the `group_participant.joined` and `group_participant.left` webhook events.

```bash
funnelchat groups follow 120363000000000002@g.us
```

```
Following "Clients VIP" (120363000000000002@g.us).
Who joins and who leaves arrives as the group_participant.joined and group_participant.left webhook events.
```

- `<group>` is the `uid` that `funnelchat groups` shows. A group already followed says so, and nothing changes.
- **Only numbers connected by QR** (`422 provider_unsupported` otherwise), and up to 5 groups per number per minute (`429 import_rate_limited`). If the number is not an admin of the group, the CLI warns you: it can follow it, but not send messages to it or manage it.
- `POST /api/v1/groups/{group}/import` with `device_id`; it needs `communities:operate` (Groups and campaigns → Manage groups).

### `funnelchat whoami`

Which account the key belongs to, without showing the key.

```bash
funnelchat whoami
```

```
Account: Acme
  id 42 · role owner · time zone America/Argentina/Buenos_Aires · language es
Key: from the FUNNELCHAT_API_KEY variable (not shown)
Base URL: https://api.funnelchat.com
```

It shows only these fields of `GET /api/v1/me`: id, name, role, time zone, language and the number and agent limits. With an API key that route brings neither the owner's email nor phone, nor a session token, and a field outside that list never shows, not even with `--json`.

### `funnelchat numbers list`

Your numbers, with their connection and what the CLI can export or read for each one. Useful to choose what to export.

```bash
funnelchat numbers list
```

```
id  alias    number         connection  connected  health     what the CLI reads
3   Sales    5491100000001  official    yes        AVAILABLE  contacts, conversations, templates, health and limit
4   Support  5491100000002  QR          yes        -          contacts, conversations
```

The CLI works out "what the CLI reads" from the connection type (`provider`): official numbers (WhatsApp Cloud API) have templates and health; QR ones do not. With `--json` it comes as `cli_capabilities`. The `capabilities` field of each number is something else: what the API can do with it (message types, groups, the statuses it reports), exactly as `GET /api/v1/devices` returns it.

### `funnelchat numbers health`

The health of your official numbers: state, quality, daily messaging limit and throughput, from the last data Funnelchat stored (it does not query Meta at that moment).

```bash
funnelchat numbers health        # every official number
funnelchat numbers health 3      # one
```

```
id  state      quality  limit    per day  throughput  updated                    stale
3   AVAILABLE  GREEN    TIER_1K  1,000    STANDARD    2026-10-16T10:00:00+00:00  no
```

### `funnelchat contacts export`

All your contacts, with their tags and their custom fields, as CSV (the default) or JSONL.

```bash
funnelchat contacts export --output-dir ./contacts
funnelchat contacts export --format jsonl --tag 4001 --created-from 2026-10-01 --created-to 2026-10-15 -o ./new-clients
```

```
Exporting contacts to /Users/ana/contacts
  contacts: 100 of 436
  …
Export complete: 436 contacts in /Users/ana/contacts/contacts.csv.
Manifest: /Users/ana/contacts/manifest.json (sha256 9f2c…)
```

| Option | What it does |
|---|---|
| `-o`, `--output-dir <dir>` | A new or empty folder. By default, `funnelchat-contacts-export-<date>`. |
| `--format csv\|jsonl` | CSV for spreadsheets (the default) or JSONL, one contact per line as the API returns it. |
| `--tag <id>` | Only contacts with that tag. It can be repeated (`--tag 1 --tag 2`) or comma-separated. |
| `--tag-mode any\|all\|exclude` | With several tags: any of them, all of them, or none of them. |
| `--created-from`, `--created-to` | Created between those dates (`YYYY-MM-DD`, both whole days). They go together: the API needs both. |
| `--only-with-phone` | Only contacts that can be messaged. |
| `--no-tags`, `--no-custom-fields` | Without tags or without fields: each one saves a call per contact. |
| `--resume` | Resumes an interrupted export. See [Resuming](#resuming). |

- **The CSV** has a column per contact field (`id`, `name`, `phone`, `email`, `whatsapp_id`, `country_code`, `created_at`, `lead_score`…), `tags` (the names, separated by `; `) and `tag_ids`, and a `custom_field:<name>` column for each custom field of your account. It has a UTF-8 BOM and CRLF line endings, so Excel shows accented characters correctly.
- **A cell that starts with `=`, `+`, `-` or `@`** (and is not a number) gets a `'` in front: your contacts write their own names, and this way your spreadsheet does not run them as formulas.
- **It takes longer with tags and fields:** the contacts listing does not include them, so the CLI makes two more calls per contact. At the default pace (1 per second), 1,000 contacts with everything are about 2,010 calls, about 35 minutes. If you do not need them, `--no-tags --no-custom-fields` brings it down to 10 calls.
- **The order** is by ascending `id`.

### `funnelchat conversations export`

The messages of every conversation (each contact's history), in JSONL parts, with `conversations.jsonl` and a manifest.

```bash
funnelchat conversations export --output-dir ./conversations
funnelchat conversations export --since 2026-10-01 -o ./october
funnelchat conversations export --contact 2001 --contact 2002 -o ./two-clients
funnelchat conversations export --device 3 --part-size 10000 -o ./sales
```

```
Exporting conversations to /Users/ana/october
  conversations: 340
  conversation 1 of 340 (contact 2001): 128 messages · total 128
  …
Export complete: 340 conversations and 21,450 messages in 1 part, in /Users/ana/october.
```

| Option | What it does |
|---|---|
| `-o`, `--output-dir <dir>` | A new or empty folder. By default, `funnelchat-conversations-export-<date>`. |
| `--since <date>` | Conversations and messages **created or changed** since that date. `YYYY-MM-DD` means from 00:00 UTC; it also takes a date and time with a zone (`2026-10-01T09:00:00-03:00`). |
| `--contact <id>` | Only that contact's conversation (the API's `id`). It can be repeated or comma-separated. |
| `--device <id>` | Only the conversations of that number, and of them only its messages. |
| `--part-size <n>` | Messages per part. By default, 50,000. |
| `--resume` | Resumes an interrupted export. See [Resuming](#resuming). |

What ends up in the folder:

```
october/
├── conversations.jsonl     one conversation per line, as GET /api/v1/conversations returns it
├── messages-00001.jsonl    one message per line, as GET /api/v1/contacts/{contactId}/messages returns it
├── messages-00002.jsonl
└── manifest.json
```

- **The order:** conversations in the order of `conversations.jsonl`, from the oldest activity to the newest; within each one, from the newest message to the oldest (that is how the API returns them).
- **A part closes at the end of a page**, so it can go over `--part-size` by up to 100 messages.
- **`--since` filters by modification date**, not by send date: an old message whose status changed after that date is included too. The API has no "until" filter.
- **`--device`** picks the conversations on the API side (`deviceId`); the CLI filters the messages, because the API does not filter messages by number.
- **If a contact is deleted** during the export, it is skipped and counted in the manifest (`vanished_contacts`).

### `funnelchat templates list`

Your WhatsApp templates, with their status and their number.

```bash
funnelchat templates list --device 3 --status APPROVED
```

```
id  name     language  category  status    number
45  welcome  es        UTILITY   APPROVED  3
```

### `funnelchat mac status`

How many monthly active contacts (MACs) you have used in the period, the limit and how many are left. If your account has per-contact MAC enforcement, also how many contacts became inactive: the API does not let you send them messages with a key (`429 mac_lockout_24h`).

```bash
funnelchat mac status
```

```
MACs in the period: 120 of 1,000 (12 %) · 880 left
  state normal · cap enforcement on
```

### `funnelchat api list [text...]`

Every function of the API the CLI knows, which are those the developer portal publishes (the spec the CLI carries, `spec/funnelchat.json`): by category and group, as the portal shows them in [Más funciones](https://developers-portal.funnelchat.app/docs/mas-funciones/), with their method, their path and what they do. With words, only the functions that mention all of them in their name, path, group, summary or purpose; accents do not matter (`numero` finds «número»). It makes no call to the API.

```bash
funnelchat api list                  # all of them
funnelchat api list difusiones       # only those that mention broadcasts
funnelchat api list --json           # name, method, path, summary, purpose, group, permission, whether it asks to confirm…
```

```
18 of 253 functions mention "difusiones". What one takes: `funnelchat api <function> --help`.

Funciones de Funnelchat · https://developers-portal.funnelchat.app/docs/mas-funciones/funnelchat/
  Automatizaciones
    contactAutomation.pause      POST    /api/v1/contacts/{contact}/pause              Pausar las automatizaciones de un contacto
  Difusiones
    broadcast.index              GET     /api/v1/broadcasts                            Ver tus difusiones
    broadcast.contacts           POST    /api/v1/broadcasts/contacts                   Buscar contactos para una difusión
    …
    broadcast.destroy            DELETE  /api/v1/broadcasts/{broadcast}                Borrar una difusión  (asks to confirm)
    …
```

The names and texts are the spec's. The name is the `operationId` (`GET /api/v1/me`, the one without it, is `me.get`). The category is the one of its group (`x-fc-categoria`), with the title and the page the portal gives it (`x-fc-categorias`): Primer uso, Funciones de WhatsApp and Funciones de Funnelchat. The summary and purpose are in Spanish, as the portal writes them.

### `funnelchat api <function>`

Calls one function of `api list`. `funnelchat api <function> --help` says what it takes, its permission and, at the end, an example.

```bash
funnelchat api broadcast.index --perPage 50 --orderBy created_at --orderByMethod desc
funnelchat api contact.show --contact 1001
funnelchat api message.sendMessage --field device_id=3 --field phone=5491122334455 --field text="Hello from Funnelchat"
funnelchat api tag.store --body @tag.json
funnelchat api device.destroy --device 12               # asks before; with --yes it does not
```

- **Path and query parameters are options**, with the name the spec gives them: `--contact 1001`, `--perPage 50`. One that takes several values is repeated: `--status 1 --status 2`. The path's are required.
- **The JSON body** goes field by field with `--field key=value` (repeatable), or whole with `--body`: inline JSON, `@file.json` or `@-` (standard input); `--field` adds to `--body`. Each value takes the type the spec gives its field: `device_id=3` is the number 3, `phone=5491122334455` is text, `note=true` a boolean, `[…]` and `{…}` are JSON, and repeating a field that takes a list makes the list (`--field mentions=7 --field mentions=8`). A field the body does not have stops the call before anything is sent.
- **The answer is printed as JSON**, as the API returns it. An answer without a body (`204`) prints nothing.
- **A listing pages** as the spec says: `--page` or `--cursor` for one page, or `--all` for every page, in a single JSON array (it asks for the largest page the spec allows).
- **A write** (a function that is not a `GET`) is sent once and never retried, like the rest of the CLI's.
- **What cannot be undone asks first.** A function the spec marks with `x-fc-destructive: true` (today: deleting a number, resetting its session or disconnecting it, emptying its message queue and deleting a custom domain), and a `DELETE` the spec does not mark either way, asks you to type `yes`. Without a terminal (a script, an agent) nothing is sent unless you add `--yes`: exit code `2`, `confirmation_required`.
- **Errors** are like every command's: the exit code by the status, and the `X-Request-Id` to quote.

The command has nothing written for any one function: it is generated from the spec. When the spec of the CLI changes, `funnelchat api` lists and calls what the new one has.

## Using it from an AI agent

Agents that work in a terminal are good at running commands, and `funnelchat` lets them use the whole API without code or an SDK:

1. **Find the function**: `funnelchat api list <words> --json` gives each function's name, method, path, what it is for, its group, its permission and whether it asks for confirmation. Without words, all of them.
2. **Learn what it takes**: `funnelchat api <function> --help` lists its options and body fields, with their types, the required ones and the allowed values, and ends with an example.
3. **Call it**: `funnelchat --json api <function> --<parameter> <value> --field <key>=<value>`. The answer goes to stdout as JSON; an error is one JSON object on stderr, with `code`, `exit_code`, `hint` and `request_id`.
4. **Confirm before what cannot be undone.** It is the rule an agent should follow anyway: ask the person before deleting or cancelling. Without `--yes`, the CLI refuses a function that cannot be undone and sends nothing (exit code `2`, `confirmation_required`); the agent shows the person what it is about to do, and adds `--yes` only after the person says yes.

Do not paste the key into the agent's chat: run `funnelchat login` yourself, or set `FUNNELCHAT_API_KEY` in its environment, with a key that has only the permissions the agent needs. Instructions like these are enough for an agent:

```
To work with Funnelchat, use the `funnelchat` CLI; the key is already configured.
- Find functions with `funnelchat api list <words> --json`, and read `funnelchat api <function> --help` before calling one.
- Call them with `funnelchat --json api <function> …`.
- A write is sent once: if it fails with a network error or a 5xx, check before repeating it.
- Never add --yes without asking me first.
```

## Exports

> **Personal data.** What you export holds your contacts' personal data: names, phone numbers and messages. Keep it somewhere safe, do not share it unless you need to, and delete it when you no longer use it.

### Files you can verify

- **Nothing gets its final name until it is complete:** each file is written as `<name>.part` and only takes its name at the end.
- **A file is never overwritten:** the folder must be new or empty, and the final name is taken in a way that fails if someone created that file in the meantime.
- **The manifest** (`manifest.json`) says what was exported, from where and how to verify it. It never includes your key.

```json
{
  "manifest_version": 1,
  "kind": "conversations",
  "generator": { "name": "@funnelchat-hq/cli", "version": "0.4.0" },
  "api": { "base_url": "https://api.funnelchat.com", "spec": { "source": "https://developers-portal.funnelchat.app/specs/funnelchat.json", "commit": null, "sha256": "a7b4807…" }, "routes": [ … ] },
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

To verify a part:

```bash
shasum -a 256 october/messages-00001.jsonl    # on Linux: sha256sum
```

`runs` says how many times it ran (1 plus one per `--resume`), and `observed_*_message_time` is the `time` field of the messages, as the API returns it (without a time zone).

### Resuming

If an export gets interrupted (Ctrl+C, the network, an API limit), what was exported up to the last complete page is saved and the CLI tells you how to continue:

```
error: Could not connect to the Funnelchat API (api.funnelchat.com).
  Check your connection and the base URL, and try again.
  What was exported up to the last complete page is saved. To continue from there:
  funnelchat contacts export --output-dir ./contacts --resume
```

```bash
funnelchat contacts export --output-dir ./contacts --resume
```

- **No row is repeated:** the state is saved after every page, and on resuming anything written after the last save is discarded.
- **With `--resume` there is no need to repeat the options:** the original export's are used. If you pass a different one, the CLI does not continue (so two different exports never mix in one folder). Resume it with the same key and the same base URL.
- **The state** lives in `<dir>/.funnelchat-export.json` while the export is not finished. It is deleted at the end.
- **If contacts are deleted during the export**, paging `GET /api/v1/contacts` by page number can skip some: compare `counts.contacts` with `counts.api_total_at_start` in the manifest.

## Being a good citizen with the API

- **Low pace:** at most 1 call per second, retries included. Change it with `--rate` (greater than 0 and up to 10; `0.5` is one every two seconds) or `FUNNELCHAT_RATE`. The API's per-minute limits are counted per user and your panel shares them: raise it carefully.
- **`429` and `503`:** the CLI waits exactly what `Retry-After` says and retries. If it asks for more than 60 seconds (`--max-wait` changes that), it stops with code `5` and tells you when it resets.
- **Server and network errors:** it retries with exponential backoff (1 s, 2 s, 4 s… up to 30 s), up to 4 times; also a `502 origin_unreachable` from the API's entry point. **It only retries reads**: a write (`connect`, `send`, `groups follow`, or an `api` function that is not a `GET`) is sent once, and a `429` on it says how long to wait. A `500 edge_misconfigured` is not retried: it is a configuration problem on our side and waiting does not fix it.
- **Waiting without hurry:** `connect` lists your numbers every 5 seconds; `send` reads the message 1 second after each change and then less and less often, up to every 10 seconds.
- **The daily cap:** accounts and communities allow up to 10,000 calls per day per key, each on its own; conversations has no daily cap. The contacts and conversations exports and the message of `send` use only conversations; `whoami`, `numbers`, `connect` and picking the number without `--device` use accounts; `groups` uses communities. With `funnelchat api`, the area is the function's (`domain` in `funnelchat api list --json`). If the cap is reached, the CLI stops with a clear message and the reset time, and the export can be resumed.

## For scripts

**`--json`** on any command: the result goes to stdout as a single JSON document; progress and warnings go to stderr. An error is a JSON object on stderr:

```json
{"error":{"code":"daily_cap_exceeded","message":"The daily cap of calls to accounts was reached for this key. It resets in 8 h 30 min (at 20:30 UTC on 2026-10-16).","hint":"Request id (X-Request-Id): 3f6c1a52-8d0e-4b7a-9c1e-5a2b7d4e9f10. Quote it, with the approximate time, if you report this to support.","exit_code":5,"status":429,"route":"GET /api/v1/devices","api_error":"daily_cap_exceeded","retry_after":30600,"request_id":"3f6c1a52-8d0e-4b7a-9c1e-5a2b7d4e9f10","resets_at":"2026-10-16T20:30:00.000Z"}}
```

**The request id.** Every answer of the API carries `X-Request-Id`, errors included. The CLI shows it in every error that came from the API (in `request_id` with `--json`) and on every answer with `--verbose`. If you report a problem, quote it together with the approximate time: with that id support finds the call. A network error has no id: the API never answered.

**Other global options:** `-q`/`--quiet` (no progress), `-v`/`--verbose` (every request to the API, with method, URL, status, timing and `X-Request-Id`; never the key).

**The API's errors.** Every error of the API carries a stable code in `error` (the CLI's `code` and, with `--json`, `api_error`) and a text in `message`: `422 validation_failed` with the fields in `errors`, `404 not_found` (also for what belongs to another account: the API does not say whether it exists), `402 payment_required` when the account's payment is overdue (it is not retried: settle it in the panel), and `429 rate_limited` with `Retry-After`.

The CLI asks the API for its messages in Spanish (`Accept-Language: es`), so the `message` the API returns, which the CLI appends to some errors, comes in Spanish. Decide by the exit code and by `code`, not by the text.

### Exit codes

| Code | What happened |
|---|---|
| `0` | All good. |
| `1` | An unexpected error. |
| `2` | Wrong usage: an invalid option or value, or `--resume` with options different from the original ones; or an `api` function that cannot be undone, not confirmed (without a terminal, without `--yes`). |
| `3` | No key, a key the API rejects (`401`) or a key without the permission the route needs (`403`). |
| `4` | Not found in your account, or it belongs to another account (`404 not_found`); or the route does not exist in the API (`404 route_not_found`). |
| `5` | An API limit the CLI does not wait for on its own: the daily cap or a long `Retry-After`. It can be resumed. |
| `6` | The API failed (`5xx`, `422`…) or could not be reached, after the retries; the account's payment is overdue (`402 payment_required`); or the message `send` watched failed. |
| `7` | The output already exists: the CLI never overwrites a file. |
| `8` | `connect` waited `--timeout` and no number connected. |
| `130` | Interrupted with Ctrl+C. An export can be resumed. |

## What the API does not allow yet

The named commands use only routes that exist in the public spec (`spec/routes-used.json` lists them and the generation fails if one is missing), and `funnelchat api` only the operations of that spec. What we looked for and is not there:

- **A server-side export** (like other platforms have): that is why the CLI pages.
- **A listing of every message of the account:** only the per-contact history exists, so the CLI walks the conversations and asks for each one's.
- **An "until" filter** on conversations and messages, or a filter by send date: only `updated_since`, by modification date.
- **A filter by number on messages:** with `--device`, the CLI filters.
- **Tags and fields in the contacts listing:** they are requested contact by contact.
- **A filter of contacts by modification date,** for an incremental contacts export: there is only the creation date.
- **Message metrics for the whole account** (sent, delivered and read per day). Per template they are there now: `funnelchat api message.templateMetrics --template <id>` (what Meta reports, day by day, up to 90 days).
- **The key's own data** (its name and its permissions): `whoami` shows the account, not the key.

## Where the spec comes from

`spec/funnelchat.json` is the spec the developer portal publishes, <https://developers-portal.funnelchat.app/specs/funnelchat.json>, that of portal v0.6.15 (sha256 `3e5bc8ef…`): the operations and events the portal shows, which per the portal are those an API key can use in production. It has 253 operations and 57 webhook events, in three categories: Primer uso, Funciones de WhatsApp and Funciones de Funnelchat. It does not date the areas it is built from (its `x-fc-sources` carry no commit), so `spec/procedencia.json` records the URL and the portal's version, as declared, and the file's `sha256`. Since v0.6.15 it also declares, for each route, the errors of the common format (see [For scripts](#for-scripts)).

Every route, parameter and body field the named commands use is in it, `GET /api/v1/me` of `login` and `whoami` included: `spec/pending.json` stays empty. The catalog of `funnelchat api` (`src/generated/operations.ts`) is generated from it, and from it alone.

Before 0.4.0 the CLI carried the portal's full spec, which also had routes closed to keys. With the published one, 35 operations left the catalog and 23 came in. Among those that left: the legacy `webhooks/endpoints`, the logs of the numbers, `lead-score/events`, `extension-token`, the destinations of alerts and the campaign webhooks. Among those that came in: WhatsApp forms, bringing a number's templates from Meta and adding or removing tags in bulk. No named command used any of those that left.

## Development

```bash
npm install
npm test              # no network, no real keys
npm run lint && npm run typecheck
npm run build
```

To develop you need Node 20.19 or later (for the test tools); the CLI it builds runs on Node 18.

**The tests** use simulated answers, with the same shapes as the API (pages by number and by cursor). They cover paging, resuming, `429`s, that the key never shows up in any output or any file, that no file is overwritten, the manifest's SHA-256, and the first use: `connect` waiting for the number (also a US number and a reconnection), and `send` watching the status until it is read; and `funnelchat api`: listing, a read, a write with a body and the confirmation of what cannot be undone.

**End to end against the sandbox.** With an already built checkout of [funnelchat-sandbox](https://github.com/Funnelchat20/funnelchat-sandbox) (`npm install && npm run build` in its folder), this test starts it in the same process, on a free port, and runs the CLI against it. It does not touch the sandbox's repository:

```bash
FUNNELCHAT_SANDBOX_DIR=../funnelchat-sandbox npm run test:e2e
```

Without that variable, `npm test` skips it.

**The spec.** It is copied and regenerated with a single script, which records where it came from in `spec/procedencia.json`, checks that every route, every parameter and every body field the named commands use exists, and writes the catalog of `funnelchat api` (`src/generated/operations.ts`: every operation, with its category, group, parameters, body fields and `x-fc-destructive`). A new spec is a new catalog, with no code to change:

```bash
curl -sSfo funnelchat.json https://developers-portal.funnelchat.app/specs/funnelchat.json
npm run generate -- --spec funnelchat.json --expect-sha256 <hex> \
  --source url=https://developers-portal.funnelchat.app/specs/funnelchat.json \
  --source portal_version=<vX.Y.Z>                                             # a new spec
npm run generate                                                               # regenerate
npm run generate:check                                                         # is it up to date?
```

A spec downloaded from the portal is not a file of a checkout, so its copy says where it came from on the command line: `--source url=…`, `--source portal_version=…` (the portal's version, which the spec does not carry), `--expect-sha256 <hex>` to refuse a file that is not the one announced, and, for a file of a checkout of another repository, `--source repository=… --source branch=… --source commit=… --source path=…` and `--domain <area>=<sha>@<branch>@<snapshot_at>` for each area. `spec/procedencia.json` marks those fields as declared. Nothing else is touched by hand: a new spec is a new catalog, with its categories and groups.

`spec/pending.json` is for a route that is not in the snapshot yet; today it is empty. When a new snapshot has a route from there, the generation says it can be deleted.

**Checks.** Every pull request and every push to `main` runs lint, types, tests and build on Node 20.19, 22 and 24, and runs the built CLI on Node 18 (`.github/workflows/ci.yml`).

**Publishing.** Push a `vX.Y.Z` tag on a commit of `main` that matches the version in `package.json`; GitHub Actions runs lint, types and tests and publishes it through npm Trusted Publishing (`.github/workflows/publish.yml`). A tag whose commit is not on `main` fails before publishing. A pre-release tag (`vX.Y.Z-rc.N`, `vX.Y.Z-beta.N`) is published under the `next` dist-tag (`npm install @funnelchat-hq/cli@next`), never as the default version.

## License

MIT. See [LICENSE](LICENSE).
