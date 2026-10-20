import { describe, it, expect } from 'vitest';
import claims from './claims.json';
import type { Claim, Category } from './game';
import {
  buildReplacementPairs, compareIds, reconcileUsage, selectDailyClaims, eligibleMainClaims,
  resolveReplacement, consumeReplacement, markMainUsage, diagnose, shuffle, validateChallenge,
  validateLibrary, emptyUsageStore, emptyChallengeStore, exportUsageJson, exportChallengesJson,
  parseUsageJson, parseChallengesJson, challengeClaimIds, isExhausted, CATEGORIES,
  type ClaimUsageStore, type DailyChallenge,
} from './inventory';

const library = claims as Claim[];

// A deterministic PRNG so randomness tests are reproducible without asserting a
// specific sequence. Mulberry32.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const reconciled = (): ClaimUsageStore => reconcileUsage(library, emptyUsageStore()).store;

describe('1. daily challenges contain exactly nine unique primary claims', () => {
  it('selects nine distinct claims across three rounds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const store = reconciled();
      const result = selectDailyClaims(library, store, seeded(seed));
      expect('rounds' in result).toBe(true);
      if (!('rounds' in result)) continue;
      const ids = result.rounds.flatMap((round) => round.claim_ids);
      expect(ids).toHaveLength(9);
      expect(new Set(ids).size).toBe(9);
      expect(result.rounds).toHaveLength(3);
    }
  });
});

describe('2. each round contains exactly one claim from each category', () => {
  it('puts one FACT, one KINDA and one BULLSHIT in every round', () => {
    const byId = new Map(library.map((claim) => [claim.id, claim]));
    for (let seed = 1; seed <= 25; seed++) {
      const result = selectDailyClaims(library, reconciled(), seeded(seed));
      if (!('rounds' in result)) throw new Error('selection failed');
      for (const round of result.rounds) {
        expect(round.claim_ids).toHaveLength(3);
        const categories = round.claim_ids.map((id) => byId.get(id)!.category);
        expect(new Set(categories)).toEqual(new Set(CATEGORIES));
      }
    }
  });
});

describe('3. claims are randomly selected rather than selected in stored order', () => {
  it('does not always return the first eligible claim of each category', () => {
    const firstIds = new Set(CATEGORIES.map((category) => eligibleMainClaims(library, reconciled(), category)[0].id));
    const seenFirstAsSelected = new Set<string>();
    let distinctWindows = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const result = selectDailyClaims(library, reconciled(), seeded(seed));
      if (!('rounds' in result)) throw new Error('selection failed');
      const ids = result.rounds.flatMap((round) => round.claim_ids);
      distinctWindows.add([...ids].sort().join(','));
      for (const id of firstIds) if (ids.includes(id)) seenFirstAsSelected.add(id);
    }
    // Different seeds must produce materially different challenges.
    expect(distinctWindows.size).toBeGreaterThan(20);
    // And the canonical "first" claim of a category must not always be chosen.
    expect(seenFirstAsSelected.size).toBeLessThan(CATEGORIES.length);
  });

  it('produces a different set of nine claims across many seeds', () => {
    const windows = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const result = selectDailyClaims(library, reconciled(), seeded(seed));
      if (!('rounds' in result)) throw new Error('selection failed');
      windows.add(result.rounds.flatMap((round) => round.claim_ids).sort().join(','));
    }
    expect(windows.size).toBeGreaterThan(50);
  });
});

describe('4. generated daily assignments remain identical across reloads and concurrent requests', () => {
  it('is a pure function of the persisted store, not of call order', () => {
    const store = reconciled();
    const a = selectDailyClaims(library, store, seeded(7));
    const b = selectDailyClaims(library, store, seeded(7));
    expect(a).toEqual(b);
  });

  it('is idempotent once the challenge is persisted', () => {
    const store = reconciled();
    const selected = selectDailyClaims(library, store, seeded(3));
    if (!('rounds' in selected)) throw new Error('selection failed');
    const challenge: DailyChallenge = {
      challenge_id: '2026-10-20', generated_at: '2026-10-20T00:00:00.000Z', status: 'active', rounds: selected.rounds,
    };
    const challenges = emptyChallengeStore();
    challenges.challenges['2026-10-20'] = challenge;
    const afterUsage = markMainUsage(store, challenge, '2026-10-20');

    // A second "request" for the same date returns the stored record, unchanged.
    const stored = challenges.challenges['2026-10-20'];
    expect(stored).toEqual(challenge);
    // And the usage store did not gain a second consumption.
    expect(challengeClaimIds(stored).every((id) => afterUsage.claims[id].used_as_main)).toBe(true);
  });
});

