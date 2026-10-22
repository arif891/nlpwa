import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { c, printBanner } from '../ui/terminal.js';
import {
  findConfigFile,
  syncSourceConfigPublicKey,
  syncPublicKeyToSwFiles,
} from '../core/config.js';

export async function cmdGenerateKeys(args) {
  printBanner();
  console.log(`${c.bold}nlpwa keys:generate${c.reset}\n`);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublicDer = spkiDer.subarray(-32);

  const rawPublicBase64 = rawPublicDer.toString('base64');
  const rawPublicHex = rawPublicDer.toString('hex');
  const spkiPem = publicKey.export({ type: 'spki', format: 'pem' });

  // Single-line base64 representation of PKCS8 private key for convenient .env storage
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const privateKeyBase64 = privateDer.toString('base64');

  console.log(`${c.green}${c.bold}  ✓ Generated Ed25519 Signing Keypair!${c.reset}\n`);

  console.log(`${c.bold}  Private Key${c.reset} ${c.yellow}(Secret — keep in local .env.nlpwa, NEVER commit to git):${c.reset}`);
  console.log(`  ${c.cyan}NLPWA_PRIVATE_KEY="${privateKeyBase64}"${c.reset}`);
  console.log(`  ${c.dim}(NLPWA_SIGNING_KEY is also accepted as an alias)${c.reset}\n`);

  console.log(`${c.bold}  Public Key${c.reset} ${c.green}(Public — embedded in nlpwa.config.js and sw.js):${c.reset}`);
  console.log(`  ${c.cyan}publicKey: '${rawPublicBase64}',${c.reset}\n`);

  console.log(`  ${c.dim}Alternative formats:${c.reset}`);
  console.log(`  ${c.dim}Public Key (Hex): ${rawPublicHex}${c.reset}`);
  console.log(`  ${c.dim}Public Key (SPKI PEM):${c.reset}\n${c.dim}${spkiPem.trim()}${c.reset}\n`);

  const shouldWriteEnv =
    args.writeEnv !== false &&
    args['write-env'] !== false &&
    !args.noWriteEnv &&
    !args['no-write-env'];

  if (shouldWriteEnv) {
    const targetEnvFile = args.env || '.env.nlpwa';
    const envPath = resolve(process.cwd(), targetEnvFile);
    const line = `\n# NLPWA Ed25519 Manifest Signing Key\nNLPWA_PRIVATE_KEY="${privateKeyBase64}"\n`;
    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        if (!content.includes('NLPWA_PRIVATE_KEY') && !content.includes('NLPWA_SIGNING_KEY')) {
          appendFileSync(envPath, line, { encoding: 'utf8', mode: 0o600 });
          console.log(`  ${c.green}+ Appended NLPWA_PRIVATE_KEY to ${targetEnvFile}${c.reset}\n`);
        } else {
          console.log(`  ${c.yellow}! ${targetEnvFile} already contains signing key (skipped).${c.reset}\n`);
        }
      } else {
        appendFileSync(envPath, line.trimStart(), { encoding: 'utf8', mode: 0o600 });
        console.log(`  ${c.green}+ Created ${targetEnvFile} with NLPWA_PRIVATE_KEY (mode: 0600)${c.reset}\n`);
      }
    } catch (err) {
      console.warn(`  ${c.yellow}Could not write to ${targetEnvFile}: ${err.message}${c.reset}\n`);
    }
  }

  const shouldSyncConfig =
    args.syncConfig !== false &&
    args['sync-config'] !== false &&
    args.writeConfig !== false &&
    args['write-config'] !== false &&
    args.writeEnv !== false &&
    args['write-env'] !== false &&
    !args.noWriteConfig &&
    !args['no-write-config'] &&
    !args.noSyncConfig &&
    !args['no-sync-config'] &&
    args.config !== false;

  // Auto-sync publicKey to nlpwa.config.js if config file exists
  let configSynced = false;
  if (shouldSyncConfig) {
    try {
      const configPath = findConfigFile(args.config);
      if (configPath) {
        const updated = syncSourceConfigPublicKey(configPath, rawPublicBase64);
        if (updated) {
          console.log(`  ${c.green}+ Synchronized publicKey into ${configPath}${c.reset}`);
          configSynced = true;
        } else {
          console.warn(`  ${c.yellow}! Notice: Could not automatically inject publicKey into ${configPath}.${c.reset}`);
          console.warn(`  ${c.yellow}  Please add to your config manually: ${c.cyan}publicKey: '${rawPublicBase64}'${c.reset}\n`);
        }
      }
    } catch {}
  }


  const shouldSyncSw =
    args.syncSw !== false &&
    args['sync-sw'] !== false &&
    args.writeEnv !== false &&
    args['write-env'] !== false &&
    !args.noSyncSw &&
    !args['no-sync-sw'];

  // Auto-sync publicKey into existing sw.js files
  const targetDir = resolve(args.dir ?? (existsSync('./dist') ? './dist' : '.'));
  const swCandidates = [
    resolve(targetDir, 'sw.js'),
    resolve(process.cwd(), 'sw.js'),
    resolve(process.cwd(), 'public', 'sw.js'),
  ];
  const modifiedSw = shouldSyncSw ? syncPublicKeyToSwFiles(swCandidates, rawPublicBase64) : [];
  for (const swFile of modifiedSw) {
    const rel = relative(process.cwd(), swFile).replace(/\\/g, '/');
    console.log(`  ${c.green}+ Injected publicKey into ${rel}${c.reset}`);
  }
  if (configSynced || modifiedSw.length > 0) {
    console.log('');
  }


  console.log(`${c.bold}  Next steps:${c.reset}`);
  console.log(`  1. Keep ${c.cyan}NLPWA_PRIVATE_KEY${c.reset} in local .env.nlpwa (already protected in .gitignore) or CI/CD secrets.`);
  if (!configSynced) {
    console.log(`  2. Add ${c.cyan}publicKey: '${rawPublicBase64}'${c.reset} to your nlpwa.config.js.`);
    console.log(`  3. Run ${c.cyan}nlpwa update${c.reset} — manifests and sw.js will be synced and signed automatically.\n`);
  } else {
    console.log(`  2. Run ${c.cyan}nlpwa update${c.reset} — manifests will be signed with Ed25519 and verified by sw.js.\n`);
  }

  return {
    privateKeyBase64,
    privateKeyPem,
    publicKeyBase64: rawPublicBase64,
    publicKeyHex: rawPublicHex,
    spkiPem,
  };
}

