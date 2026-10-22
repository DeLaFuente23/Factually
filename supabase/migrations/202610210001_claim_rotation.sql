-- Claim rotation.
--
-- Until now the daily challenge consumed nine claims that could never be seen
-- again, so the library was a finite resource that ran dry. This migration adds
-- the machinery for the nine to rotate instead:
--
--   * `claim_usage` gains a "last seen" date and an appearance counter, so a
--     claim can be held back for a while and then brought back.
--   * `challenge_claims` normalises the day's nine into one row per claim, so
--     "which claims have already shared a day" is an indexed lookup rather than
--     a scan of jsonb.
--   * `rotation_state` holds the one-way latch from the fresh period to the
--     mixed period, plus the threshold snapshot taken when the rotation began.
--
-- The selection itself is solved in TypeScript (see src/rotation.ts) and the
-- database re-checks every hard rule here before it persists a day, so an
-- illegal day can never be stored.

-- ---------------------------------------------------------------------------
-- 1. Exposure tracking.
--
-- `main_usage_date` and `replacement_usage_date` keep their "first time"
-- meaning for audit. The rotation needs the most recent exposure of each kind,
-- because a claim that was shown to a player - as one of the nine or as a Swap
-- replacement - must stay away for the length of the cooldown.
-- ---------------------------------------------------------------------------
alter table public.claim_usage
  add column if not exists last_main_usage_date date,
  add column if not exists last_exposure_date date,
  add column if not exists main_appearances integer not null default 0;

update public.claim_usage
   set last_main_usage_date = main_usage_date
 where last_main_usage_date is null
   and main_usage_date is not null;

update public.claim_usage
   set last_exposure_date = greatest(main_usage_date, replacement_usage_date)
 where last_exposure_date is null
   and (main_usage_date is not null or replacement_usage_date is not null);

update public.claim_usage
   set main_appearances = 1
 where used_as_main
   and main_appearances = 0;

-- ---------------------------------------------------------------------------
-- 2. The batch history.
--
-- One row per claim per day. Two claims that appear on the same day have
-- "shared a batch" and may never share a day again, so this table is what the
-- batch rule is checked against.
-- ---------------------------------------------------------------------------
create table if not exists public.challenge_claims (
  challenge_date date not null,
  claim_id text not null,
  category text not null check (category in ('FACT', 'KINDA', 'BULLSHIT')),
  round integer not null,
  primary key (challenge_date, claim_id)
);

create index if not exists challenge_claims_claim_idx on public.challenge_claims (claim_id);

-- Back-fill from the days that already exist.
insert into public.challenge_claims (challenge_date, claim_id, category, round)
select ca.challenge_id::date,
       c.claim_id,
       coalesce(cu.category, 'FACT'),
       c.rn
  from public.challenge_assignments ca
  cross join lateral jsonb_array_elements(ca.rounds) with ordinality as r(round_json, ord)
  cross join lateral jsonb_array_elements_text(r.round_json -> 'claim_ids') with ordinality as c(claim_id, rn)
  left join public.claim_usage cu on cu.claim_id = c.claim_id