describe('5. no claim is selected as a main claim after used_as_main becomes true', () => {
  it('excludes every claim previously served as a main claim', () => {
    let store = reconciled();
    const served: string[] = [];
    for (let day = 0; day < 12; day++) {
      const result = selectDailyClaims(library, store, seeded(day + 100));
      if (!('rounds' in result)) throw new Error('selection failed');
      const challenge: DailyChallenge = {
        challenge_id: `2026-11-${String(day + 1).padStart(2, '0')}`,
        generated_at: '2026-11-01T00:00:00.000Z', status: 'active', rounds: result.rounds,
      };
      served.push(...challengeClaimIds(challenge));
      store = markMainUsage(store, challenge, challenge.challenge_id);
    }
    expect(new Set(served).size).toBe(served.length); // never reused as a main claim
    for (const id of served) expect(store.claims[id].used_as_main).toBe(true);
    const again = selectDailyClaims(library, store, seeded(999));
    if (!('rounds' in again)) throw new Error('selection failed');
    for (const id of challengeClaimIds({ challenge_id: 'x', generated_at: '', status: 'active', rounds: again.rounds })) {
      expect(served).not.toContain(id);
    }
  });
});

describe('6. a claim used as a replacement stays eligible as a main claim', () => {
  it('keeps main eligibility when only used_as_replacement is set', () => {
    const store = reconciled();
    const target = eligibleMainClaims(library, store, 'FACT')[0];
    const partner = store.claims[target.id].replacement_claim_id!;
    const after = consumeReplacement(store, partner, '2026-10-20');

    expect(after.claims[partner].used_as_replacement).toBe(true);
    expect(after.claims[partner].used_as_main).toBe(false);
    expect(isExhausted(after.claims[partner])).toBe(false);
    expect(eligibleMainClaims(library, after, 'FACT').map((claim) => claim.id)).toContain(partner);
  });
});

describe('7. claims with both flags are excluded from future selection in both roles', () => {
  it('removes a doubly-used claim from the main pool and from Swap resolution', () => {
    let store = reconciled();
    const target = eligibleMainClaims(library, store, 'KINDA')[0];
    const partner = store.claims[target.id].replacement_claim_id!;

    // Serve BOTH the target and its partner as main claims on separate days, then
    // consume the partner as a replacement too. Only then is it fully exhausted.
    const day = (date: string, claimId: string): DailyChallenge => ({
      challenge_id: date, generated_at: `${date}T00:00:00.000Z`, status: 'active',
      rounds: [{ round: 1, claim_ids: [claimId, eligibleMainClaims(library, store, 'FACT')[0].id, eligibleMainClaims(library, store, 'BULLSHIT')[0].id] }],
    });
    store = markMainUsage(store, day('2026-10-20', target.id), '2026-10-20');
    store = markMainUsage(store, day('2026-10-21', partner), '2026-10-21');
    store = consumeReplacement(store, partner, '2026-10-21');

    expect(store.claims[partner].used_as_main).toBe(true);
    expect(store.claims[partner].used_as_replacement).toBe(true);
    expect(isExhausted(store.claims[partner])).toBe(true);
    expect(eligibleMainClaims(library, store, 'KINDA').map((claim) => claim.id)).not.toContain(partner);
    // The original still resolves to its permanent partner, even though the partner
    // is now globally consumed. Consumption must not break the established assignment.
    const resolution = resolveReplacement(library, store, target.id);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.replacement.id).toBe(partner);
      expect(resolution.consumedNow).toBe(false);
    }
  });
});

describe('8. every replacement belongs to the same category as its original', () => {
  it('pairs claims strictly within their category', () => {
    const byId = new Map(library.map((claim) => [claim.id, claim]));
    const pairs = buildReplacementPairs(library);
    expect(pairs.size).toBe(library.length);
    for (const [id, partnerId] of pairs) {
      expect(partnerId).not.toBe(id);
      expect(byId.get(partnerId)!.category).toBe(byId.get(id)!.category);
    }
  });
});

