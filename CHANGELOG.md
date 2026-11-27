# Changelog

## 0.7.0

The spec of the developer portal at `5c9ed62` (`v0.7.0-54-g5c9ed62`, sha256 `b98c53bd…`), of 27-11-2026: 260
operations (253 before). Campaigns and scheduled messages to groups are written with an API key.

- **7 new functions in `funnelchat api`:** `campaign.store`, `campaign.update`, `campaign.status` (activate or pause)
  and `campaign.destroy`; `scheduledMessage.store`, `scheduledMessage.update` and `scheduledMessage.destroy`
  (cancel). `funnelchat api <function> --help` says what each one takes.
- **Deleting a campaign and cancelling a scheduled message ask first:** the spec marks them with
  `x-fc-destructive: true` (25 functions now). Without a terminal and without `--yes`, nothing is sent.
- `send_at` of a scheduled message is text as the API takes it, in UTC: `--field send_at="2026-12-07 13:00:00"`.

## 0.6.0

The spec of the developer portal at `fe4df8d` (`v0.7.0-35-gfe4df8d`, sha256 `4a8fbaee…`): 253 operations, each one
saying with `x-fc-destructive` whether it can be undone.

- **What cannot be undone asks first, also by `POST` or `PUT`.** `funnelchat api contact.destroy --field all=true`
  used to delete every contact without asking. The 23 functions the spec marks with `x-fc-destructive: true` ask
  now (deleting contacts, tags, custom fields, templates, numbers or webhooks; cancelling a broadcast or a flow
  run…), and, as a safety net, so do a function named `.destroy…`, `.delete…` or `.cancel…`, a `DELETE` the spec
  does not mark and a body with `all=true`. Without a terminal and without `--yes`, nothing is sent: exit code `2`,
  `confirmation_required`.
- **Ctrl+C exits with `130`**, also in the middle of an export while the CLI waits between two calls (it used to
  end with `1` and «Unexpected error: aborted»). The export still says how to resume it.
- **The base URL of the profile wins over production when the key comes from `FUNNELCHAT_API_KEY`.** The order is
  `--base-url`, `FUNNELCHAT_BASE_URL`, the active profile's, and then production.
- **`send` without `--device` and several numbers** sends nothing and lists each number's id, label and connection
  (exit code `2`, `device_required`, with the numbers in `--json`), with the same command and `--device` as an
  example. Also `groups` and `groups follow`.
- **No link through Meta**, while production has it off (`503 meta_connect_disabled`): `connect --us-number` is
  gone (it now only says it is not available) and `connect --device` reconnects only numbers connected by QR. Both
  stop before creating anything, with exit code `2` and `meta_connect_unavailable`.
- `meta_connect_disabled`, `mac_lockout_24h` and `mac_limit_reached` no longer add «Funnelchat may have received
  it» or «wait and try again»: they say for sure that nothing was done.
- The end-to-end test runs against the sandbox 0.7.0, also one already running (`FUNNELCHAT_SANDBOX_URL`).

## 0.5.0

Opaque ids (portal v0.7.0): every id is text with a prefix by type. See «Migrating to 0.5.0» in the README.