on conflict (challenge_date, claim_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Rotation state.
--
-- A single row. `thresholds` is the snapshot of half of each category's library
-- size, taken the first time the rotation runs; it never moves afterwards, so
-- growing the library cannot change the date the mixed period starts.
-- `mixing_started_at` is the first day that was built from the mixed ladder.
-- ---------------------------------------------------------------------------
create table if not exists public.rotation_state (
  id boolean primary key default true,
  thresholds jsonb not null default '{}'::jsonb,
  mixing_started_at date,
  started_at date,
  updated_at timestamptz not null default now(),
  constraint rotation_state_singleton check (id)
);

-- ---------------------------------------------------------------------------
-- 4. Initialise the rotation.
--
-- Idempotent: the first call snapshots the thresholds, later calls return the
-- same row. The threshold for a category is half its library size, rounded up.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_ensure_rotation_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.rotation_state;
  v_thresholds jsonb;
begin
  perform public.inventory_lock();

  select * into v_state from public.rotation_state where id = true;
  if found then
    return jsonb_build_object(
      'ok', true,
      'thresholds', v_state.thresholds,
      'mixingStartedAt', v_state.mixing_started_at,
      'startedAt', v_state.started_at
    );
  end if;

  select coalesce(jsonb_object_agg(category, (n + 1) / 2), '{}'::jsonb)
    into v_thresholds
    from (
      select category, count(*)::int as n
        from public.claim_usage
       group by category
    ) s;

  insert into public.rotation_state (id, thresholds, started_at)
  values (true, v_thresholds, current_date)
  on conflict (id) do nothing;

  select * into v_state from public.rotation_state where id = true;

  return jsonb_build_object(
    'ok', true,
    'thresholds', v_state.thresholds,
    'mixingStartedAt', v_state.mixing_started_at,
    'startedAt', v_state.started_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The rotation context.
--
-- Everything the solver needs to build a day:
--   candidates - every claim, whether it has ever been one of the nine, when it
--                was last shown to a player, and which swap pair it belongs to
--   batches    - the nine claims of every stored day, so the solver knows which
--                claims have already shared a day
--   thresholds - the frozen fresh/mixed switch
--   usedCounts - how many claims of each category have been used, all time
-- ---------------------------------------------------------------------------
create or replace function public.inventory_rotation_context(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state public.rotation_state;
  v_candidates jsonb;
  v_batches jsonb;
  v_used jsonb;
begin
  select * into v_state from public.rotation_state where id = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'The rotation has not been initialised.');
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', cu.claim_id,
               'category', cu.category,
               'isNew', not cu.used_as_main,
               'lastExposureDate', cu.last_exposure_date,
               'pairKey', case
                           when cu.replacement_claim_id is null then cu.claim_id
                           else least(cu.claim_id, cu.replacement_claim_id)
                                || '|' || greatest(cu.claim_id, cu.replacement_claim_id)
                         end
             ) order by cu.claim_id
           ),
           '[]'::jsonb
         )
    into v_candidates
    from public.claim_usage cu;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('date', d.challenge_date, 'claimIds', to_jsonb(d.ids)) order by d.challenge_date
           ),
           '[]'::jsonb
         )
    into v_batches
    from (
      select cc.challenge_date, array_agg(cc.claim_id order by cc.claim_id) as ids
        from public.challenge_claims cc
       where cc.challenge_date <> p_date
       group by cc.challenge_date
    ) d;

  select coalesce(jsonb_object_agg(category, n), '{}'::jsonb)
    into v_used
    from (
      select cu.category, count(*)::int as n
        from public.claim_usage cu
       where cu.used_as_main
       group by cu.category
    ) s;

  return jsonb_build_object(
    'ok', true,
    'date', p_date,
    'candidates', v_candidates,
    'batches', v_batches,
    'thresholds', v_state.thresholds,
    'usedCounts', v_used,
    'mixingStartedAt', v_state.mixing_started_at,
    'cooldownDays', 21
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Commit a rotated day.
--
-- The database is the authority. A proposal that breaks any rule is rejected
-- with ROTATION_REJECTED and nothing is written; the caller re-solves and tries
-- again. A proposal for a day that already exists simply returns that day, so
-- two simultaneous requests can never produce two different boards.
--
-- Checks, in order: three rounds, nine distinct known claims, one claim per
-- verdict per round, at most one member of a swap pair, every claim off its
-- cooldown, and no two claims that have already shared a day.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_commit_rotation(p_date date, p_rounds jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := to_char(p_date, 'YYYY-MM-DD');
  v_row public.challenge_assignments;
  v_state public.rotation_state;
  v_ids text[];
  v_used_before jsonb;
  v_used_after jsonb;
  v_mixing date;
  v_categories constant text[] := array['FACT', 'KINDA', 'BULLSHIT'];
begin
  perform public.inventory_lock();

  select * into v_row from public.challenge_assignments where challenge_id = v_key;
  if found then
    return jsonb_build_object(
      'ok', true,
      'created', false,
      'challengeId', v_row.challenge_id,
      'generatedAt', v_row.generated_at,
      'status', v_row.status,
      'rounds', v_row.rounds
    );
  end if;

  select * into v_state from public.rotation_state where id = true;
  if not found then
    raise exception 'ROTATION_REJECTED: the rotation has not been initialised';
  end if;

  -- How much of each category has been used, before today's assignment.
  select coalesce(jsonb_object_agg(category, n), '{}'::jsonb)
    into v_used_before
    from (
      select cu.category, count(*)::int as n
        from public.claim_usage cu
       where cu.used_as_main
       group by cu.category
    ) s;

  -- Shape ------------------------------------------------------------------
  if p_rounds is null or jsonb_typeof(p_rounds) <> 'array' or jsonb_array_length(p_rounds) <> 3 then
    raise exception 'ROTATION_REJECTED: three rounds are required';
  end if;

  -- `r` is a single-column function alias, so `r` itself is the round's jsonb.
  select coalesce(array_agg(c.claim_id), '{}')
    into v_ids
    from jsonb_array_elements(p_rounds) r,
         jsonb_array_elements_text(r -> 'claim_ids') c(claim_id);

  if array_length(v_ids, 1) is distinct from 9 then
    raise exception 'ROTATION_REJECTED: a day needs exactly nine claims';
  end if;
  if (select count(distinct x.claim_id) from unnest(v_ids) as x(claim_id)) <> 9 then
    raise exception 'ROTATION_REJECTED: the nine claims must be distinct';
  end if;
  if exists (
    select 1 from unnest(v_ids) as x(claim_id)
     where not exists (select 1 from public.claim_usage cu where cu.claim_id = x.claim_id)
  ) then
    raise exception 'ROTATION_REJECTED: unknown claim';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_rounds) r
     where (
       select count(distinct cu.category)
         from jsonb_array_elements_text(r -> 'claim_ids') c(claim_id)
         join public.claim_usage cu on cu.claim_id = c.claim_id
     ) <> 3
  ) then
    raise exception 'ROTATION_REJECTED: each round needs one claim per verdict';
  end if;

  -- Swap pair rule ---------------------------------------------------------
  if exists (
    select 1
      from public.claim_usage cu
     where cu.claim_id = any (v_ids)
     group by case
                when cu.replacement_claim_id is null then cu.claim_id
                else least(cu.claim_id, cu.replacement_claim_id)
                     || '|' || greatest(cu.claim_id, cu.replacement_claim_id)
              end
    having count(*) > 1
  ) then
    raise exception 'ROTATION_REJECTED: two claims share a swap pair';
  end if;

  -- Cooldown ---------------------------------------------------------------
  if exists (
    select 1
      from public.claim_usage cu
     where cu.claim_id = any (v_ids)
       and cu.last_exposure_date is not null
       and cu.last_exposure_date > p_date - 21
  ) then
    raise exception 'ROTATION_REJECTED: a claim is inside its cooldown';
  end if;

  -- Batch rule -------------------------------------------------------------
  if exists (
    select 1
      from public.challenge_claims a
      join public.challenge_claims b
        on b.challenge_date = a.challenge_date
       and b.claim_id <> a.claim_id
     where a.claim_id = any (v_ids)
       and b.claim_id = any (v_ids)
  ) then
    raise exception 'ROTATION_REJECTED: two claims have already shared a day';
  end if;

  -- Persist ----------------------------------------------------------------
  insert into public.challenge_assignments (challenge_id, rounds, status, generated_by)
  values (v_key, p_rounds, 'active', 'inventory_commit_rotation')
  on conflict (challenge_id) do nothing;

  select * into v_row from public.challenge_assignments where challenge_id = v_key;
  if v_row.rounds is distinct from p_rounds then
    -- Another request won the race; its board is the one everybody plays.
    return jsonb_build_object(
      'ok', true,
      'created', false,
      'challengeId', v_row.challenge_id,
      'generatedAt', v_row.generated_at,
      'status', v_row.status,
      'rounds', v_row.rounds
    );
  end if;

  insert into public.challenge_claims (challenge_date, claim_id, category, round)
  select p_date, c.claim_id, cu.category, c.rn
    from jsonb_array_elements(p_rounds) with ordinality as r(value, ord)
    cross join lateral jsonb_array_elements_text(r.value -> 'claim_ids') with ordinality as c(claim_id, rn)
    join public.claim_usage cu on cu.claim_id = c.claim_id
  on conflict (challenge_date, claim_id) do nothing;

  update public.claim_usage cu
     set used_as_main = true,
         main_usage_date = coalesce(cu.main_usage_date, p_date),
         last_main_usage_date = p_date,
         last_exposure_date = p_date,
         main_appearances = cu.main_appearances + 1,
         updated_at = now()
   where cu.claim_id = any (v_ids);

  -- The fresh/mixed latch --------------------------------------------------
  -- One-way. The switch is checked after a day's claims are assigned, so the day
  -- that reaches the threshold is still a fresh day and the next one is the
  -- first mixed day.
  if v_state.mixing_started_at is null then
    select coalesce(jsonb_object_agg(category, n), '{}'::jsonb)
      into v_used_after
      from (
        select cu.category, count(*)::int as n
          from public.claim_usage cu
         where cu.used_as_main
         group by cu.category
      ) s;

    v_mixing := null;
    if (
      select coalesce(
               bool_and(coalesce((v_used_before ->> cat.name)::int, 0) >= coalesce((v_state.thresholds ->> cat.name)::int, 0)),
               false
             )
        from unnest(v_categories) as cat(name)
    ) then
      -- The thresholds were already met before today: today is the first mixed day.
      v_mixing := p_date;
    elsif (
      select coalesce(
               bool_and(coalesce((v_used_after ->> cat.name)::int, 0) >= coalesce((v_state.thresholds ->> cat.name)::int, 0)),
               false
             )
        from unnest(v_categories) as cat(name)
    ) then
      -- Today is the last fresh day; the next one mixes.
      v_mixing := p_date + 1;
    end if;

    if v_mixing is not null then
      update public.rotation_state
         set mixing_started_at = v_mixing,
             updated_at = now()
       where id = true
         and mixing_started_at is null;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'created', true,
    'challengeId', v_row.challenge_id,
    'generatedAt', v_row.generated_at,
    'status', v_row.status,
    'rounds', v_row.rounds
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Keep the older paths in step.
--
-- The legacy generator and the archived import still write days; they must
-- record the batch and the exposure date exactly like the rotated path, or the
-- batch history would have holes in it.
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
         last_main_usage_date = p_date,
         last_exposure_date = p_date,
         main_appearances = main_appearances + 1,
         updated_at = now()
   where claim_id = any (v_ids);

  insert into public.challenge_claims (challenge_date, claim_id, category, round)
  select p_date, c.claim_id, cu.category, c.rn
    from jsonb_array_elements(v_row.rounds) with ordinality as r(value, ord)
    cross join lateral jsonb_array_elements_text(r.value -> 'claim_ids') with ordinality as c(claim_id, rn)
    join public.claim_usage cu on cu.claim_id = c.claim_id
  on conflict (challenge_date, claim_id) do nothing;

  return jsonb_build_object(
    'challengeId', v_key,
    'generatedAt', v_row.generated_at,
    'status', v_row.status,
    'created', true,
    'rounds', v_row.rounds
  );