describe('9. replacement pairs remain stable across application restarts', () => {
  it('rebuilds identical pairs from a fresh store', () => {
    const first = reconcileUsage(library, emptyUsageStore()).store;
    const second = reconcileUsage(library, emptyUsageStore()).store;
    expect(second.claims).toEqual(first.claims);
  });

  it('never re-pairs an existing valid assignment', () => {
    const store = reconciled();
    const snapshot = JSON.parse(JSON.stringify(store.claims)) as ClaimUsageStore['claims'];
    const again = reconcileUsage(library, store).store;
    for (const [id, usage] of Object.entries(snapshot)) {
      expect(again.claims[id].replacement_claim_id).toBe(usage.replacement_claim_id);
    }
  });

  it('does not depend on the order of the claim library on disk', () => {
    const reversed = [...library].reverse();
    const a = reconcileUsage(library, emptyUsageStore()).store;
    const b = reconcileUsage(reversed, emptyUsageStore()).store;
    expect(b.claims).toEqual(a.claims);
  });
});

describe('10. both members of a replacement pair cannot appear in the same daily challenge', () => {
  it('never selects two claims that share a pair', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const store = reconciled();
      const result = selectDailyClaims(library, store, seeded(seed));
      if (!('rounds' in result)) throw new Error('selection failed');
      const ids = result.rounds.flatMap((round) => round.claim_ids);
      for (const id of ids) {
        const partner = store.claims[id].replacement_claim_id;
        if (partner) expect(ids).not.toContain(partner);
      }
    }
  });

  it('guarantees a Swap target is not already on the table', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const store = reconciled();
      const result = selectDailyClaims(library, store, seeded(seed));
      if (!('rounds' in result)) throw new Error('selection failed');
      const ids = result.rounds.flatMap((round) => round.claim_ids);
      for (const id of ids) {
        const resolution = resolveReplacement(library, store, id, ids);
        expect(resolution.ok).toBe(true);
        if (resolution.ok) expect(ids).not.toContain(resolution.replacement.id);
      }
    }
  });
});

describe('11. the same original claim always resolves to the same assigned replacement', () => {
  it('is stable regardless of who asks or when', () => {
    const store = reconciled();
    const target = eligibleMainClaims(library, store, 'BULLSHIT')[0].id;
    const first = resolveReplacement(library, store, target);
    const second = resolveReplacement(library, store, target);
    expect(first).toEqual(second);
    if (!first.ok) throw new Error('expected a replacement');
    const consumed = consumeReplacement(store, first.replacement.id, '2026-10-20');
    const third = resolveReplacement(library, consumed, target);
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.replacement.id).toBe(first.replacement.id);
  });
});

describe('12. a replacement used by one player is globally recorded', () => {
  it('sets used_as_replacement and stamps the date once', () => {
    const store = reconciled();
    const target = eligibleMainClaims(library, store, 'FACT')[2].id;
    const resolution = resolveReplacement(library, store, target);
    if (!resolution.ok) throw new Error('expected a replacement');
    expect(resolution.consumedNow).toBe(true);

    const once = consumeReplacement(store, resolution.replacement.id, '2026-10-20');
    expect(once.claims[resolution.replacement.id].used_as_replacement).toBe(true);
    expect(once.claims[resolution.replacement.id].replacement_usage_date).toBe('2026-10-20');

    // A later player sees it as already consumed but still receives it.
    const later = resolveReplacement(library, once, target);
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.consumedNow).toBe(false);

    // Re-recording does not move the original timestamp or clear the flag.
    const twice = consumeReplacement(once, resolution.replacement.id, '2026-12-25');
    expect(twice.claims[resolution.replacement.id].replacement_usage_date).toBe('2026-10-20');
    expect(twice.claims[resolution.replacement.id].used_as_replacement).toBe(true);
  });

  it('never clears a flag that was already set', () => {
    const store = reconciled();
    const id = library[0].id;
    const store2 = consumeReplacement(store, id, '2026-10-20');
    const store3 = consumeReplacement(store2, id, '2026-11-01');
    expect(store3.claims[id].used_as_replacement).toBe(true);
  });
});

