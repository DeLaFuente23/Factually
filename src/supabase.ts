import { createClient } from '@supabase/supabase-js';
import type { Claim } from './game';
import { CHALLENGE_VERSION } from './game';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
export const supabase = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : null;
export const communityConfigured = Boolean(supabase);

export type CommunitySubmission = {
  challengeDate: string;
  challengeVersion: string;
  browserToken: string;
  results: { claims: string[]; answers: (string | null)[]; life: number | null }[];
  wildcardUses: { name: string; round: number; claimId: string; replacementId?: string }[];
};

export async function submitCommunityGame(payload: CommunitySubmission) {
  if (!supabase) throw new Error('Community stats are not configured in this build.');
  const { data, error } = await supabase.functions.invoke('community', { body: { action: 'submit', ...payload } });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'The result could not be submitted.');
  return data as { ok: true; scoreSixths: number };
}

export async function fetchCommunityStats(challengeDate: string, challengeVersion: string) {
  if (!supabase) throw new Error('Community stats are not configured in this build.');
  const { data, error } = await supabase.functions.invoke('community', { body: { action: 'stats', challengeDate, challengeVersion } });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Community stats are unavailable.');
  return data as { ok: true; submissions: number; mode: 'expected' | 'real'; stats?: unknown };
}

// ---------------------------------------------------------------------------
// Authoritative daily challenge + global replacement inventory
//
// The daily challenge is generated and persisted server-side, so every player
// receives the same nine claims and no browser can influence selection. When the
// backend is not configured the app falls back to the bundled deterministic
// selector (see `start()` in main.tsx); in that offline mode the inventory is not
// shared, which is expected for local development and for the static preview.
// ---------------------------------------------------------------------------

export type ServerChallengeRound = {
  round: number;
  claims: Claim[];
  /** claimId -> permanently assigned replacement claimId (null when unpaired). */
  replacements: Record<string, string | null>;
};

export async function fetchDailyChallenge(challengeDate: string, challengeVersion: string) {
  if (!supabase) throw new Error('The daily challenge service is not configured in this build.');
  const { data, error } = await supabase.functions.invoke('community', { body: { action: 'challenge', challengeDate, challengeVersion } });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'The daily challenge is unavailable.');
  return data as {
    ok: true; challengeId: string; generatedAt: string | null;
    status: 'active' | 'archived'; created: boolean; rounds: ServerChallengeRound[];
  };
}

export async function resolveServerReplacement(challengeDate: string, claimId: string, exclude: string[]) {
  if (!supabase) throw new Error('The replacement inventory is not configured in this build.');
  const { data, error } = await supabase.functions.invoke('community', {
    body: { action: 'swap', challengeDate, challengeVersion: CHALLENGE_VERSION, claimId, exclude },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'No replacement is available.');
  return data as { ok: true; replacement: Claim; consumedNow: boolean };
}