end;
$$;

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
         last_main_usage_date = p_date,
         last_exposure_date = p_date,
         main_appearances = main_appearances + 1,
         updated_at = now()
   where claim_id = any (v_ids);

  insert into public.challenge_claims (challenge_date, claim_id, category, round)
  select p_date, c.claim_id, cu.category, c.rn
    from jsonb_array_elements(p_rounds) with ordinality as r(value, ord)
    cross join lateral jsonb_array_elements_text(r.value -> 'claim_ids') with ordinality as c(claim_id, rn)
    join public.claim_usage cu on cu.claim_id = c.claim_id
  on conflict (challenge_date, claim_id) do nothing;

  return jsonb_build_object('challengeId', v_key, 'rounds', p_rounds, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. A Swap replacement is an exposure.
--
-- The player saw the claim, so it counts for the cooldown even though it was
-- never one of the nine. The permanent assignment is untouched, and the first
-- consumption is still recorded separately.
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

  -- Every serving is an exposure, not only the first one.
  update public.claim_usage
     set last_exposure_date = p_date,
         updated_at = now()
   where claim_id = v_partner.claim_id;

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
-- 9. Diagnostics and export, extended for the rotation.
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
    select
      u.category,
      count(*)::int as eligible,
      count(distinct least(u.claim_id, coalesce(u.replacement_claim_id, u.claim_id))
            || '|' || greatest(u.claim_id, coalesce(u.replacement_claim_id, u.claim_id)))::int as eligible_pairs
    from public.claim_usage u
    where not u.used_as_main
    group by u.category
  ), capacity as (
    select e.category,
           case when e.eligible_pairs < 3 then 0 else floor(e.eligible / 3) end as challenges
    from eligible e
  ), rotation as (
    select
      rs.thresholds,
      rs.mixing_started_at,
      rs.started_at,
      coalesce((
        select jsonb_object_agg(u.category, u.n)
          from (
            select cu.category, count(*)::int as n
              from public.claim_usage cu
             where cu.used_as_main
             group by cu.category
          ) u
      ), '{}'::jsonb) as used_counts,
      coalesce((
        select jsonb_object_agg(u.category, u.n)
          from (
            select cu.category, count(*)::int as n
              from public.claim_usage cu
             where not cu.used_as_main
             group by cu.category
          ) u
      ), '{}'::jsonb) as unused_counts
    from public.rotation_state rs
    where rs.id = true
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
    'remainingCapacity', (select coalesce(min(challenges), 0) from capacity),
    'rotation', (
      select jsonb_build_object(
        'thresholds', r.thresholds,
        'usedCounts', r.used_counts,
        'unusedCounts', r.unused_counts,
        'mixingStartedAt', r.mixing_started_at,
        'startedAt', r.started_at
      ) from rotation r
    ),
    'storedDays', (select count(*)::int from public.challenge_claims)
  );