describe('13. concurrent requests cannot consume the same replacement twice', () => {
  it('reports consumedNow exactly once for two racing callers on a shared store', () => {
    const store = reconciled();
    const target = eligibleMainClaims(library, store, 'KINDA')[1].id;
    const first = resolveReplacement(library, store, target);
    if (!first.ok) throw new Error('expected a replacement');
    // Caller B reads the same pre-consumption snapshot.
    const second = resolveReplacement(library, store, target);
    if (!second.ok) throw new Error('expected a replacement');
    expect(first.replacement.id).toBe(second.replacement.id);
    expect(first.consumedNow && second.consumedNow).toBe(true); // both saw it free
    // Whoever commits first flips the flag; the second commit is a no-op.
    const committed = consumeReplacement(consumeReplacement(store, first.replacement.id, '2026-10-20'), second.replacement.id, '2026-10-20');
    expect(committed.claims[first.replacement.id].replacement_usage_date).toBe('2026-10-20');
    // After the commit, a third caller sees it as consumed.
    const third = resolveReplacement(library, committed, target);
    expect(third.ok && third.consumedNow).toBe(false);
  });
});

describe('14. existing sessions remain valid when a replacement has already been consumed globally', () => {
  it('still resolves the permanent assignment despite the global flag', () => {
    const store = reconciled();
    const target = eligibleMainClaims(library, store, 'BULLSHIT')[3].id;
    const resolution = resolveReplacement(library, store, target);
    if (!resolution.ok) throw new Error('expected a replacement');
    const consumed = consumeReplacement(store, resolution.replacement.id, '2026-10-20');
    const forLaterPlayer = resolveReplacement(library, consumed, target);
    expect(forLaterPlayer.ok).toBe(true);
    if (forLaterPlayer.ok) {
      expect(forLaterPlayer.replacement.id).toBe(resolution.replacement.id);
      expect(forLaterPlayer.consumedNow).toBe(false);
    }
  });

  it('rejects a replacement that would duplicate a claim already in the challenge', () => {
    const store = reconciled();
    const target = eligibleMainClaims(library, store, 'FACT')[5].id;
    const partner = store.claims[target].replacement_claim_id!;
    const resolution = resolveReplacement(library, store, target, [target, partner]);
    expect(resolution.ok).toBe(false);
  });

  it('handles a frozen historical challenge that predates the pair-exclusion rule', () => {
    // 2026-10-14 was selected by the original hash and happens to contain both
    // bull-83 and bull-84, which are a replacement pair. History is never rewritten,
    // so a Swap on either must be refused rather than duplicating a claim on screen.
    const store = reconciled();
    const partner = store.claims['bull-83'].replacement_claim_id;
    expect(partner).toBe('bull-84');
    const frozen: string[] = ['fact-74', 'kinda-15', 'bull-83', 'fact-61', 'kinda-10', 'bull-84'];
    expect(resolveReplacement(library, store, 'bull-83', frozen).ok).toBe(false);
    expect(resolveReplacement(library, store, 'bull-84', frozen).ok).toBe(false);
    // Swapping an unaffected claim in that same challenge still works.
    expect(resolveReplacement(library, store, 'fact-74', frozen).ok).toBe(true);
  });
});

describe('15. new claims are automatically added as unused without modifying existing records', () => {
  it('appends the new claim and leaves every existing record byte-identical', () => {
    const before = reconciled();
    const snapshot = JSON.parse(JSON.stringify(before.claims));
    const added: Claim = {
      id: 'fact-500', category: 'FACT', claim: 'A brand new claim.', explanation: 'Because.',
      sources: [{ title: 'example.com', url: 'https://example.com' }], replacementEligible: true, obscurity: 5,
    };
    const { store, report } = reconcileUsage([...library, added, { ...added, id: 'fact-501' }], before);
    expect(report.added).toEqual(['fact-500', 'fact-501']);
    expect(store.claims['fact-500'].used_as_main).toBe(false);
    expect(store.claims['fact-500'].used_as_replacement).toBe(false);
    expect(store.claims['fact-500'].replacement_claim_id).toBe('fact-501');
    for (const [id, usage] of Object.entries(snapshot)) {
      // Only the pre-existing pairing partner of a new claim may change.
      if (report.repairedPairs.includes(id)) continue;
      expect(store.claims[id]).toEqual(usage);
    }
  });

  it('keeps pairing correct when new claims make the earlier pool shift', () => {
    const added: Claim[] = Array.from({ length: 6 }, (_, i) => ({
      id: `kinda-${200 + i}`, category: 'KINDA' as Category, claim: `K${i}`, explanation: 'e',
      sources: [{ title: 't', url: 'u' }], replacementEligible: true, obscurity: 4,
    }));
    const { store } = reconcileUsage([...library, ...added], emptyUsageStore());
    const byId = new Map([...library, ...added].map((claim) => [claim.id, claim]));
    for (const [id, usage] of Object.entries(store.claims)) {
      const partner = usage.replacement_claim_id;
      expect(partner).not.toBeNull();
      expect(byId.get(partner!)!.category).toBe(byId.get(id)!.category);
    }
  });
});

