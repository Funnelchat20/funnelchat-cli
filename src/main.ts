/**
 * The commands of `funnelchat`. {@link run} takes everything from the outside world as arguments, so
 * tests run the real CLI with a fake `fetch`, fake streams and a temporary folder.
 */
import { Command, CommanderError } from 'commander';
import type { Context as ContextType, GlobalOptions, Io } from './context.js';
import { Context } from './context.js';
import { ExitCode } from './errors.js';
import { login, logout, profilesList, profilesUse, whoami } from './commands/account.js';
import { collect, explicitOptions } from './commands/common.js';
import { CONTACTS_FLAG_NAMES, contactsExport, type ContactsExportFlags } from './commands/contacts.js';
import { CONVERSATIONS_FLAG_NAMES, conversationsExport, type ConversationsExportFlags, DEFAULT_PART_SIZE } from './commands/conversations.js';
import { macStatus } from './commands/mac.js';
import { numbersHealth, numbersList } from './commands/numbers.js';
import { templatesList, type TemplatesListFlags } from './commands/templates.js';
import { VERSION } from './version.js';

const EXIT_CODES_HELP = `
Códigos de salida:
  0    todo bien
  1    error inesperado
  2    uso incorrecto (opción o valor inválido)
  3    sin clave, clave rechazada (401) o sin permiso (403)
  4    no existe en tu cuenta (404)
  5    límite de la API que la CLI no espera (tope diario o un Retry-After largo): se puede retomar
  6    error de la API o de red, después de los reintentos
  7    la salida ya existe: la CLI nunca pisa un archivo
  130  interrumpido con Ctrl+C: una exportación se puede retomar

Variables de entorno:
  FUNNELCHAT_API_KEY     la clave (gana sobre el perfil guardado, salvo con --profile)
  FUNNELCHAT_PROFILE     el perfil a usar
  FUNNELCHAT_BASE_URL    la URL base
  FUNNELCHAT_RATE        pedidos por segundo
  FUNNELCHAT_CONFIG_DIR  dónde guardar la configuración

La CLI solo lee: no manda mensajes ni modifica nada de tu cuenta.`;

type Action = (ctx: ContextType, command: Command, ...args: unknown[]) => Promise<void> | void;

