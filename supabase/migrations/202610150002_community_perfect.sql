-- Adds a "perfect" count (games that earned a full 10/10) to the aggregate stats,
-- used by the "Perfect Game Potential" community card.

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
    'perfect', (select count(*)::integer from selected where score_sixths = 60),
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