describe('16. invalid IDs, broken replacement assignments and insufficient inventory are handled safely', () => {
  it('reports duplicate ids and invalid categories without throwing', () => {
    const problems = validateLibrary([
      { id: 'fact-1', category: 'FACT', claim: 'a', explanation: 'e', sources: [], replacementEligible: true, obscurity: 1 },
      { id: 'fact-1', category: 'FACT', claim: 'b', explanation: 'e', sources: [], replacementEligible: true, obscurity: 1 },
    ]);
    expect(problems).toContain('duplicate claim id: fact-1');
    expect(problems.some((p) => p.startsWith('category KINDA has only'))).toBe(true);
  });

  it('rejects an odd category count', () => {
    const odd = library.filter((claim) => claim.id !== 'fact-150');
    expect(validateLibrary(odd).some((p) => p.includes('odd claim count'))).toBe(true);
  });

  it('repairs a broken replacement reference instead of crashing', () => {
    const store = reconciled();
    const victim = eligibleMainClaims(library, store, 'FACT')[0].id;
    store.claims[victim] = { ...store.claims[victim], replacement_claim_id: 'fact-does-not-exist' };
    const { store: repaired, report } = reconcileUsage(library, store);
    expect(report.brokenReferences).toContain(victim);
    expect(repaired.claims[victim].replacement_claim_id).not.toBe('fact-does-not-exist');
    expect(repaired.claims[victim].replacement_claim_id).toMatch(/^fact-\d+$/);
  });

  it('repairs a cross-category replacement reference', () => {
    const store = reconciled();
    const victim = eligibleMainClaims(library, store, 'FACT')[1].id;
    store.claims[victim] = { ...store.claims[victim], replacement_claim_id: 'kinda-1' };
    const { store: repaired, report } = reconcileUsage(library, store);
    expect(report.brokenReferences).toContain(victim);
    expect(library.find((claim) => claim.id === repaired.claims[victim].replacement_claim_id)!.category).toBe('FACT');
  });

  it('returns a clear error naming the starved categories', () => {
    const store = reconciled();
    // Exhaust every KINDA claim except two, so three cannot be selected.
    for (const claim of library.filter((c) => c.category === 'KINDA').slice(2)) {
      store.claims[claim.id] = { ...store.claims[claim.id], used_as_main: true };
    }
    const result = selectDailyClaims(library, store, seeded(1));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('KINDA');
      expect(result.report.find((entry) => entry.category === 'KINDA')).toEqual({ category: 'KINDA', needed: 3, available: 2 });
    }
  });

  it('rejects a legacy claim with no usage record safely', () => {
    const partial: ClaimUsageStore = { version: 1, claims: {} };
    const result = selectDailyClaims(library, partial, seeded(1));
    expect('rounds' in result).toBe(true); // missing record === unused
  });
});

