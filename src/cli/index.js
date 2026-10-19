import { c, printBanner, printHelp } from './ui/terminal.js';
import { cmdInit } from './commands/init.js';
import { cmdAdd } from './commands/add.js';
import { cmdUpdate } from './commands/update.js';
import { cmdStatus } from './commands/status.js';
import { cmdGenerateOffline } from './commands/generate-offline.js';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else if (arg.startsWith('-')) {
      console.warn(`${c.yellow}Warning: Unknown flag "${arg}" — did you mean "--${arg.slice(1)}"?${c.reset}`);
    } else {
      args._.push(arg);
    }
  }
  return args;
}

export async function runCLI(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || command === 'help') {
    printHelp();
    return;
  }

  switch (command) {
    case 'init':
      await cmdInit(args);
      break;
    case 'add':
      await cmdAdd(args);
      break;
    case 'generate-offline':
      await cmdGenerateOffline(args);
      break;
    case 'update':
    case 'build':
      await cmdUpdate(args);
      break;
    case 'status':
      await cmdStatus(args);
      break;
    default:
      if (!command) {
        printHelp();
      } else {
        console.error(`${c.red}Unknown command "${command}". Run "nlpwa --help" for usage.${c.reset}`);
        process.exit(1);
      }
  }
}
