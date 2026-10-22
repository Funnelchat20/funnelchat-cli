/** `templates list`: `GET /api/v1/templates`, the account's WhatsApp templates, with their status and number. */
import { usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { table } from '../output.js';
import { positiveInt } from './common.js';

export interface TemplatesListFlags {
  device?: string;
  status?: string;
}

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PENDING_DELETION', 'PAUSED', 'DISABLED', 'ARCHIVED'];

export async function templatesList(ctx: Context, flags: TemplatesListFlags): Promise<void> {
  const status = flags.status?.toUpperCase();
  if (status && !STATUSES.includes(status)) throw usageError(`--status tiene que ser uno de ${STATUSES.join(', ')}: ${flags.status}`);
  const query = {
    perPage: 100,
    ...(flags.device ? { deviceId: positiveInt(flags.device, '--device') } : {}),
    ...(status ? { status } : {}),
  };
  const templates: Record<string, unknown>[] = [];
  for await (const template of ctx.client().all<Record<string, unknown>>(routes.templatesList, { query })) templates.push(template);
  ctx.out.result({ templates }, () =>
    templates.length === 0
      ? 'No hay plantillas con esos filtros.'
      : table(
          ['id', 'nombre', 'idioma', 'categoría', 'estado', 'número'],
          templates.map((t) => [t.id as number, t.name as string, t.language_code as string, t.category as string, t.status as string, t.device_id as number]),
        ),
  );
}
