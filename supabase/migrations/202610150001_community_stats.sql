create table if not exists public.daily_game_submissions (
  id uuid primary key default gen_random_uuid(),
  challenge_date date not null,
  challenge_version text not null,
  browser_token uuid not null,
  score_sixths smallint not null check (score_sixths between 0 and 60),
  claim_outcomes jsonb not null check (jsonb_typeof(claim_outcomes) = 'array' and jsonb_array_length(claim_outcomes) = 9),
  wildcard_usage text[] not null default '{}',
  submitted_at timestamptz not null default now(),
  constraint daily_game_submissions_unique_browser_per_day unique (challenge_date, challenge_version, browser_token),
  constraint daily_game_submissions_valid_wildcards check (
    cardinality(wildcard_usage) <= 3 and
    wildcard_usage <@ array['One Off', 'Swap', 'Lifesaver']::text[]
  )
);

alter table public.daily_game_submissions enable row level security;
revoke all on table public.daily_game_submissions from public, anon, authenticated;
grant all on table public.daily_game_submissions to service_role;

create or replace function public.community_stats(p_challenge_date date, p_challenge_version text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with selected as (
    select score_sixths, wildcard_usage, claim_outcomes
    from public.daily_game_submissions
    where challenge_date = p_challenge_date and challenge_version = p_challenge_version
  ), outcomes as (
    select jsonb_array_elements(s.claim_outcomes) as outcome
    from selected s
  ), claims as (
    select
      outcome->>'id' as id,
      outcome->>'category' as category,
      count(*)::integer as responses,
      count(*) filter (where (outcome->>'correct')::boolean)::integer as correct
    from outcomes
    group by outcome->>'id', outcome->>'category'
  ), categories as (
    select
      category,
      sum(responses)::integer as responses,
      sum(correct)::integer as correct
    from claims
    group by category
  )
  select jsonb_build_object(
    'submissions', (select count(*)::integer from selected),
    'averageScore', coalesce((select avg(score_sixths)::numeric / 6 from selected), 0),
    'bins', jsonb_build_array(
      (select count(*)::integer from selected where score_sixths between 0 and 11),
      (select count(*)::integer from selected where score_sixths between 12 and 23),
      (select count(*)::integer from selected where score_sixths between 24 and 35),
      (select count(*)::integer from selected where score_sixths between 36 and 47),
      (select count(*)::integer from selected where score_sixths between 48 and 60)
    ),
    'wildcardAverage', coalesce((select avg(cardinality(wildcard_usage))::numeric from selected), 0),
    'claims', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'category', category, 'responses', responses, 'correct', correct
    ) order by id) from claims), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'category', category, 'responses', responses, 'correct', correct
    ) order by category) from categories), '[]'::jsonb)
  );
$$;

revoke all on function public.community_stats(date, text) from public, anon, authenticated;
grant execute on function public.community_stats(date, text) to service_role;