$$;

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
          'replacement_usage_date', replacement_usage_date,
          'last_main_usage_date', last_main_usage_date,
          'last_exposure_date', last_exposure_date,
          'main_appearances', main_appearances
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
    ),
    'rotationState', coalesce((
      select jsonb_build_object(
        'thresholds', thresholds,
        'mixing_started_at', mixing_started_at,
        'started_at', started_at
      )
      from public.rotation_state
      where id = true
    ), '{}'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Permissions: server-only, exactly as for the inventory it extends.
-- ---------------------------------------------------------------------------
alter table public.challenge_claims enable row level security;
alter table public.rotation_state enable row level security;

revoke all on table public.challenge_claims from public, anon, authenticated;
revoke all on table public.rotation_state from public, anon, authenticated;
grant all on table public.challenge_claims to service_role;
grant all on table public.rotation_state to service_role;

revoke all on function public.inventory_ensure_rotation_state() from public, anon, authenticated;
revoke all on function public.inventory_rotation_context(date) from public, anon, authenticated;
revoke all on function public.inventory_commit_rotation(date, jsonb) from public, anon, authenticated;
grant execute on function public.inventory_ensure_rotation_state() to service_role;
grant execute on function public.inventory_rotation_context(date) to service_role;
grant execute on function public.inventory_commit_rotation(date, jsonb) to service_role;
