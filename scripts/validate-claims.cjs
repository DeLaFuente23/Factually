/**
 * Claim library validator.
 *
 *   node scripts/validate-claims.cjs               validate src/claims.json against git HEAD
 *   node scripts/validate-claims.cjs --base file.json  validate against a different base
 *
 * The database owns the permanent swap pairing, and it pairs adjacent claim IDs
 * within each category. That makes the rules for extending the library strict:
 *
 *   1. every category must hold an EVEN number of claims, otherwise one claim per
 *      category cannot be paired and cannot be swapped;
 *   2. new IDs must sort AFTER every existing ID of their category, otherwise the
 *      recomputed pairing shifts and can collide with a pair that already exists;
 *   3. existing IDs must not be removed or renumbered, because a challenge that
 *      already referenced them has to keep resolving.
 *
 * This script checks all of that, plus the per-claim field contract, before a
 * library is committed or deployed.
 *
 * Exits non-zero when an ERROR is found. WARNINGS never fail the run.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CATEGORIES = ['FACT', 'KINDA', 'BULLSHIT'];
const PREFIX = { FACT: 'fact-', KINDA: 'kinda-', BULLSHIT: 'bull-' };

const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const basePath = baseFlag >= 0 ? args[baseFlag + 1] : null;
const targetPath = args.find((a) => !a.startsWith('--') && a !== basePath) || path.join(ROOT, 'src', 'claims.json');

const errors = [];
const warnings = [];
const error = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

/** Numeric-aware comparator, mirroring src/inventory.ts `compareIds`. */
function compareIds(a, b) {
  const split = (id) => {
    const match = /^(.*?)(\d+)$/.exec(id);
    return match ? { prefix: match[1], number: Number(match[2]) } : { prefix: id, number: 0 };
  };
  const pa = split(a);
  const pb = split(b);
  if (pa.prefix !== pb.prefix) return pa.prefix < pb.prefix ? -1 : 1;
  if (pa.number !== pb.number) return pa.number - pb.number;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The pairing the database would compute: adjacent IDs within each category. */
function buildPairs(claims) {
  const pairs = new Map();
  for (const category of CATEGORIES) {
    const ids = claims.filter((claim) => claim.category === category).map((claim) => claim.id).sort(compareIds);
    for (let i = 0; i + 1 < ids.length; i += 2) {
      pairs.set(ids[i], ids[i + 1]);
      pairs.set(ids[i + 1], ids[i]);
    }
  }
  return pairs;
}

function readClaims(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array.`);
  return parsed;
}

function readBase() {
  if (basePath) return readClaims(path.resolve(basePath));
  try {
    const raw = execFileSync('git', ['show', 'HEAD:src/claims.json'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
    return JSON.parse(raw);
  } catch {
    console.log('No base library available (git HEAD has no src/claims.json) — running field checks only.');
    return null;
  }
}

// --- Load -------------------------------------------------------------------
let claims;
try {
  claims = readClaims(targetPath);
} catch (problem) {
  console.error(`Could not read the claim library: ${problem.message}`);
  process.exit(1);
}
const base = readBase();

console.log(`Validating ${path.relative(ROOT, targetPath)} (${claims.length} claims)\n`);

// --- Per-claim field contract ----------------------------------------------
const seen = new Set();
for (const claim of claims) {
  const id = claim && claim.id;
  const label = id ? `claim "${id}"` : `claim at index ${claims.indexOf(claim)}`;

  if (!id || typeof id !== 'string') {
    error(`${label}: missing a string "id".`);
    continue;
  }
  if (seen.has(id)) error(`duplicate claim id: ${id}`);
  seen.add(id);

  if (!CATEGORIES.includes(claim.category)) {
    error(`${label}: category must be one of ${CATEGORIES.join(', ')} (found ${JSON.stringify(claim.category)}).`);
  } else if (!id.startsWith(PREFIX[claim.category])) {
    warn(`${label}: id does not use the "${PREFIX[claim.category]}" prefix for ${claim.category}.`);
  }

  if (typeof claim.claim !== 'string' || !claim.claim.trim()) error(`${label}: "claim" must be a non-empty string.`);
  if (typeof claim.explanation !== 'string' || !claim.explanation.trim()) error(`${label}: "explanation" must be a non-empty string.`);
  if (!Array.isArray(claim.sources) || claim.sources.length === 0) {
    error(`${label}: "sources" must be a non-empty array.`);
  } else {
    claim.sources.forEach((source, index) => {
      if (!source || typeof source.url !== 'string' || !/^https?:\/\//.test(source.url)) {
        error(`${label}: sources[${index}].url must be an http(s) URL.`);
      }
      if (!source || typeof source.title !== 'string' || !source.title.trim()) {
        error(`${label}: sources[${index}].title must be a non-empty string.`);
      }
    });
  }
  if (typeof claim.obscurity !== 'number' || !Number.isInteger(claim.obscurity) || claim.obscurity < 1 || claim.obscurity > 10) {
    error(`${label}: "obscurity" must be an integer from 1 to 10.`);
  }
  if (typeof claim.replacementEligible !== 'boolean') {
    error(`${label}: "replacementEligible" must be a boolean.`);
  }
  if (typeof claim.claim_es !== 'string' || !claim.claim_es.trim()) warn(`${label}: no Spanish translation ("claim_es").`);
  if (typeof claim.explanation_es !== 'string' || !claim.explanation_es.trim()) warn(`${label}: no Spanish translation ("explanation_es").`);
}

// --- Per-category totals ----------------------------------------------------
const totals = {};
for (const category of CATEGORIES) {
  const count = claims.filter((claim) => claim.category === category).length;
  totals[category] = count;
  if (count % 2 !== 0) {
    error(`${category} has an odd claim count (${count}). Each category needs an even count so every claim can be paired with a swap partner.`);
  }
  if (count > 0 && count < 6) error(`${category} has only ${count} claims — at least 3 are needed per challenge.`);
}

// --- Comparison against the deployed library --------------------------------
if (base) {
  const baseById = new Map(base.map((claim) => [claim.id, claim]));
  const newById = new Map(claims.map((claim) => [claim.id, claim]));

  const removed = base.filter((claim) => !newById.has(claim.id)).map((claim) => claim.id);
  const added = claims.filter((claim) => !baseById.has(claim.id)).map((claim) => claim.id);

  for (const id of removed) {
    error(`claim "${id}" was removed from the library. Past challenges reference it by id, so it must stay.`);
  }

  for (const id of added) {
    const claim = newById.get(id);
    const categoryClaims = base.filter((entry) => entry.category === claim.category);
    if (!categoryClaims.length) continue;
    const highest = categoryClaims.map((entry) => entry.id).sort(compareIds).pop();
    if (compareIds(claim.id, highest) <= 0) {
      error(`new claim "${id}" sorts before the existing ${claim.category} claim "${highest}". New ids must continue from the bottom of their category.`);
    }
  }

  for (const claim of claims) {
    const previous = baseById.get(claim.id);
    if (!previous) continue;
    if (JSON.stringify(previous) !== JSON.stringify(claim)) {
      warn(`claim "${claim.id}" changed. Editing a live claim rewrites the text players have already seen.`);
    }
  }

  // The pairing the database would compute must not disturb an existing pair.
  const basePairs = buildPairs(base);
  const newPairs = buildPairs(claims);
  const disrupted = [];
  for (const [id, partner] of basePairs) {
    const after = newPairs.get(id);
    if (after && after !== partner) disrupted.push(`${id} (${partner} -> ${after})`);
  }
  if (disrupted.length) {
    const shown = disrupted.slice(0, 4).join(', ');
    const more = disrupted.length > 4 ? `, and ${disrupted.length - 4} more` : '';
    error(`the pairing of ${disrupted.length} claim(s) would change: ${shown}${more}. The database keeps existing pairs, so a claim would end up pointing at a partner that is already paired elsewhere. New ids must sort after every existing id of their category.`);
  }

  console.log(`Compared against the base library: ${added.length} added, ${removed.length} removed.`);
  if (added.length) {
    const byCategory = {};
    for (const id of added) {
      const category = newById.get(id).category;
      (byCategory[category] = byCategory[category] || []).push(id);
    }
    for (const category of CATEGORIES) {
      if (!byCategory[category]) continue;
      const ids = byCategory[category].sort(compareIds);
      console.log(`  ${category}: ${ids.length} added (${ids[0]}${ids.length > 1 ? ` … ${ids[ids.length - 1]}` : ''})`);
      if (ids.length % 2 !== 0) {
        error(`${category} gained ${ids.length} claims. Add one more to that category so the count stays even and the new claims pair among themselves.`);
      }
    }
  }
  console.log('');
}

// --- Report -----------------------------------------------------------------
console.log('Per-category totals:');
for (const category of CATEGORIES) {
  console.log(`  ${category.padEnd(9)} ${totals[category]}`);
}

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const message of warnings) console.log(`  WARN  ${message}`);
}
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const message of errors) console.log(`  ERROR ${message}`);
  console.log('\nFAILED — do not deploy this library.');
  process.exit(1);
}
console.log('\nOK — the library is valid.');