export async function run(argv: string[], io: Io): Promise<number> {
  let exitCode: number = ExitCode.OK;

  const program = new Command('funnelchat');
  program
    .description('Exporta conversaciones y contactos de tu cuenta de Funnelchat desde la API pública, y consulta tus números, plantillas y MACs.')
    .version(VERSION, '-V, --version', 'Muestra la versión.')
    .helpOption('-h, --help', 'Muestra la ayuda.')
    .helpCommand('help [comando]', 'Muestra la ayuda de un comando.')
    .option('--profile <nombre>', 'Perfil de configuración a usar.')
    .option('--base-url <url>', 'URL base de la API (por defecto https://api.funnelchat.com).')
    .option('--staging', 'Usa la API de staging (https://api-staging.funnelchat.com).')
    .option('--json', 'Salida en JSON, para scripts.')
    .option('-v, --verbose', 'Muestra cada pedido a la API (nunca la clave).')
    .option('-q, --quiet', 'Sin mensajes de progreso.')
    .option('--rate <pedidos>', 'Pedidos por segundo como máximo (por defecto 1).')
    .option('--max-wait <segundos>', 'Cuánto esperar sola un Retry-After antes de cortar (por defecto 60).')
    .addHelpText('after', EXIT_CODES_HELP)
    .showSuggestionAfterError(true)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    });

  const action = (fn: Action) => async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const ctx = new Context(io, command.optsWithGlobals() as GlobalOptions);
    try {
      await fn(ctx, command, ...args.slice(0, -1));
      exitCode = ExitCode.OK;
    } catch (error) {
      exitCode = ctx.out.error(error);
    }
  };

  // --- account ---------------------------------------------------------------------------------
  program
    .command('login')
    .description('Guarda tu clave de API en un perfil (archivo con permisos 0600). La lee del teclado sin mostrarla, o de la entrada estándar.')
    .option('--no-verify', 'No la prueba contra la API antes de guardarla.')
    .action(action((ctx, command) => login(ctx, command.opts())));

  program
    .command('logout')
    .description('Borra la clave guardada del perfil activo (o del de --profile).')
    .action(action((ctx) => logout(ctx)));

  program
    .command('whoami')
    .description('Muestra a qué cuenta pertenece la clave, sin mostrar la clave.')
    .action(action((ctx) => whoami(ctx)));

  const profiles = program.command('profiles').description('Perfiles guardados.');
  profiles
    .command('list', { isDefault: true })
    .description('Lista los perfiles (nunca muestra las claves).')
    .action(action((ctx) => profilesList(ctx)));
  profiles
    .command('use')
    .argument('<nombre>', 'Perfil a activar.')
    .description('Elige el perfil que se usa por defecto.')
    .action(action((ctx, _command, name) => profilesUse(ctx, name as string)));

  // --- numbers ---------------------------------------------------------------------------------
  const numbers = program.command('numbers').description('Tus números de WhatsApp.');
  numbers
    .command('list')
    .description('Lista los números, con su conexión y lo que la CLI puede exportar o leer de cada uno.')
    .action(action((ctx) => numbersList(ctx)));
  numbers
    .command('health')
    .argument('[números...]', 'Ids de los números (por defecto, todos los oficiales).')
    .description('Salud, calidad, límite de mensajes y throughput de los números oficiales.')
    .action(action((ctx, _command, ids) => numbersHealth(ctx, (ids as string[]) ?? [])));

  // --- contacts --------------------------------------------------------------------------------
  const contacts = program.command('contacts').description('Contactos.');
  contacts
    .command('export')
    .description('Exporta los contactos con sus etiquetas y campos personalizados, en CSV o JSONL.')
    .option('-o, --output-dir <carpeta>', 'Carpeta nueva o vacía para la exportación (por defecto funnelchat-contacts-export-<fecha>).')
    .option('--format <formato>', 'csv (por defecto) o jsonl.')
    .option('--tag <id>', 'Solo contactos con esta etiqueta (se puede repetir o separar con comas).', collect)
    .option('--tag-mode <modo>', 'Con varias --tag: any (alguna, por defecto), all (todas) o exclude (ninguna).')
    .option('--created-from <fecha>', 'Creados desde esta fecha (AAAA-MM-DD, el día entero). Va con --created-to.')
    .option('--created-to <fecha>', 'Creados hasta esta fecha (AAAA-MM-DD, el día entero). Va con --created-from.')
    .option('--only-with-phone', 'Solo contactos a los que se les puede escribir.')
    .option('--no-tags', 'Sin etiquetas (una consulta menos por contacto).')
    .option('--no-custom-fields', 'Sin campos personalizados (una consulta menos por contacto).')
    .option('--resume', 'Retoma una exportación cortada en --output-dir, desde la última página guardada.')
    .action(
      action((ctx, command) => contactsExport(ctx, command.opts() as ContactsExportFlags, explicitOptions(command, CONTACTS_FLAG_NAMES))),
    );

  // --- conversations ---------------------------------------------------------------------------
  const conversations = program.command('conversations').description('Conversaciones y sus mensajes.');
  conversations
    .command('export')
    .description('Exporta los mensajes de cada conversación en partes JSONL, con un manifiesto.')
    .option('-o, --output-dir <carpeta>', 'Carpeta nueva o vacía para la exportación (por defecto funnelchat-conversations-export-<fecha>).')
    .option('--contact <id>', 'Solo la conversación de este contacto (se puede repetir o separar con comas).', collect)
    .option('--device <id>', 'Solo conversaciones de este número, y de ellas solo sus mensajes.')
    .option('--since <fecha>', 'Conversaciones y mensajes creados o modificados desde esta fecha (AAAA-MM-DD en UTC, o fecha y hora con zona).')
    .option('--part-size <mensajes>', `Mensajes por parte (por defecto ${DEFAULT_PART_SIZE.toLocaleString('es-AR')}).`)
    .option('--resume', 'Retoma una exportación cortada en --output-dir, desde el último cursor guardado.')
    .action(
      action((ctx, command) =>
        conversationsExport(ctx, command.opts() as ConversationsExportFlags, explicitOptions(command, CONVERSATIONS_FLAG_NAMES)),
      ),
    );

  // --- templates -------------------------------------------------------------------------------
  const templates = program.command('templates').description('Plantillas de WhatsApp.');
  templates
    .command('list')
    .description('Lista las plantillas, con su estado y su número.')
    .option('--device <id>', 'Solo las de este número.')
    .option('--status <estado>', 'APPROVED, PENDING, REJECTED, PAUSED, DISABLED…')
    .action(action((ctx, command) => templatesList(ctx, command.opts() as TemplatesListFlags)));

  // --- mac -------------------------------------------------------------------------------------
  const mac = program.command('mac').description('Contactos activos por mes (MACs).');
  mac
    .command('status')
    .description('Cuántos MACs llevas en el período, el límite y cuántos te quedan.')
    .action(action((ctx) => macStatus(ctx)));

  for (const command of program.commands) {
    command.exitOverride().configureOutput({ writeOut: (text) => io.stdout.write(text), writeErr: (text) => io.stderr.write(text) });
    for (const sub of command.commands) {
      sub.exitOverride().configureOutput({ writeOut: (text) => io.stdout.write(text), writeErr: (text) => io.stderr.write(text) });
    }
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(error.code)) return ExitCode.OK;
      if (error.code === 'commander.executeSubCommandAsync') return ExitCode.UNEXPECTED;
      return ExitCode.USAGE;
    }
    throw error;
  }
  return exitCode;
}
