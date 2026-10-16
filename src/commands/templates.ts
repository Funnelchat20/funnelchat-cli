/**
 * `templates list` and `templates metrics`.
 *
 * DEPENDS ON AN UNMERGED PR: `GET /api/v1/templates/{template}/metrics` comes from conversations PR #2350
 * (branch feat/metricas-plantillas-api @ 0626c14ff, unmerged, stacked on feat/armar-funnelchat-f1). It is
 * in spec/pending.json, not in the portal's snapshot; the response shape was read from
 * TemplateMetricsResource and TemplateMetricsResult on that branch. Until it is deployed, the API
 * answers that the route does not exist.
 */
import { ApiError, CliError, ExitCode, isRecord, usageError } from '../errors.js';
import { routes } from '../generated/routes.js';
import type { Context } from '../context.js';
import { parseDay } from '../dates.js';
import { table, toCliError } from '../output.js';
import { idList, positiveInt } from './common.js';

export const TEMPLATE_METRICS_PENDING =
  'templates metrics depende de un PR sin mergear (conversations #2350): hasta que se despliegue, la API puede responder que la ruta no existe.';

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

export interface TemplateMetricsFlags {
  from?: string;
  to?: string;
}

export async function templatesMetrics(ctx: Context, ids: string[], flags: TemplateMetricsFlags): Promise<void> {
  const templateIds = idList(ids, 'plantilla');
  if (templateIds.length === 0) throw usageError('Indicá al menos una plantilla: funnelchat templates metrics <id>.');
  if (Boolean(flags.from) !== Boolean(flags.to)) throw usageError('--from y --to van juntos (o ninguno, para los últimos 7 días).');
  const query = flags.from && flags.to ? { from: parseDay(flags.from, '--from'), to: parseDay(flags.to, '--to') } : {};
  if (query.from && query.to && query.from > query.to) throw usageError('--from no puede ser posterior a --to.');
  ctx.out.note(`nota: ${TEMPLATE_METRICS_PENDING}`);

  const results: { template_id: number; metrics?: Record<string, unknown>; error?: Record<string, unknown> }[] = [];
  let firstFailure: CliError | null = null;
  for (const id of templateIds) {
    try {
      const body = await ctx.client().get(routes.templateMetrics, { path: { template: id }, query });
      const data = isRecord(body) && isRecord(body.data) ? body.data : isRecord(body) ? body : {};
      results.push({ template_id: id, metrics: data });
    } catch (error) {
      const failure = explain(error);
      // A stop that affects every template (key, limits, network) ends the command right away.
      if (failure.exitCode !== ExitCode.API && failure.exitCode !== ExitCode.NOT_FOUND) throw failure;
      firstFailure ??= failure;
      results.push({ template_id: id, error: { code: failure.code, message: failure.message, ...failure.details } });
    }
  }

  // In human mode a lone failure is said once, as the error below.
  if (ctx.out.json || results.some((r) => !r.error)) {
    ctx.out.result({ templates: results, pending: routes.templateMetrics.pending?.source ?? null }, () => results.flatMap((r) => humanMetrics(r)));
  }
  if (firstFailure) {
    throw new CliError(
      results.length === 1 ? firstFailure.message : `${results.filter((r) => r.error).length} de ${results.length} plantillas no tienen métricas.`,
      { exitCode: firstFailure.exitCode, code: firstFailure.code, ...(firstFailure.hint ? { hint: firstFailure.hint } : {}) },
    );
  }
}

function explain(error: unknown): CliError {
  if (error instanceof ApiError && error.status === 404 && error.apiCode === 'route_not_found') {
    return new CliError('La API todavía no tiene la ruta de métricas de plantillas.', {
      exitCode: ExitCode.NOT_FOUND,
      code: 'route_not_found',
      hint: 'Depende de conversations PR #2350, sin mergear: va a funcionar cuando se despliegue.',
    });
  }
  return toCliError(error);
}

function humanMetrics(result: { template_id: number; metrics?: Record<string, unknown>; error?: Record<string, unknown> }): string[] {
  if (result.error) return [`Plantilla ${result.template_id}: ${String(result.error.message)}`, ''];
  const m = result.metrics ?? {};
  const totals = isRecord(m.totals) ? m.totals : {};
  const days = Array.isArray(m.days) ? (m.days as Record<string, unknown>[]) : [];
  const clicks = (value: unknown) => (Array.isArray(value) ? value.reduce((n: number, c) => n + (isRecord(c) ? Number(c.count) || 0 : 0), 0) : 0);
  const cost = (value: unknown) => (isRecord(value) && value.amount_spent !== null && value.amount_spent !== undefined ? String(value.amount_spent) : null);
  const totalClicks = Array.isArray(totals.clicks) ? (totals.clicks as Record<string, unknown>[]) : [];
  return [
    `Plantilla ${result.template_id} · ${String(m.from ?? '?')} a ${String(m.to ?? '?')} (${String(m.timezone ?? 'UTC')}) · leído de Meta ${String(m.fetched_at ?? '-')}`,
    `  enviados ${fmt(totals.sent)} · entregados ${fmt(totals.delivered)} · leídos ${fmt(totals.read)} · clics ${fmt(clicks(totals.clicks))} · costo ${cost(totals.cost) ?? 'no informado'}`,
    ...totalClicks.map((c) => `  botón ${String(c.type ?? '')} "${String(c.button_content ?? '')}": ${fmt(c.count)} clics`),
    ...table(
      ['día', 'enviados', 'entregados', 'leídos', 'clics', 'costo'],
      days.map((d) => [d.date as string, fmt(d.sent), fmt(d.delivered), fmt(d.read), fmt(clicks(d.clicks)), cost(d.cost)]),
    ).map((line) => `  ${line}`),
    '',
  ];
}

function fmt(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('es-AR') : '-';
}