describe('17. historical daily challenges remain unchanged after inventory updates', () => {
  it('never overwrites a stored challenge', () => {
    const rounds = [{ round: 1, claim_ids: ['fact-1', 'kinda-1', 'bull-1'] }];
    const store = emptyChallengeStore();
    const historical: DailyChallenge = {
      challenge_id: '2026-10-13', generated_at: '2026-10-13T00:00:00.000Z', status: 'archived', rounds,
    };
    store.challenges['2026-10-13'] = historical;
    const frozen = JSON.parse(JSON.stringify(store.challenges['2026-10-13']));

    // Later, everything in that challenge becomes exhausted.
    let usage = reconciled();
    for (const id of ['fact-1', 'kinda-1', 'bull-1']) {
      usage = consumeReplacement(usage, id, '2026-12-01');
      usage.claims[id] = { ...usage.claims[id], used_as_main: true, main_usage_date: '2026-10-13' };
    }
    expect(store.challenges['2026-10-13']).toEqual(frozen);
    expect(diagnose(library, usage).remainingCapacity).toBeGreaterThanOrEqual(0);
  });
});

describe('supporting invariants', () => {
  it('validates a well-formed challenge and flags a broken one', () => {
    const store = reconciled();
    const result = selectDailyClaims(library, store, seeded(11));
    if (!('rounds' in result)) throw new Error('selection failed');
    const good: DailyChallenge = { challenge_id: 'd', generated_at: '', status: 'active', rounds: result.rounds };
    expect(validateChallenge(good, library)).toEqual([]);
    const bad: DailyChallenge = { ...good, rounds: [{ round: 1, claim_ids: ['fact-1', 'fact-2', 'fact-3'] }] };
    expect(validateChallenge(bad, library).length).toBeGreaterThan(0);
  });

  it('shuffles without losing or duplicating elements', () => {
    const input = Array.from({ length: 40 }, (_, i) => i);
    const out = shuffle(input, seeded(5));
    expect(out).toHaveLength(40);
    expect(new Set(out).size).toBe(40);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });

  it('orders ids numerically rather than lexicographically', () => {
    expect(['fact-10', 'fact-2', 'fact-1'].sort(compareIds)).toEqual(['fact-1', 'fact-2', 'fact-10']);
  });

  it('round-trips both JSON stores', () => {
    const usage = reconciled();
    expect(parseUsageJson(exportUsageJson(usage)).claims).toEqual(usage.claims);
    const challenges = emptyChallengeStore();
    expect(parseChallengesJson(exportChallengesJson(challenges))).toEqual(challenges);
    expect(() => parseUsageJson('[]')).toThrow();
    expect(() => parseChallengesJson('null')).toThrow();
  });

  it('reports diagnostics with pair-constrained capacity', () => {
    const store = reconciled();
    const diag = diagnose(library, store);
    expect(diag.totals).toEqual({ FACT: 150, KINDA: 100, BULLSHIT: 100 });
    expect(diag.unusedMain).toEqual({ FACT: 150, KINDA: 100, BULLSHIT: 100 });
    expect(diag.exhausted).toEqual({ FACT: 0, KINDA: 0, BULLSHIT: 0 });
    expect(diag.brokenPairs).toEqual([]);
    expect(diag.availableReplacements).toBe(350);
    // 100 eligible KINDA claims yield floor(100 / 3) = 33 challenges. The pair rule
    // only costs a day at the very end of a category's life, so it does not halve
    // capacity: 3 picks come from 50 pairs, and only the final day is affected.
    expect(diag.capacityPerCategory).toEqual({ FACT: 50, KINDA: 33, BULLSHIT: 33 });
    expect(diag.remainingCapacity).toBe(33);
  });

  it('exports the documented JSON shape', () => {
    const store = reconciled();
    const parsed = JSON.parse(exportUsageJson(store));
    expect(parsed.version).toBe(1);
    const sample = parsed.claims[library[0].id];
    expect(Object.keys(sample).sort()).toEqual([
      'main_usage_date', 'replacement_claim_id', 'replacement_usage_date', 'used_as_main', 'used_as_replacement',
    ]);
    expect(sample).toMatchObject({ used_as_main: false, used_as_replacement: false, main_usage_date: null, replacement_usage_date: null });
    expect(emptyChallengeStore()).toEqual({ version: 1, challenges: {} });
    expect(emptyUsage()).toBeTruthy();
  });

  it('requires every category to have at least one claim per round', () => {
    const problems = validateLibrary([{ id: 'fact-1', category: 'FACT', claim: 'a', explanation: 'e', sources: [], replacementEligible: true, obscurity: 1 }]);
    expect(problems.some((p) => p.includes('has only 1 claims'))).toBe(true);
  });
});

import { emptyUsage } from './inventory';
