/**
 * `groups` and `groups follow` (communities: these calls count toward its daily cap of 10,000 per key).
 *
 * - `GET /api/v1/devices/{device}/groups` (communities:read): the number's groups as WhatsApp has them,
 *   also the ones not in the account yet; read live and reused for one minute per number. Pages of
 *   `pageSize` (at most 100 with a key). A group already in the account brings `device_id`.
 * - `POST /api/v1/groups/{group}/import` with `{device_id}` (communities:operate): follows the group as
 *   importing it in the panel does; from then on its joins and leaves arrive as webhook events. `201`
 *   when this call imported it, `200` when it was already in the account; `is_admin` either way. Only
 *   numbers connected by QR (`422 provider_unsupported`), 5 groups per number per minute (`429
 *   import_rate_limited`). Sent once: a write is never retried.
 *
 * Without `--device`, the only number of the account connected by QR.
 */
import { isRecord, usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { table } from '../output.js';
import { deviceLabel, pickDevice } from './numbers.js';

export interface GroupsFlags {
  device?: string;
}

const PAGE_SIZE = 100;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null);

export async function groupsList(ctx: Context, flags: GroupsFlags): Promise<void> {
  const picked = await pickDevice(ctx, flags.device, { qrOnly: true });
  const groups: Record<string, unknown>[] = [];
  for await (const group of ctx.client().all<Record<string, unknown>>(routes.deviceGroups, { path: { device: picked.id }, query: { pageSize: PAGE_SIZE } })) {
    groups.push(group);
  }
  const from = picked.device ? deviceLabel(picked.device) : `number ${picked.id}`;
  const device = flags.device !== undefined ? ` --device ${picked.id}` : '';
  ctx.out.result({ device_id: picked.id, groups }, () =>
    groups.length === 0
      ? `${from} is in no WhatsApp group (the list is reused for up to a minute: a group just created can take that long to show).`
      : [
          ...table(
            ['uid', 'name', 'followed'],
            groups.map((g) => [text(g.uid), text(g.name), text(g.device_id) ? 'yes' : 'no']),
          ),
          '',
          `Groups of ${from}, as WhatsApp has them (reused for up to a minute). Follow one with: funnelchat groups follow <uid>${device}`,
        ],
  );
}

export async function groupsFollow(ctx: Context, group: string, flags: GroupsFlags): Promise<void> {
  const uid = group.trim();
  if (uid === '') throw usageError('The group needs its uid, as `funnelchat groups` shows it.');
  const picked = await pickDevice(ctx, flags.device, { qrOnly: true });
  const body = await ctx.client().post(routes.groupImport, { path: { group: uid }, body: { device_id: picked.id } });
  const data = isRecord(body) && isRecord(body.data) ? body.data : isRecord(body) ? body : {};
  const name = text(data.name) ? `"${text(data.name)}" (${text(data.uid) ?? uid})` : (text(data.uid) ?? uid);
  if (data.is_admin === false) ctx.out.warn('the number is not an admin of this group: it cannot send messages to it or manage it.');
  ctx.out.result({ device_id: picked.id, group: data }, () => [
    data.imported === false ? `Already following ${name}: it was in your account.` : `Following ${name}.`,
    'Who joins and who leaves arrives as the group_participant.joined and group_participant.left webhook events.',
  ]);
}
