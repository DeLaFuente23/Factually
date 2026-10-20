-- Global claim inventory + authoritative daily challenges.
--
-- Replaces the old client-side deterministic `makeChallenge()` selection with a
-- server-owned, randomly generated, permanently persisted assignment.
--
-- Two logical data stores are represented as tables:
--   claim_usage.claims          <-> claim-usage.json
--   challenge_assignments.rounds <-> daily-challenges.json
--
-- Both are exportable to those JSON files via public.inventory_export().

-- ---------------------------------------------------------------------------
-- claim-usage.json
-- ---------------------------------------------------------------------------
create table if not exists public.claim_usage (
  claim_id text primary key,
  category text not null check (category in ('FACT', 'KINDA', 'BULLSHIT')),
  used_as_main boolean not null default false,
  used_as_replacement boolean not null default false,
  replacement_claim_id text,
  main_usage_date date,
  replacement_usage_date date,
  -- Monotonic guard so a stale client can never regress a flag that is already set.
  updated_at timestamptz not null default now(),
  constraint claim_usage_no_self_pair check (replacement_claim_id is null or replacement_claim_id <> claim_id)
);

create index if not exists claim_usage_category_idx on public.claim_usage (category);
create index if not exists claim_usage_replacement_idx on public.claim_usage (replacement_claim_id);

-- Enforce one-to-one pairing on the replacement target as well: no two claims may
-- point at the same partner. A deferrable UNIQUE CONSTRAINT (rather than a plain
-- unique index) lets a bulk re-pairing inside one transaction settle before the
-- check runs, so transient duplicates during a rewrite are allowed.
--
-- If this migration ran before the constraint existed, it left a plain unique index
-- with the same name; drop that first so the two do not coexist.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'claim_usage_unique_replacement_target'
      and conrelid = 'public.claim_usage'::regclass
  ) then
    -- Already a real constraint from a previous run: nothing to do.
    return;
  end if;
  drop index if exists public.claim_usage_unique_replacement_target;
  alter table public.claim_usage
    add constraint claim_usage_unique_replacement_target
    unique (replacement_claim_id) deferrable initially immediate;
end $$;

-- ---------------------------------------------------------------------------
-- daily-challenges.json
-- ---------------------------------------------------------------------------
create table if not exists public.challenge_assignments (
  challenge_id text primary key,
  generated_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Nine primary claims, three per round, one per category per round.
  rounds jsonb not null,
  -- Set when the generator produced this row; NULL for back-filled history.
  generated_by text,
  constraint challenge_assignments_rounds_shape check (
    jsonb_typeof(rounds) = 'array' and jsonb_array_length(rounds) = 3
  )
);

-- Replacements consumed as a replacement, for audit/history.
create table if not exists public.replacement_events (
  id bigint generated always as identity primary key,
  challenge_date date not null,
  claim_id text not null,
  replacement_id text not null,
  consumed_at timestamptz not null default now()
);

create index if not exists replacement_events_replacement_idx on public.replacement_events (replacement_id);

-- ---------------------------------------------------------------------------
-- Locking helper: every global mutation takes this advisory lock so two
-- simultaneous requests cannot generate conflicting challenges or consume the
-- same replacement twice.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_lock()
returns void
language sql
volatile
as $$ select pg_advisory_xact_lock(918273645); $$;

