/**
 * Inventory export + diagnostics.
 *
 * Pulls the two globally shared data stores out of the authoritative backend and
 * writes them as real files, so the inventory can be inspected, diffed, and backed
 * up. The database remains the source of truth; these files are a snapshot.
 *
 *   node scripts/inventory-export.cjs
 *
 * Writes:
 *   data/claim-usage.json      the per-claim usage flags + permanent pairing
 *   data/daily-challenges.json the frozen nine claims for every date
 *
 * Also prints the diagnostics summary, including how many daily challenges remain
 * before a category runs out of unused claims.
 *
 * Requires the INVENTORY_ADMIN_TOKEN secret to be set on the Edge Function. The
 * token is read from (in order): the INVENTORY_ADMIN_TOKEN env var, or a file at
 * ~/.factually-inventory-token.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

const env = { ...readEnvFile(), ...process.env };
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
const tokenFile = path.join(os.homedir(), '.factually-inventory-token');
const adminToken = env.INVENTORY_ADMIN_TOKEN
  || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env — nothing to export.');
  process.exit(1);
}
if (!adminToken) {
  console.error('Missing INVENTORY_ADMIN_TOKEN. Set the Edge Function secret and put the same value in ~/.factually-inventory-token.');
  process.exit(1);
}

(async () => {
  const response = await fetch(`${url}/functions/v1/community`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'x-inventory-token': adminToken,
    },
    body: JSON.stringify({
      action: 'diagnostics',
      challengeDate: new Date().toISOString().slice(0, 10),
      export: ['claim-usage', 'daily-challenges'],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    console.error(`Export failed (HTTP ${response.status}): ${data?.error ?? 'unknown error'}`);
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const usagePath = path.join(outDir, 'claim-usage.json');
  const challengesPath = path.join(outDir, 'daily-challenges.json');
  fs.writeFileSync(usagePath, `${JSON.stringify(data.claimUsage, null, 2)}\n`);
  fs.writeFileSync(challengesPath, `${JSON.stringify(data.dailyChallenges, null, 2)}\n`);

  const d = data.diagnostics;
  console.log(`wrote ${path.relative(ROOT, usagePath)}      (${Object.keys(data.claimUsage?.claims ?? {}).length} claims)`);
  console.log(`wrote ${path.relative(ROOT, challengesPath)} (${Object.keys(data.dailyChallenges?.challenges ?? {}).length} challenges)`);
  console.log('');
  console.log(`Remaining daily challenges: ${d.remainingCapacity}`);
  console.log(`  per category:  FACT ${d.capacityPerCategory.FACT}  KINDA ${d.capacityPerCategory.KINDA}  BULLSHIT ${d.capacityPerCategory.BULLSHIT}`);
  console.log(`  unused main:   FACT ${d.unusedMain.FACT}  KINDA ${d.unusedMain.KINDA}  BULLSHIT ${d.unusedMain.BULLSHIT}`);
  console.log(`  exhausted:     FACT ${d.exhausted.FACT}  KINDA ${d.exhausted.KINDA}  BULLSHIT ${d.exhausted.BULLSHIT}`);
  console.log(`  available replacements: ${d.availableReplacements}`);
  console.log(`  broken pairs: ${(d.brokenPairs ?? []).length}`);
  if (d.remainingCapacity <= 7) {
    console.log(`\nWARNING: only ${d.remainingCapacity} day(s) of claims remain. Add claims to src/claims.json before the pool runs dry.`);
  }
})().catch((error) => {
  console.error(`Export failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
