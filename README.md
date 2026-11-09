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

**Handing it to an AI agent?** Agents are good at running commands. Two things help them: `funnelchat connect --no-wait` prints the link and ends at once (the agent shows it to you, and `funnelchat numbers list` says when the number is connected), and `--json` on any command gives one JSON document to read.

**Already have a number in Funnelchat?** Look first with `funnelchat numbers list`. If one is connected, use it: `send` takes it. If it is disconnected, `funnelchat connect --device <id>` reconnects that same number, without adding another. With none, connect yours by QR (`funnelchat connect`) or ask for a US number of Funnelchat on the official WhatsApp API (`funnelchat connect --us-number`).

The same key also **follows your WhatsApp groups** (`funnelchat groups`), **exports your conversations and your contacts** to files you can verify, and checks your numbers, templates and MACs:

```bash
funnelchat groups                                       # the groups of your number, as WhatsApp has them
funnelchat contacts export --output-dir ./my-contacts
funnelchat conversations export --since 2026-10-01 --output-dir ./october
```

> **Status: v0.** The public API is at v0 and may change. The CLI uses only what the API has in production; what gets added later is in [Coming next](#coming-next). The API reference is on the [developer portal](https://developers-portal.funnelchat.app/docs/).

## What it does and what it does not

- **It writes only when you ask it to.** `connect` creates a connect link, `send` sends a message (and creates the contact if the phone is new) and `groups follow` imports a group into your account. Every other command only reads: each call it makes is a `GET`.
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
Account: Acme (hello@acme.example)
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
funnelchat send +54 9 11 2233-4455 "Hello" --device 4 --timeout 300
```

| Option | What it does |
|---|---|
| `--device <id>` | The number it sends from. By default, the only connected number of your account; with several, the CLI asks for this. |
| `--timeout <seconds>` | How long to watch the status. By default, 90. `0` sends and does not watch. |

- **The phone**, with its country code. Spaces, dashes, dots, parentheses and a leading `+` are dropped. It does not need to be a contact yet: the send creates it (`POST /api/v1/message/send-message`, with `device_id`, `phone` and `text`).
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
Account: Acme (hello@acme.example)
  id 42 · role owner · time zone America/Argentina/Buenos_Aires · language es
Key: from the FUNNELCHAT_API_KEY variable (not shown)
Base URL: https://api.funnelchat.com
```

It shows only these fields of `GET /api/v1/me`: id, name, email, role, time zone, language and the number and agent limits. That route also returns a session token: the CLI never shows it, not even with `--json`.

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
  "generator": { "name": "@funnelchat-hq/cli", "version": "0.3.0" },
  "api": { "base_url": "https://api.funnelchat.com", "spec": { "commit": "99928866…", "sha256": "0ffaad2…" }, "routes": [ … ] },
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
- **Server and network errors:** it retries with exponential backoff (1 s, 2 s, 4 s… up to 30 s), up to 4 times; also a `502 origin_unreachable` from the API's entry point. **It only retries reads**: a write (`connect`, `send`, `groups follow`) is sent once, and a `429` on it says how long to wait. A `500 edge_misconfigured` is not retried: it is a configuration problem on our side and waiting does not fix it.
- **Waiting without hurry:** `connect` lists your numbers every 5 seconds; `send` reads the message 1 second after each change and then less and less often, up to every 10 seconds.
- **The daily cap:** accounts and communities allow up to 10,000 calls per day per key, each on its own; conversations has no daily cap. The contacts and conversations exports and the message of `send` use only conversations; `whoami`, `numbers`, `connect` and picking the number without `--device` use accounts; `groups` uses communities. If the cap is reached, the CLI stops with a clear message and the reset time, and the export can be resumed.

## For scripts

**`--json`** on any command: the result goes to stdout as a single JSON document; progress and warnings go to stderr. An error is a JSON object on stderr:

```json
{"error":{"code":"daily_cap_exceeded","message":"The daily cap of calls to accounts was reached for this key. It resets in 8 h 30 min (at 20:30 UTC on 2026-10-16).","hint":"Request id (X-Request-Id): 3f6c1a52-8d0e-4b7a-9c1e-5a2b7d4e9f10. Quote it, with the approximate time, if you report this to support.","exit_code":5,"status":429,"route":"GET /api/v1/devices","api_error":"daily_cap_exceeded","retry_after":30600,"request_id":"3f6c1a52-8d0e-4b7a-9c1e-5a2b7d4e9f10","resets_at":"2026-10-16T20:30:00.000Z"}}
```

**The request id.** Every answer of the API carries `X-Request-Id`, errors included. The CLI shows it in every error that came from the API (in `request_id` with `--json`) and on every answer with `--verbose`. If you report a problem, quote it together with the approximate time: with that id support finds the call. A network error has no id: the API never answered.

**Other global options:** `-q`/`--quiet` (no progress), `-v`/`--verbose` (every request to the API, with method, URL, status, timing and `X-Request-Id`; never the key).

The CLI asks the API for its messages in Spanish (`Accept-Language: es`), so the `message` the API returns, which the CLI appends to some errors, comes in Spanish. Decide by the exit code and by `code`, not by the text.

### Exit codes

| Code | What happened |
|---|---|
| `0` | All good. |
| `1` | An unexpected error. |
| `2` | Wrong usage: an invalid option or value, or `--resume` with options different from the original ones. |
| `3` | No key, a key the API rejects (`401`) or a key without the permission the route needs (`403`). |
| `4` | Not found in your account (`404`), or the route does not exist in the API (`404 route_not_found`). |
| `5` | An API limit the CLI does not wait for on its own: the daily cap or a long `Retry-After`. It can be resumed. |
| `6` | The API failed (`5xx`, `422`…) or could not be reached, after the retries; or the message `send` watched failed. |
| `7` | The output already exists: the CLI never overwrites a file. |
| `8` | `connect` waited `--timeout` and no number connected. |
| `130` | Interrupted with Ctrl+C. An export can be resumed. |

## What the API does not allow yet

The CLI uses only routes that exist in the public spec (`spec/routes-used.json` lists them and the generation fails if one is missing). What we looked for and is not there:

- **A server-side export** (like other platforms have): that is why the CLI pages.
- **A listing of every message of the account:** only the per-contact history exists, so the CLI walks the conversations and asks for each one's.
- **An "until" filter** on conversations and messages, or a filter by send date: only `updated_since`, by modification date.
- **A filter by number on messages:** with `--device`, the CLI filters.
- **Tags and fields in the contacts listing:** they are requested contact by contact.
- **A filter of contacts by modification date,** for an incremental contacts export: there is only the creation date.
- **Message metrics** (sent, delivered and read per day), neither for the account nor per template.
- **The key's own data** (its name and its permissions): `whoami` shows the account, not the key.

## Coming next

- **`templates metrics`**: what Meta reports for each template per day (sent, delivered, read, clicks and cost). It comes back to the CLI when the API has the route in production (`GET /api/v1/templates/{template}/metrics`, today in an undeployed change of conversations). It was removed on 2026-10-22 to stick to what the API already has.

## Where the spec comes from

`spec/funnelchat.json` is the portal's full unified spec (developers-portal `main` @ `99928866`, deployed as v0.6.3 on 2026-11-05: `generated/specs/funnelchat-completa.json`, which carries every operation, not only the ones the portal shows), built from the snapshots of accounts `v1.5.97` (`558332bcf`), conversations `v1.19.21` (`f2937a713`) and communities `54643bbd` (the app code of `v2.35.7`). `spec/procedencia.json` says so, with the file's `sha256`. Every route, parameter and body field the CLI uses is in it: `spec/pending.json` stays empty.

## Development

```bash
npm install
npm test              # no network, no real keys
npm run lint && npm run typecheck
npm run build
```

To develop you need Node 20 or later (for the test tools); the CLI it builds runs on Node 18.

**The tests** use simulated answers, with the same shapes as the API (pages by number and by cursor). They cover paging, resuming, `429`s, that the key never shows up in any output or any file, that no file is overwritten, the manifest's SHA-256, and the first use: `connect` waiting for the number (also a US number and a reconnection), and `send` watching the status until it is read.

**End to end against the sandbox.** With an already built checkout of [funnelchat-sandbox](https://github.com/Funnelchat20/funnelchat-sandbox) (`npm install && npm run build` in its folder), this test starts it in the same process, on a free port, and runs the CLI against it. It does not touch the sandbox's repository:

```bash
FUNNELCHAT_SANDBOX_DIR=../funnelchat-sandbox npm run test:e2e
```

Without that variable, `npm test` skips it.

**The spec.** It is copied and regenerated with a single script, which records where it came from in `spec/procedencia.json` and checks that every route, every parameter and every body field the CLI uses exists:

```bash
npm run generate -- --spec ../developers-portal/generated/specs/funnelchat-completa.json   # a new spec
npm run generate                                                                           # regenerate
npm run generate:check                                                                     # is it up to date?
```

The portal's full spec is a build output git ignores, so a copy of it says where it came from on the command line, as funnelchat-node does: `--expect-sha256 <hex>`, `--source repository=… --source branch=… --source commit=… --source path=…` and `--domain <area>=<sha>@<branch>@<snapshot_at>` for each area. `spec/procedencia.json` marks those fields as declared.

`spec/pending.json` is for a route that is not in the snapshot yet; today it is empty. When a new snapshot has a route from there, the generation says it can be deleted.

**Publishing.** Push a `vX.Y.Z` tag on `main` that matches the version in `package.json`; GitHub Actions publishes it through npm Trusted Publishing (`.github/workflows/publish.yml`).

## License

MIT. See [LICENSE](LICENSE).