-- ---------------------------------------------------------------------------
-- Seeding / reconciliation.
--
-- `p_claims` is the master library as a JSON array of {id, category}. New IDs are
-- appended as unused; existing rows are NEVER reset. Pairing is only filled in
-- where it is missing or broken, so assignments are stable across restarts.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_reconcile(p_claims jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_added text[] := '{}';
  v_repaired text[] := '{}';
  v_removed text[] := '{}';
  v_odd text[] := '{}';
  v_invalid text[] := '{}';
  v_dupes text[] := '{}';
  v_broken text[] := '{}';
begin
  perform public.inventory_lock();

  -- Structural validation -------------------------------------------------
  select coalesce(array_agg(d.claim_id), '{}')
    into v_dupes
  from (
    select c.value->>'id' as claim_id
    from jsonb_array_elements(p_claims) as c
    group by c.value->>'id'
    having count(*) > 1
  ) d;

  select coalesce(array_agg(c.value->>'id'), '{}')
    into v_invalid
  from jsonb_array_elements(p_claims) as c
  where c.value->>'category' not in ('FACT', 'KINDA', 'BULLSHIT');

  select coalesce(array_agg(o.category), '{}')
    into v_odd
  from (
    select c.value->>'category' as category
    from jsonb_array_elements(p_claims) as c
    group by c.value->>'category'
    having count(*) % 2 <> 0
  ) o;

  -- Append new claim IDs as unused. ON CONFLICT DO NOTHING guarantees existing
  -- usage records are preserved exactly.
  with inserted as (
    insert into public.claim_usage (claim_id, category)
    select distinct on (c.value->>'id') c.value->>'id', c.value->>'category'
    from jsonb_array_elements(p_claims) as c
    where c.value->>'category' in ('FACT', 'KINDA', 'BULLSHIT')
    order by c.value->>'id'
    on conflict (claim_id) do nothing
    returning claim_id
  )
  select coalesce(array_agg(claim_id), '{}') into v_added from inserted;

  -- Report (do not delete) claims that vanished from the master library.
  select coalesce(array_agg(cu.claim_id), '{}')
    into v_removed
  from public.claim_usage cu
  where not exists (
    select 1 from jsonb_array_elements(p_claims) c where c.value->>'id' = cu.claim_id
  );

  -- Snapshot broken references BEFORE repairing them, so the report is truthful.
  select coalesce(array_agg(cu.claim_id), '{}')
    into v_broken
  from public.claim_usage cu
  where cu.replacement_claim_id is not null
    and not exists (
      select 1 from public.claim_usage p
      where p.claim_id = cu.replacement_claim_id and p.category = cu.category
    );

  -- Snapshot rows that currently have no pairing at all (missing or invalid).
  select coalesce(array_agg(cu.claim_id), '{}')
    into v_repaired
  from public.claim_usage cu
  where cu.replacement_claim_id is null
     or not exists (
       select 1 from public.claim_usage p
       where p.claim_id = cu.replacement_claim_id and p.category = cu.category
     );

  -- Repair only broken/missing pairings. Existing valid pairs are left alone.
  --
  -- Pairing rule mirrors src/inventory.ts: within each category, sort claim IDs with
  -- a numeric-aware comparator and pair adjacent entries (ranks 1-2, 3-4, ...).
  with distinct_claims as (
    select distinct on (c.value->>'id') c.value->>'id' as claim_id, c.value->>'category' as category
    from jsonb_array_elements(p_claims) as c
    where c.value->>'category' in ('FACT', 'KINDA', 'BULLSHIT')
    order by c.value->>'id'
  ), ranked as (
    select
      claim_id,
      category,
      row_number() over (
        partition by category
        order by
          regexp_replace(claim_id, '\d+$', '') asc,
          nullif(regexp_replace(claim_id, '^.*?(\d+)$', '\1'), claim_id)::bigint asc,
          claim_id asc
      ) as rn
    from distinct_claims
  ), wanted as (
    select a.claim_id, b.claim_id as partner
    from ranked a
    join ranked b
      on b.category = a.category
     and b.rn = case when a.rn % 2 = 1 then a.rn + 1 else a.rn - 1 end
  )
  update public.claim_usage cu
     set replacement_claim_id = w.partner,
         updated_at = now()
    from wanted w
   where cu.claim_id = w.claim_id
     and (
       cu.replacement_claim_id is null
       or not exists (
         select 1 from public.claim_usage p
         where p.claim_id = cu.replacement_claim_id and p.category = cu.category
       )
     );

  -- Record what was repaired: rows whose partner was just changed or that pointed
  -- at an id absent from the library.

  return jsonb_build_object(
    'added', to_jsonb(v_added),
    'repairedPairs', to_jsonb(v_repaired),
    'removed', to_jsonb(v_removed),
    'brokenReferences', to_jsonb(v_broken),
    'invalidCategories', to_jsonb(v_invalid),
    'duplicateIds', to_jsonb(v_dupes),
    'unpairedCategories', to_jsonb(v_odd)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Selection helpers --------------------------------------------------------
-- ---------------------------------------------------------------------------

-- Main-eligible claim IDs in a category, with the pair key used to keep both
-- members of a pair out of the same challenge.
create or replace function public.inventory_eligible_main(p_category text)
returns table (claim_id text, pair_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select cu.claim_id,
         case when cu.replacement_claim_id is null then cu.claim_id
              else least(cu.claim_id, cu.replacement_claim_id) || '|' || greatest(cu.claim_id, cu.replacement_claim_id)
         end as pair_key
  from public.claim_usage cu
  where cu.category = p_category
    and cu.used_as_main = false
  order by cu.claim_id;
$$;

-- Randomised selection of nine claims: three per category from three distinct
-- replacement pairs, distributed one-per-category across three rounds.
--
-- Runs inside the transaction, so `inventory_lock()` serialises concurrent calls.
create or replace function public.inventory_select_rounds()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_categories text[] := array['FACT', 'KINDA', 'BULLSHIT'];
  v_picks jsonb := '{}'::jsonb;   -- category -> array of exactly 3 claim ids
  v_cat text;
  v_ids text[];
  v_needed int := 3;
begin
  foreach v_cat in array v_categories loop
    -- Pick one random claim per distinct replacement pair, then randomly choose
    -- three of those pairs. Distinct pairs guarantee a Swap target is never
    -- already on the table.
    select coalesce(array_agg(claim_id), '{}')
      into v_ids
    from (
      select claim_id
      from (
        select distinct on (pair_key) claim_id, pair_key
        from public.inventory_eligible_main(v_cat)
        order by pair_key, random()
      ) one_per_pair
      order by random()
      limit v_needed
    ) chosen;

    if coalesce(array_length(v_ids, 1), 0) < v_needed then
      raise exception 'INSUFFICIENT_INVENTORY:%', v_cat using errcode = 'P0001';
    end if;
    v_picks := jsonb_set(v_picks, array[v_cat], to_jsonb(v_ids));
  end loop;

  -- Distribute: shuffle each category's three picks, then round r takes the r-th
  -- pick per category. All nine ids are distinct because each list is distinct.
  return (
    select jsonb_agg(jsonb_build_object(
      'round', ord,
      'claim_ids', jsonb_build_array(
        v_picks->'FACT'->>((ord - 1)::int),
        v_picks->'KINDA'->>((ord - 1)::int),
        v_picks->'BULLSHIT'->>((ord - 1)::int)
      )
    ) order by ord)
    from generate_series(1, 3) as ord
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Authoritative challenge fetch/generate.
--
-- Returns the stored challenge for a date; generates and persists it exactly once.
-- Idempotent and safe under concurrency.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_get_or_create_challenge(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := to_char(p_date, 'YYYY-MM-DD');
  v_rounds jsonb;
  v_ids text[];
  v_row public.challenge_assignments;
begin
  perform public.inventory_lock();

  select * into v_row from public.challenge_assignments where challenge_id = v_key;
  if found then
    return jsonb_build_object(
      'challengeId', v_row.challenge_id,
      'generatedAt', v_row.generated_at,
      'status', v_row.status,
      'created', false,
      'rounds', v_row.rounds
    );
  end if;

  v_rounds := public.inventory_select_rounds();

  insert into public.challenge_assignments (challenge_id, rounds, status, generated_by)
  values (v_key, v_rounds, 'active', 'inventory_select_rounds')
  on conflict (challenge_id) do nothing;

  -- Re-read: if another transaction won the race we return its row, and we must
  -- NOT mark our (discarded) selection as used.
  select * into v_row from public.challenge_assignments where challenge_id = v_key;

  if v_row.rounds is distinct from v_rounds then
    return jsonb_build_object(
      'challengeId', v_row.challenge_id,
      'generatedAt', v_row.generated_at,
      'status', v_row.status,
      'created', false,
      'rounds', v_row.rounds
    );
  end if;

  select coalesce(array_agg(claim_text), '{}') into v_ids
  from jsonb_array_elements(v_row.rounds) r, jsonb_array_elements_text(r->'claim_ids') as claim_text;

  -- Mark all nine as used_as_main. Never clears a flag; never moves a first-use date.
  update public.claim_usage
     set used_as_main = true,
         main_usage_date = coalesce(main_usage_date, p_date),
         updated_at = now()
   where claim_id = any (v_ids);

  return jsonb_build_object(
    'challengeId', v_key,
    'generatedAt', v_row.generated_at,
    'status', v_row.status,
    'created', true,
    'rounds', v_row.rounds
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Back-fill a historical challenge (frozen snapshot, no usage mutation).
-- Used to preserve archive reproducibility for days that predate this system.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_import_challenge(
  p_date date,
  p_rounds jsonb,
  p_status text default 'archived'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := to_char(p_date, 'YYYY-MM-DD');
  v_ids text[];
begin
  perform public.inventory_lock();

  if jsonb_array_length(p_rounds) <> 3 then
    raise exception 'CHALLENGE_MUST_HAVE_THREE_ROUNDS';
  end if;

  insert into public.challenge_assignments (challenge_id, rounds, status, generated_by)
  values (v_key, p_rounds, p_status, null)
  on conflict (challenge_id) do nothing;

  -- Only mark usage if the row was actually new; never rewrite frozen history.
  select coalesce(array_agg(claim_text), '{}') into v_ids
  from jsonb_array_elements(p_rounds) r, jsonb_array_elements_text(r->'claim_ids') as claim_text;

  update public.claim_usage
     set used_as_main = true,
         main_usage_date = coalesce(main_usage_date, p_date),
         updated_at = now()
   where claim_id = any (v_ids);

  return jsonb_build_object('challengeId', v_key, 'rounds', p_rounds, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Global wildcard replacement resolution.
--
-- Assignment is permanent: claim A always resolves to A's partner, for every
-- player, forever. The global `used_as_replacement` flag records that the
-- replacement has been served at least once; it never invalidates an established
-- assignment. `consumedNow` reports whether THIS call performed the first
-- consumption, so the client knows it was the one that consumed it.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_resolve_replacement(
  p_claim_id text,
  p_date date,
  p_exclude text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage public.claim_usage;
  v_partner public.claim_usage;
  v_consumed_now boolean;
begin
  perform public.inventory_lock();

  select * into v_usage from public.claim_usage where claim_id = p_claim_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Unknown claim.');
  end if;
  if v_usage.replacement_claim_id is null then
    return jsonb_build_object('ok', false, 'reason', 'This claim has no permanent replacement assigned.');
  end if;

  select * into v_partner from public.claim_usage where claim_id = v_usage.replacement_claim_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'The assigned replacement is missing from the library.');
  end if;
  if v_partner.category <> v_usage.category then
    return jsonb_build_object('ok', false, 'reason', 'The assigned replacement is not in the same verdict.');
  end if;
  if v_partner.claim_id = any (p_exclude) then
    return jsonb_build_object('ok', false, 'reason', 'The assigned replacement is already in this challenge.');
  end if;

  v_consumed_now := not v_partner.used_as_replacement;

  if v_consumed_now then
    update public.claim_usage
       set used_as_replacement = true,
           replacement_usage_date = coalesce(replacement_usage_date, p_date),
           updated_at = now()
     where claim_id = v_partner.claim_id;

    insert into public.replacement_events (challenge_date, claim_id, replacement_id)
    values (p_date, p_claim_id, v_partner.claim_id);
  end if;

  return jsonb_build_object(
    'ok', true,
    'replacementId', v_partner.claim_id,
    'category', v_partner.category,
    'consumedNow', v_consumed_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Inventory diagnostics (admin/logging; never player-facing).
-- ---------------------------------------------------------------------------
create or replace function public.inventory_diagnostics()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with per_category as (
    select
      category,
      count(*)::int as total,
      count(*) filter (where not used_as_main and not used_as_replacement)::int as unused_main,
      count(*) filter (where used_as_main and not used_as_replacement)::int as used_main_only,
      count(*) filter (where not used_as_main and used_as_replacement)::int as used_replacement_only,
      count(*) filter (where used_as_main and used_as_replacement)::int as exhausted
    from public.claim_usage
    group by category
  ), eligible as (
    -- Main-eligible claims and the DISTINCT pairs represented among them.
    select
      u.category,
      count(*)::int as eligible,
      count(distinct least(u.claim_id, coalesce(u.replacement_claim_id, u.claim_id))
            || '|' || greatest(u.claim_id, coalesce(u.replacement_claim_id, u.claim_id)))::int as eligible_pairs
    from public.claim_usage u
    where not u.used_as_main
    group by u.category
  ), capacity as (
    -- Days of supply are bounded by the eligible claim pool (3 per challenge). The
    -- pair rule is a PER-DAY feasibility check, not a lifetime limit: a challenge
    -- consumes one claim per pair, but each pair still holds an unused member for a
    -- later day. So the bound is floor(eligible / 3), with a day only "lost" if
    -- fewer than 3 distinct pairs remain. In practice the claim count binds first.
    select e.category,
           case when e.eligible_pairs < 3 then 0 else floor(e.eligible / 3) end as challenges
    from eligible e
  )
  select jsonb_build_object(
    'totals', coalesce((select jsonb_object_agg(category, total) from per_category), '{}'::jsonb),
    'unusedMain', coalesce((select jsonb_object_agg(category, unused_main) from per_category), '{}'::jsonb),
    'usedMainOnly', coalesce((select jsonb_object_agg(category, used_main_only) from per_category), '{}'::jsonb),
    'usedReplacementOnly', coalesce((select jsonb_object_agg(category, used_replacement_only) from per_category), '{}'::jsonb),
    'exhausted', coalesce((select jsonb_object_agg(category, exhausted) from per_category), '{}'::jsonb),
    'availableReplacements', (select count(*)::int from public.claim_usage where not used_as_replacement),
    'brokenPairs', coalesce((
      select jsonb_agg(cu.claim_id)
      from public.claim_usage cu
      where cu.replacement_claim_id is null
         or not exists (
           select 1 from public.claim_usage p
           where p.claim_id = cu.replacement_claim_id and p.category = cu.category
         )
    ), '[]'::jsonb),
    'capacityPerCategory', coalesce((select jsonb_object_agg(category, challenges) from capacity), '{}'::jsonb),
    'remainingCapacity', (select coalesce(min(challenges), 0) from capacity)
  );
$$;

-- ---------------------------------------------------------------------------
-- JSON export, so the two data stores can be inspected and backed up.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_export()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'claimUsage', jsonb_build_object(
      'version', 1,
      'claims', coalesce((
        select jsonb_object_agg(claim_id, jsonb_build_object(
          'used_as_main', used_as_main,
          'used_as_replacement', used_as_replacement,
          'replacement_claim_id', replacement_claim_id,
          'main_usage_date', main_usage_date,
          'replacement_usage_date', replacement_usage_date
        ))
        from public.claim_usage
      ), '{}'::jsonb)
    ),
    'dailyChallenges', jsonb_build_object(
      'version', 1,
      'challenges', coalesce((
        select jsonb_object_agg(challenge_id, jsonb_build_object(
          'challenge_id', challenge_id,
          'generated_at', generated_at,
          'status', status,
          'rounds', rounds
        ))
        from public.challenge_assignments
      ), '{}'::jsonb)
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Permissions: server-only. Browsers reach these through the Edge Function.
-- ---------------------------------------------------------------------------
alter table public.claim_usage enable row level security;
alter table public.challenge_assignments enable row level security;
alter table public.replacement_events enable row level security;

revoke all on table public.claim_usage from public, anon, authenticated;
revoke all on table public.challenge_assignments from public, anon, authenticated;
revoke all on table public.replacement_events from public, anon, authenticated;
grant all on table public.claim_usage to service_role;
grant all on table public.challenge_assignments to service_role;
grant all on table public.replacement_events to service_role;

revoke all on function public.inventory_reconcile(jsonb) from public, anon, authenticated;
revoke all on function public.inventory_get_or_create_challenge(date) from public, anon, authenticated;
revoke all on function public.inventory_import_challenge(date, jsonb, text) from public, anon, authenticated;
revoke all on function public.inventory_resolve_replacement(text, date, text[]) from public, anon, authenticated;
revoke all on function public.inventory_diagnostics() from public, anon, authenticated;
revoke all on function public.inventory_export() from public, anon, authenticated;

grant execute on function public.inventory_reconcile(jsonb) to service_role;
grant execute on function public.inventory_get_or_create_challenge(date) to service_role;
grant execute on function public.inventory_import_challenge(date, jsonb, text) to service_role;
grant execute on function public.inventory_resolve_replacement(text, date, text[]) to service_role;
grant execute on function public.inventory_diagnostics() to service_role;
grant execute on function public.inventory_export() to service_role;
