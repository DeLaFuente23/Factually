import { createClient } from "npm:@supabase/supabase-js@2";
import { makeChallenge, scoreRound } from "../../../src/game.ts";
import type { Category, Claim } from "../../../src/game.ts";
import claimData from "../../../src/claims.json" with { type: "json" };

const claims = claimData as Claim[];
const byId = new Map(claims.map((claim) => [claim.id, claim]));
const challengeVersion = 'claims-v1';
const categories: Category[] = ["FACT", "KINDA", "BULLSHIT"];
const wildcardNames = ["One Off", "Swap", "Lifesaver"] as const;
type WildcardUse = { name: (typeof wildcardNames)[number]; round: number; claimId: string; replacementId?: string };
type ResultInput = { claims: string[]; answers: (Category | null)[]; life: number | null };
type Payload = { action: "submit" | "stats"; challengeDate: string; challengeVersion?: string; browserToken?: string; results?: ResultInput[]; wildcardUses?: WildcardUse[] };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

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

  if (body.challengeVersion !== challengeVersion) return respond({ ok: false, error: "This challenge version is no longer active." }, 409);

  const secret = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!url || !secret) return respond({ ok: false, error: "Server configuration is incomplete." }, 500);
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

  if (body.action === "stats") {
    const { data, error } = await admin.rpc("community_stats", { p_challenge_date: body.challengeDate, p_challenge_version: challengeVersion });
    if (error) return respond({ ok: false, error: "Community statistics are temporarily unavailable." }, 503);
    const submissions = Number(data?.submissions ?? 0);
    return respond({ ok: true, submissions, mode: submissions >= 100 ? "real" : "expected", stats: submissions >= 100 ? data : null });
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
    const base = makeChallenge(body.challengeDate, claims);
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
      const expectedIds = new Set(base[roundIndex].map((claim) => claim.id));
      if (swap) {
        const original = byId.get(swap.claimId);
        const replacement = byId.get(swap.replacementId ?? "");
        if (!original || !replacement || !expectedIds.has(original.id) || original.category !== replacement.category || !replacement.replacementEligible) {
          throw new Error("Invalid same-category replacement.");
        }
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





