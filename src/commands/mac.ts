/** `mac status`: `GET /api/v1/mac/status`, the MACs consumed in the period against the plan's limit. */
import { isRecord } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';

export async function macStatus(ctx: Context): Promise<void> {
  const body = await ctx.client().get(routes.macStatus);
  const status = isRecord(body) ? body : { value: body };
  const n = (value: unknown) => (typeof value === 'number' ? value.toLocaleString('es-AR') : '-');
  ctx.out.result({ mac: status }, () => [
    `MACs del período: ${n(status.current_count)} de ${n(status.limit)} (${n(status.usage_percentage)} %) · quedan ${n(status.remaining)}`,
    `  estado ${String(status.state ?? '-')} · control del tope ${status.enforcement_enabled === true ? 'activado' : status.enforcement_enabled === false ? 'desactivado' : '-'}`,
  ]);
}
