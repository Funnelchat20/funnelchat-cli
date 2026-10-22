/**
 * `mac status`: `GET /api/v1/mac/status`, the MACs consumed in the period against the plan's limit.
 *
 * The answer has two shapes (conversations v1.18.10, MacController::status and MacService::getStatus):
 *
 * - an account outside the MAC rollout gets the neutral one, the only one the portal's spec documents:
 *   `current_count`, `limit`, `remaining`, `usage_percentage`, `state: normal`;
 * - an enrolled account gets `mac_count`, `cycle_capacity` (the cycle's MACs, plan plus packs),
 *   `total_available` (what is left, net of debt), `usage_percentage`, `alert_level`, `state` (`normal`,
 *   `grace`, `lockout`, or `enforcing` with per-contact enforcement), `grace` and, with per-contact
 *   enforcement, `inactive_contacts_count`.
 */
import { isRecord } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';

export async function macStatus(ctx: Context): Promise<void> {
  const body = await ctx.client().get(routes.macStatus);
  const status = isRecord(body) ? body : { value: body };
  const n = (value: unknown) => (typeof value === 'number' ? value.toLocaleString('es-AR') : '-');
  const count = status.current_count ?? status.mac_count;
  const limit = status.limit ?? status.cycle_capacity;
  const remaining = status.remaining ?? status.total_available;
  ctx.out.result({ mac: status }, () => [
    `MACs del período: ${n(count)} de ${n(limit)} (${n(status.usage_percentage)} %) · quedan ${n(remaining)}`,
    `  estado ${String(status.state ?? '-')} · control del tope ${status.enforcement_enabled === true ? 'activado' : status.enforcement_enabled === false ? 'desactivado' : '-'}`,
    ...(typeof status.inactive_contacts_count === 'number' ? [`  contactos inactivos por MAC: ${n(status.inactive_contacts_count)} (no reciben envíos con clave: 429 mac_lockout_24h)`] : []),
  ]);
}
