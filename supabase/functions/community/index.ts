import { createClient } from "npm:@supabase/supabase-js@2";
import { scoreRound, makeChallenge, CHALLENGE_VERSION } from "../../../src/game.ts";
import type { Category, Claim } from "../../../src/game.ts";
import { selectRotatedClaims, validateRotatedClaims, type RotationContext } from "../../../src/rotation.ts";
import claimData from "../../../src/claims.json" with { type: "json" };

const claims = claimData as Claim[];
const byId = new Map(claims.map((claim) => [claim.id, claim]));
const challengeVersion = CHALLENGE_VERSION;
const categories: Category[] = ["FACT", "KINDA", "BULLSHIT"];
const wildcardNames = ["One Off", "Swap", "Lifesaver"] as const;

// The day the server-owned inventory took over. Dates before this were selected
// by the original deterministic hash in `makeChallenge()`, and are frozen as
// historical snapshots rather than regenerated, so the archive keeps reproducing.
const INVENTORY_START_DATE = "2026-10-21";

type WildcardUse = { name: (typeof wildcardNames)[number]; round: number; claimId: string; replacementId?: string };
type ResultInput = { claims: string[]; answers: (Category | null)[]; life: number | null };
type StoredRound = { round: number; claim_ids: string[] };
type Payload = {
  action: "submit" | "stats" | "challenge" | "swap" | "diagnostics" | "rotation";
  challengeDate: string;
  challengeVersion?: string;
  browserToken?: string;
  results?: ResultInput[];
  wildcardUses?: WildcardUse[];
  claimId?: string;
  exclude?: string[];
  export?: string[];
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

/** The master library in the compact shape the reconciliation RPC expects. */
const libraryIndex = claims.map((claim) => ({ id: claim.id, category: claim.category }));

type Admin = ReturnType<typeof createClient>;

type StoredBoard = {
  challengeId: string;
  generatedAt: string | null;
  status: string;
  created: boolean;
  rounds: StoredRound[];
};

/** The board for a date, when it has already been generated. */
async function loadStoredChallenge(admin: Admin, date: string): Promise<StoredBoard | null> {
  const { data, error } = await admin
    .from("challenge_assignments")
    .select("challenge_id, generated_at, status, rounds")
    .eq("challenge_id", date)
    .maybeSingle();
  if (error || !data) return null;
  return {
    challengeId: (data.challenge_id as string) ?? date,
    generatedAt: (data.generated_at as string) ?? null,
    status: (data.status as string) ?? "active",
    created: false,
    rounds: (data.rounds as StoredRound[]) ?? [],
  };
}

/**
 * Builds the day with the rotation rules.
 *
 * The nine claims rotate through the library instead of being consumed: two
 * claims that have already shared a day never share a day again, a claim is
 * held back for a cooldown after it was shown to a player, and the fresh period
 * gives way to a period that mixes new claims with returning ones.
 *
 * The solver works in TypeScript so the rules can be proved by tests; the
 * database re-checks every rule before it stores anything, so an illegal day
 * can never be persisted. A rejected proposal means the state moved under us,
 * so the day is solved again from a fresh context.
 */
async function generateRotatedChallenge(
  admin: Admin,
  date: string,
): Promise<{ board: StoredBoard | null; error?: string; status?: number }> {
  const { error: stateError } = await admin.rpc("inventory_ensure_rotation_state");
  if (stateError) return { board: null, error: "The rotation could not be initialised." };

  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: context, error: contextError } = await admin.rpc("inventory_rotation_context", { p_date: date });
    if (contextError || !context?.ok) return { board: null, error: "The rotation inventory could not be read." };

    const solved = selectRotatedClaims(context as unknown as RotationContext);
    if (!("rounds" in solved)) {
      // Every claim is either on its cooldown or has already shared a day with
      // another one: no legal board exists for this date.
      return {
        board: null,
        error: "There are not enough available claims left to build today's challenge.",
        status: 409,
      };
    }

    const { data: commit, error: commitError } = await admin.rpc("inventory_commit_rotation", {
      p_date: date,
      p_rounds: solved.rounds,
    });
    if (!commitError && commit?.ok) {
      return {
        board: {
          challengeId: (commit.challengeId as string) ?? date,
          generatedAt: (commit.generatedAt as string) ?? null,
          status: (commit.status as string) ?? "active",
          created: Boolean(commit.created),
          rounds: (commit.rounds as StoredRound[]) ?? solved.rounds,
        },
      };
    }
    if (commitError && !String(commitError.message ?? "").includes("ROTATION_REJECTED")) {
      return { board: null, error: "The daily challenge could not be stored." };
    }
  }
  return { board: null, error: "The daily challenge could not be generated." };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return respond({ ok: false, error: "Use POST." }, 405);

  let body: Payload;
  try { body = await request.json() as Payload; }
  catch { return respond({ ok: false, error: "Invalid JSON body." }, 400); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.challengeDate ?? "")) {
    return respond({ ok: false, error: "Invalid challenge date." }, 400);
  }
  const parsedDate = new Date(`${body.challengeDate}T00:00:00Z`);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== body.challengeDate) return respond({ ok: false, error: "Invalid challenge date." }, 400);

  const secret = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!url || !secret) return respond({ ok: false, error: "Server configuration is incomplete." }, 500);
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

  // The authoritative challenge for a date. Generated once, shared by all players.
  if (body.action === "challenge") {
    // A client built against a different challenge shape must not be served.
    if (body.challengeVersion !== challengeVersion) return respond({ ok: false, error: "This challenge version is no longer active." }, 409);
    // Keep the usage inventory in step with the bundled library before selecting.
    const { error: reconcileError } = await admin.rpc("inventory_reconcile", { p_claims: libraryIndex });
    if (reconcileError) return respond({ ok: false, error: "The claim inventory could not be reconciled." }, 503);

    // Dates predating the inventory were chosen by the original deterministic hash.
    // Import that exact selection as a frozen snapshot the first time it is asked
    // for, so the archive reproduces reliably instead of being randomly regenerated.
    // `inventory_import_challenge` never overwrites an existing row.
    if (body.challengeDate < INVENTORY_START_DATE) {
      const historical = makeChallenge(body.challengeDate, claims).map((round, index) => ({
        round: index + 1,
        claim_ids: round.map((claim) => claim.id),
      }));
      const { error: importError } = await admin.rpc("inventory_import_challenge", {
        p_date: body.challengeDate,
        p_rounds: historical,
        p_status: "archived",
      });
      if (importError) return respond({ ok: false, error: "The archived challenge could not be restored." }, 503);
    }

    // The board for a date is generated once and shared by every player.
    const stored = await loadStoredChallenge(admin, body.challengeDate);
    const generated = stored
      ? { board: stored, error: "", status: 503 }
      : await generateRotatedChallenge(admin, body.challengeDate);
    const board = generated.board;
    if (!board) {
      return respond(
        { ok: false, error: generated.error || "The daily challenge is unavailable." },
        generated.status ?? 503,
      );
    }

    const rounds: StoredRound[] = board.rounds;
    // Resolve ids to full claims, and to each claim's permanent replacement, so the
    // client never needs to know the inventory. Swap targets are safe to disclose:
    // they are only shown once a player actually spends the wildcard.
    const resolved = rounds.map((round) => ({
      round: round.round,
      claims: round.claim_ids.map((id) => byId.get(id)).filter((claim): claim is Claim => Boolean(claim)),
      replacements: Object.fromEntries(round.claim_ids.map((id) => [id, null as string | null])),
    }));

    const { data: replacements } = await admin
      .from("claim_usage")
      .select("claim_id,replacement_claim_id")
      .in("claim_id", rounds.flatMap((round) => round.claim_ids));
    const replacementFor = new Map((replacements ?? []).map((row) => [row.claim_id as string, row.replacement_claim_id as string | null]));
    for (const round of resolved) {
      round.replacements = Object.fromEntries(round.claims.map((claim) => [claim.id, replacementFor.get(claim.id) ?? null]));
    }

    return respond({
      ok: true,
      challengeId: board.challengeId ?? body.challengeDate,
      generatedAt: board.generatedAt ?? null,
      status: board.status ?? "active",
      created: Boolean(board.created),
      rounds: resolved,
    });
  }

  // Administrative inventory inspection. Guarded by a shared secret so the
  // diagnostics and the raw JSON export are never reachable by players. Set
  // INVENTORY_ADMIN_TOKEN as an Edge Function secret to enable it.
  if (body.action === "diagnostics") {
    const expected = Deno.env.get("INVENTORY_ADMIN_TOKEN");
    const supplied = request.headers.get("x-inventory-token");
    if (!expected || supplied !== expected) return respond({ ok: false, error: "Not found." }, 404);
    const { data, error } = await admin.rpc("inventory_diagnostics");
    if (error) return respond({ ok: false, error: "Diagnostics are unavailable." }, 503);
    const exportRequested = Array.isArray(body.export) && body.export.length > 0;
    if (!exportRequested) return respond({ ok: true, diagnostics: data });
    const { data: dump, error: dumpError } = await admin.rpc("inventory_export");
    if (dumpError) return respond({ ok: false, error: "The inventory could not be exported." }, 503);
    return respond({ ok: true, diagnostics: data, claimUsage: dump?.claimUsage, dailyChallenges: dump?.dailyChallenges });
  }

  // Preview the rotation for a date without storing it. Runs the same solver and
  // the same validator the generator uses, so the rules can be inspected against
  // the live inventory before a day is committed.
  if (body.action === "rotation") {
    const expected = Deno.env.get("INVENTORY_ADMIN_TOKEN");
    const supplied = request.headers.get("x-inventory-token");
    if (!expected || supplied !== expected) return respond({ ok: false, error: "Not found." }, 404);

    const { error: stateError } = await admin.rpc("inventory_ensure_rotation_state");
    if (stateError) return respond({ ok: false, error: "The rotation could not be initialised." }, 503);

    const { data: context, error: contextError } = await admin.rpc("inventory_rotation_context", { p_date: body.challengeDate });
    if (contextError) return respond({ ok: false, error: "The rotation context could not be read." }, 503);
    if (!context?.ok) return respond({ ok: false, error: String(context?.error ?? "The rotation is not available.") }, 503);

    const rotationContext = context as unknown as RotationContext;
    const solved = selectRotatedClaims(rotationContext);
    if (!("rounds" in solved)) return respond({ ok: false, error: solved.error }, 409);

    return respond({
      ok: true,
      date: body.challengeDate,
      phase: solved.phase,
      composition: solved.composition,
      degraded: solved.degraded,
      rounds: solved.rounds,
      problems: validateRotatedClaims(rotationContext, solved.rounds),
      thresholds: rotationContext.thresholds,
      usedCounts: rotationContext.usedCounts,
      mixingStartedAt: rotationContext.mixingStartedAt,
    });
  }

  if (body.challengeVersion !== challengeVersion) return respond({ ok: false, error: "This challenge version is no longer active." }, 409);

  if (body.action === "stats") {
    const { data, error } = await admin.rpc("community_stats", { p_challenge_date: body.challengeDate, p_challenge_version: challengeVersion });
    if (error) return respond({ ok: false, error: "Community statistics are temporarily unavailable." }, 503);
    const submissions = Number(data?.submissions ?? 0);
    return respond({ ok: true, submissions, mode: submissions >= 100 ? "real" : "expected", stats: submissions >= 100 ? data : null });
  }

  // Resolve the permanent replacement for a claim. Assignment is permanent and
  // identical for everyone; consumption is recorded globally but never invalidates
  // an established assignment.
  if (body.action === "swap") {
    if (!body.claimId || !byId.has(body.claimId)) return respond({ ok: false, error: "Unknown claim." }, 400);
    const exclude = Array.isArray(body.exclude) ? body.exclude.filter((id) => byId.has(id)) : [];
    const { data, error } = await admin.rpc("inventory_resolve_replacement", {
      p_claim_id: body.claimId,
      p_date: body.challengeDate,
      p_exclude: exclude,
    });
    if (error) return respond({ ok: false, error: "The replacement could not be resolved." }, 503);
    if (!data?.ok) return respond({ ok: false, error: data?.reason ?? "No replacement is available." }, 409);
    const claim = byId.get(data.replacementId as string);
    if (!claim) return respond({ ok: false, error: "The assigned replacement is missing from the library." }, 503);
    return respond({ ok: true, replacement: claim, consumedNow: Boolean(data.consumedNow) });
  }

  if (body.action !== "submit") return respond({ ok: false, error: "Unknown action." }, 400);
  if (!body.browserToken || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.browserToken)) {
    return respond({ ok: false, error: "Invalid local submission token." }, 400);
  }
  if (!Array.isArray(body.results) || body.results.length !== 3 || !Array.isArray(body.wildcardUses)) {
    return respond({ ok: false, error: "A completed three-round result is required." }, 400);
  }

  try {
    const uses = body.wildcardUses;
    if (uses.length > 3 || new Set(uses.map((use) => use.name)).size !== uses.length || uses.some((use) => !wildcardNames.includes(use.name))) {
      throw new Error("Invalid wildcard use.");
    }
    const swapUses = uses.filter((use) => use.name === "Swap");

    // Validate against the PERSISTED assignment, not a recomputation. Randomised
    // selection means the server cannot derive the challenge from the date alone.
    const { data: stored, error: storedError } = await admin
      .from("challenge_assignments")
      .select("rounds")
      .eq("challenge_id", body.challengeDate)
      .maybeSingle();
    if (storedError) throw new Error("The daily challenge could not be verified.");
    if (!stored) throw new Error("This daily challenge has not been generated yet.");
    const rounds = stored.rounds as StoredRound[];

    const allClaimIds: string[] = [];
    const outcomes: { id: string; category: Category; selected: Category | null; correct: boolean; pointsSixths: number; round: number }[] = [];
    let classificationSixths = 0;

    for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
      const result = body.results[roundIndex];
      if (result.life !== null && (!Number.isInteger(result.life) || result.life < 0 || result.life > 2)) throw new Error("Invalid Lifesaver selection.");
      if (!Array.isArray(result.claims) || result.claims.length !== 3 || !Array.isArray(result.answers) || result.answers.length !== 3) {
        throw new Error("Each round must contain three claims and answers.");
      }
      if (result.answers.some((answer) => answer !== null && !categories.includes(answer))) throw new Error("Invalid category answer.");
      const roundClaims = result.claims.map((id) => byId.get(id));
      if (roundClaims.some((claim) => !claim)) throw new Error("Unknown claim.");
      const resolved = roundClaims as Claim[];
      if (new Set(resolved.map((claim) => claim.category)).size !== 3) throw new Error("Each round must contain one claim from each verdict.");

      const swap = swapUses.find((use) => use.round === roundIndex + 1);
      if (swapUses.some((use) => use.round < 1 || use.round > 3)) throw new Error("Invalid Swap round.");

      const expectedIds = new Set(rounds[roundIndex]?.claim_ids ?? []);
      if (expectedIds.size !== 3) throw new Error("The daily challenge is incomplete.");
      if (swap) {
        const original = byId.get(swap.claimId);
        const replacement = byId.get(swap.replacementId ?? "");
        if (!original || !replacement || !expectedIds.has(original.id)) throw new Error("Swap must target a claim in this challenge.");
        // The replacement must be the claim's PERMANENT partner, not any free claim.
        const { data: usage } = await admin.from("claim_usage").select("replacement_claim_id").eq("claim_id", original.id).maybeSingle();
        if (!usage || usage.replacement_claim_id !== replacement.id) throw new Error("Invalid same-category replacement.");
        if (original.category !== replacement.category) throw new Error("Invalid same-category replacement.");
        expectedIds.delete(original.id);
        expectedIds.add(replacement.id);
      }
      const actualIds = new Set(resolved.map((claim) => claim.id));
      if (actualIds.size !== expectedIds.size || [...expectedIds].some((id) => !actualIds.has(id))) throw new Error("Claims do not match this daily challenge.");
      allClaimIds.push(...resolved.map((claim) => claim.id));

      const oneOff = uses.find((use) => use.name === "One Off" && use.round === roundIndex + 1);
      if (oneOff) {
        const index = resolved.findIndex((claim) => claim.id === oneOff.claimId);
        if (index < 0 || result.answers[index] !== resolved[index].category) throw new Error("One Off must assign the revealed category.");
      }
      const lifesaver = uses.find((use) => use.name === "Lifesaver" && use.round === roundIndex + 1);
      if (lifesaver) {
        const protectedIndex = resolved.findIndex((claim) => claim.id === lifesaver.claimId);
        if (protectedIndex < 0 || result.life !== protectedIndex) throw new Error("Lifesaver target does not match the result.");
      } else if (result.life !== null) throw new Error("Unexpected Lifesaver protection.");

      const earned = scoreRound(resolved, result.answers, result.life);
      earned.forEach((points, index) => {
        classificationSixths += points;
        outcomes.push({
          id: resolved[index].id,
          category: resolved[index].category,
          selected: result.answers[index],
          correct: result.answers[index] === resolved[index].category,
          pointsSixths: points,
          round: roundIndex + 1,
        });
      });
    }
    if (new Set(allClaimIds).size !== 9) throw new Error("Duplicate claims are not allowed in one challenge.");
    if (uses.some((use) => !Number.isInteger(use.round) || use.round < 1 || use.round > 3 || !byId.has(use.claimId))) throw new Error("Invalid wildcard event details.");
    if (uses.some((use) => use.name === "Swap" && (!use.replacementId || !byId.has(use.replacementId)))) throw new Error("Missing Swap replacement.");
    const scoreSixths = Math.min(60, classificationSixths + (3 - uses.length) * 2);
    const { error } = await admin.from("daily_game_submissions").insert({
      challenge_date: body.challengeDate,
      challenge_version: challengeVersion,
      browser_token: body.browserToken,
      score_sixths: scoreSixths,
      claim_outcomes: outcomes,
      wildcard_usage: uses.map((use) => use.name),
    });
    if (error?.code === "23505") return respond({ ok: false, error: "A result was already submitted from this browser for that challenge." }, 409);
    if (error) return respond({ ok: false, error: "The result could not be saved." }, 503);
    return respond({ ok: true, scoreSixths });
  } catch (error) {
    return respond({ ok: false, error: error instanceof Error ? error.message : "Invalid result." }, 400);
  }
});
