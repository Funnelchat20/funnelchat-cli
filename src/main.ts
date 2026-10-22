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
Exit codes:
  0    all good
  1    unexpected error
  2    wrong usage (invalid option or value)
  3    no key, a key the API rejects (401) or a missing permission (403)
  4    not found in your account (404)
  5    an API limit the CLI does not wait for (daily cap or a long Retry-After): it can be resumed
  6    API or network error, after the retries
  7    the output already exists: the CLI never overwrites a file
  130  interrupted with Ctrl+C: an export can be resumed

Environment variables:
  FUNNELCHAT_API_KEY     the key (wins over the saved profile, except with --profile)
  FUNNELCHAT_PROFILE     the profile to use
  FUNNELCHAT_BASE_URL    the base URL
  FUNNELCHAT_RATE        requests per second
  FUNNELCHAT_CONFIG_DIR  where to keep the configuration

The CLI only reads: it sends no messages and changes nothing in your account.`;

type Action = (ctx: ContextType, command: Command, ...args: unknown[]) => Promise<void> | void;

export async function run(argv: string[], io: Io): Promise<number> {
  let exitCode: number = ExitCode.OK;

  const program = new Command('funnelchat');
  program
    .description('Export conversations and contacts from your Funnelchat account through the public API, and check your numbers, templates and MACs.')
    .version(VERSION, '-V, --version', 'Shows the version.')
    .helpOption('-h, --help', 'Shows the help.')
    .helpCommand('help [command]', 'Shows the help of a command.')
    .option('--profile <name>', 'Configuration profile to use.')
    .option('--base-url <url>', 'Base URL of the API (https://api.funnelchat.com by default).')
    .option('--staging', 'Uses the staging API (https://api-staging.funnelchat.com).')
    .option('--json', 'JSON output, for scripts.')
    .option('-v, --verbose', 'Shows every request to the API (never the key).')
    .option('-q, --quiet', 'No progress messages.')
    .option('--rate <requests>', 'Requests per second at most (1 by default).')
    .option('--max-wait <seconds>', 'How long to wait for a Retry-After on its own before stopping (60 by default).')
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
    .description('Saves your API key in a profile (a file with 0600 permissions). Reads it from the keyboard without showing it, or from standard input.')
    .option('--no-verify', 'Does not check it against the API before saving it.')
    .action(action((ctx, command) => login(ctx, command.opts())));

  program
    .command('logout')
    .description('Deletes the saved key of the active profile (or of --profile).')
    .action(action((ctx) => logout(ctx)));

  program
    .command('whoami')
    .description('Shows which account the key belongs to, without showing the key.')
    .action(action((ctx) => whoami(ctx)));

  const profiles = program.command('profiles').description('Saved profiles.');
  profiles
    .command('list', { isDefault: true })
    .description('Lists the profiles (never shows the keys).')
    .action(action((ctx) => profilesList(ctx)));
  profiles
    .command('use')
    .argument('<name>', 'Profile to activate.')
    .description('Chooses the profile used by default.')
    .action(action((ctx, _command, name) => profilesUse(ctx, name as string)));

  // --- numbers ---------------------------------------------------------------------------------
  const numbers = program.command('numbers').description('Your WhatsApp numbers.');
  numbers
    .command('list')
    .description('Lists the numbers, with their connection and what the CLI can export or read for each one.')
    .action(action((ctx) => numbersList(ctx)));
  numbers
    .command('health')
    .argument('[numbers...]', 'Ids of the numbers (all the official ones by default).')
    .description('Health, quality, messaging limit and throughput of the official numbers.')
    .action(action((ctx, _command, ids) => numbersHealth(ctx, (ids as string[]) ?? [])));

  // --- contacts --------------------------------------------------------------------------------
  const contacts = program.command('contacts').description('Contacts.');
  contacts
    .command('export')
    .description('Exports the contacts with their tags and custom fields, as CSV or JSONL.')
    .option('-o, --output-dir <dir>', 'New or empty folder for the export (funnelchat-contacts-export-<date> by default).')
    .option('--format <format>', 'csv (default) or jsonl.')
    .option('--tag <id>', 'Only contacts with this tag (can be repeated or comma-separated).', collect)
    .option('--tag-mode <mode>', 'With several --tag: any (default), all or exclude (none of them).')
    .option('--created-from <date>', 'Created from this date (YYYY-MM-DD, the whole day). Goes with --created-to.')
    .option('--created-to <date>', 'Created up to this date (YYYY-MM-DD, the whole day). Goes with --created-from.')
    .option('--only-with-phone', 'Only contacts that can be messaged.')
    .option('--no-tags', 'Without tags (one request less per contact).')
    .option('--no-custom-fields', 'Without custom fields (one request less per contact).')
    .option('--resume', 'Resumes an interrupted export in --output-dir, from the last saved page.')
    .action(
      action((ctx, command) => contactsExport(ctx, command.opts() as ContactsExportFlags, explicitOptions(command, CONTACTS_FLAG_NAMES))),
    );

  // --- conversations ---------------------------------------------------------------------------
  const conversations = program.command('conversations').description('Conversations and their messages.');
  conversations
    .command('export')
    .description('Exports the messages of every conversation in JSONL parts, with a manifest.')
    .option('-o, --output-dir <dir>', 'New or empty folder for the export (funnelchat-conversations-export-<date> by default).')
    .option('--contact <id>', 'Only the conversation of this contact (can be repeated or comma-separated).', collect)
    .option('--device <id>', 'Only conversations of this number, and of them only its messages.')
    .option('--since <date>', 'Conversations and messages created or changed since this date (YYYY-MM-DD in UTC, or a date and time with a zone).')
    .option('--part-size <messages>', `Messages per part (${DEFAULT_PART_SIZE.toLocaleString('en-US')} by default).`)
    .option('--resume', 'Resumes an interrupted export in --output-dir, from the last saved cursor.')
    .action(
      action((ctx, command) =>
        conversationsExport(ctx, command.opts() as ConversationsExportFlags, explicitOptions(command, CONVERSATIONS_FLAG_NAMES)),
      ),
    );

  // --- templates -------------------------------------------------------------------------------
  const templates = program.command('templates').description('WhatsApp templates.');
  templates
    .command('list')
    .description('Lists the templates, with their status and their number.')
    .option('--device <id>', 'Only those of this number.')
    .option('--status <status>', 'APPROVED, PENDING, REJECTED, PAUSED, DISABLED…')
    .action(action((ctx, command) => templatesList(ctx, command.opts() as TemplatesListFlags)));

  // --- mac -------------------------------------------------------------------------------------
  const mac = program.command('mac').description('Monthly active contacts (MACs).');
  mac
    .command('status')
    .description('How many MACs you have used in the period, the limit and how many are left.')
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
