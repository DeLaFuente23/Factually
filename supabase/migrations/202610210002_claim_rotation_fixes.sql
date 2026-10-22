-- Two corrections to the rotation machinery, both found while checking the live
-- inventory against the real data.
--
-- 1. The archive import used to mark the claims of the *proposed* board as used
--    even when the day was already stored. Re-running it therefore marked claims
--    that were never played as used, and pulled the exposure date of claims that
--    had already appeared later back to the older day. It now records usage only
--    for the day it actually creates; a day that already exists keeps its stored
--    board and its recorded usage.
--
-- 2. A day can be stored out of order - the archive may ask for an older date
--    after a newer one exists. The exposure dates are the anchor of the
--    cooldown, so they must never move backwards. A trigger enforces that on
--    every write, whichever path made it.

-- ---------------------------------------------------------------------------
-- 1. The archive import.
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

  -- FOUND is false when the row was already there. The stored board wins, and its
  -- usage has already been recorded by whichever path created it.
  if not found then
    return jsonb_build_object('challengeId', v_key, 'rounds', p_rounds, 'status', p_status);
  end if;

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
-- 2. Exposure dates never move backwards.
--
-- The cooldown is measured from the last time a player saw a claim, so the
-- anchor has to be the latest such time. Writing an older day must not shorten
-- a claim's absence, or it could come back before its cooldown has passed.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_clamp_exposure_dates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.last_main_usage_date is null then
    new.last_main_usage_date := old.last_main_usage_date;
  elsif old.last_main_usage_date is not null and old.last_main_usage_date > new.last_main_usage_date then
    new.last_main_usage_date := old.last_main_usage_date;
  end if;

  if new.last_exposure_date is null then
    new.last_exposure_date := old.last_exposure_date;
  elsif old.last_exposure_date is not null and old.last_exposure_date > new.last_exposure_date then
    new.last_exposure_date := old.last_exposure_date;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists claim_usage_clamp_exposure on public.claim_usage;

create trigger claim_usage_clamp_exposure
before update on public.claim_usage
for each row execute function public.inventory_clamp_exposure_dates();

revoke all on function public.inventory_clamp_exposure_dates() from public, anon, authenticated;
grant execute on function public.inventory_clamp_exposure_dates() to service_role;
