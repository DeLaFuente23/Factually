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

export type ServerChallenge = {
  ok: true; challengeId: string; generatedAt: string | null;
  status: 'active' | 'archived'; created: boolean; rounds: ServerChallengeRound[];
};

export type ServerChallengeRound = {
  round: number;
  claims: Claim[];
  /** claimId -> permanently assigned replacement claimId (null when unpaired). */
  replacements: Record<string, string | null>;
};

// A date's challenge is generated once and never changes, so it is safe to cache.
// Caching makes a same-day revisit instant and saves a backend call, and it lets the
// prefetch below hide the request behind the time the player spends on the page.
// The entry is keyed by date and carries the challenge version, so bumping the
// version invalidates everything automatically.
const CACHE_KEY = 'factually.challenge.cache.v1';

type CacheEntry = { version: string; challenge: ServerChallenge };

const readCache = (): Record<string, CacheEntry> => {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
};

const writeCache = (cache: Record<string, CacheEntry>) => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* storage unavailable or full */ }
};

/** Requests already in flight, so a prefetch and a click share one call. */
const inFlight = new Map<string, Promise<ServerChallenge>>();

export function cachedDailyChallenge(challengeDate: string, challengeVersion: string): ServerChallenge | null {
  const entry = readCache()[challengeDate];
  return entry && entry.version === challengeVersion ? entry.challenge : null;
}

export function fetchDailyChallenge(challengeDate: string, challengeVersion: string): Promise<ServerChallenge> {
  if (!supabase) return Promise.reject(new Error('The daily challenge service is not configured in this build.'));
  const cached = cachedDailyChallenge(challengeDate, challengeVersion);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(challengeDate);
  if (pending) return pending;
  const request = supabase.functions
    .invoke('community', { body: { action: 'challenge', challengeDate, challengeVersion } })
    .then(({ data, error }) => {
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'The daily challenge is unavailable.');
      const challenge = data as ServerChallenge;
      // Only persist a fully formed challenge, so a partial response can never be replayed.
      if (Array.isArray(challenge.rounds) && challenge.rounds.length > 0) {
        const cache = readCache();
        cache[challengeDate] = { version: challengeVersion, challenge };
        writeCache(cache);
      }
      return challenge;
    })
    .finally(() => { inFlight.delete(challengeDate); });
  inFlight.set(challengeDate, request);
  return request;
}

/**
 * Warm the cache for a date without blocking anything. Fired when the app mounts so
 * the fetch happens while the player is still on the home screen, which is why the
 * board can be shown the instant they click. Failures are ignored: `start()` falls
 * back to a normal fetch (or the offline challenge) if this did not succeed.
 */
export function prefetchDailyChallenge(challengeDate: string, challengeVersion: string): void {
  if (!communityConfigured) return;
  fetchDailyChallenge(challengeDate, challengeVersion).catch(() => { /* best effort */ });
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

