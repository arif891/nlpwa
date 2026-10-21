import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { c, printBanner } from '../ui/terminal.js';

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

  console.log(`${c.bold}  Private Key${c.reset} ${c.yellow}(Secret — keep in local .env, NEVER commit to git):${c.reset}`);
  console.log(`  ${c.cyan}NLPWA_PRIVATE_KEY="${privateKeyBase64}"${c.reset}`);
  console.log(`  ${c.dim}(NLPWA_SIGNING_KEY is also accepted as an alias)${c.reset}\n`);

  console.log(`${c.bold}  Public Key${c.reset} ${c.green}(Public — add to nlpwa.config.js):${c.reset}`);
  console.log(`  ${c.cyan}publicKey: '${rawPublicBase64}',${c.reset}\n`);

  console.log(`  ${c.dim}Alternative formats:${c.reset}`);
  console.log(`  ${c.dim}Public Key (Hex): ${rawPublicHex}${c.reset}`);
  console.log(`  ${c.dim}Public Key (SPKI PEM):${c.reset}\n${c.dim}${spkiPem.trim()}${c.reset}\n`);

  if (args['write-env'] || args.writeEnv !== false) {
    const envPath = resolve(process.cwd(), args.env || '.env');
    const line = `\n# NLPWA Ed25519 Manifest Signing Key\nNLPWA_PRIVATE_KEY="${privateKeyBase64}"\n`;
    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        if (!content.includes('NLPWA_PRIVATE_KEY') && !content.includes('NLPWA_SIGNING_KEY')) {
          appendFileSync(envPath, line, 'utf8');
          console.log(`  ${c.green}+ Appended NLPWA_PRIVATE_KEY to ${args.env || '.env'}${c.reset}\n`);
        } else {
          console.log(`  ${c.yellow}! ${args.env || '.env'} already contains signing key (skipped).${c.reset}\n`);
        }
      } else {
        appendFileSync(envPath, line.trimStart(), 'utf8');
        console.log(`  ${c.green}+ Created ${args.env || '.env'} with NLPWA_PRIVATE_KEY${c.reset}\n`);
      }
    } catch (err) {
      console.warn(`  ${c.yellow}Could not write to ${args.env || '.env'}: ${err.message}${c.reset}\n`);
    }
  }

  console.log(`${c.bold}  Next steps:${c.reset}`);
  console.log(`  1. Save ${c.cyan}NLPWA_PRIVATE_KEY${c.reset} to your local .env or CI/CD secret manager.`);
  console.log(`  2. Add ${c.cyan}publicKey: '${rawPublicBase64}'${c.reset} to your nlpwa.config.js.`);
  console.log(`  3. Run ${c.cyan}nlpwa update${c.reset} or build — your manifests will be signed automatically.\n`);

  return {
    privateKeyBase64,
    privateKeyPem,
    publicKeyBase64: rawPublicBase64,
    publicKeyHex: rawPublicHex,
    spkiPem,
  };
}
