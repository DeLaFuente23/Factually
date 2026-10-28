# Factually...

Three claims. Three verdicts. How well can you tell fact from fiction?

The world is full of facts so ridiculous they sound made up, half-truths that hide a catch, and convincing lies that seem perfectly reasonable. Factually... challenges you to tell them apart.

## How to play

Each round presents three surprising claims. Assign one FACT., one KINDA?, and one NOPE! (in Spanish: FACTO., ¿SUPONGO? and ¡NEL!). Complete three rounds to earn up to 10 points. Every claim includes an explanation and sources.

Daily challenges are selected server-side, once per date, and the same nine claims are served to every player. The claim library is public in the static app and can be inspected by visitors. Game progress and local results are stored in the browser under the versioned `factually.v2` key.

Verdict labels are display-only: `src/verdicts.ts` maps the stored values (`FACT`, `KINDA`, `BULLSHIT`) to what players read in each language. The database, the Edge Function and saved games keep the stored values, so renaming a label needs no migration.

## Pages and URLs

| Page | English | Spanish |
|---|---|---|
| Home | `/` | `/es` |
| How to play | `/how-to-play` | `/es/como-jugar` |
| Statistics | `/stats` | `/es/estadisticas` |
| Historical archive | `/archive` | `/es/archivo` |
| Today's game | `/play` | `/es/jugar` |
| Play a past day | `/archive/YYYY-MM-DD/play` | `/es/archivo/YYYY-MM-DD/jugar` |
| A past day's sources | `/archive/YYYY-MM-DD/sources` | `/es/archivo/YYYY-MM-DD/fuentes` |
| About, Contact | `/about`, `/contact` | `/es/acerca-de`, `/es/contacto` |
| Privacy, Terms | `/privacy`, `/terms` | `/es/privacidad`, `/es/terminos` |

`src/routes.ts` parses and builds these paths; the language toggle links to the same page in the other language. Site links are plain `<a href>` elements, and a click on one is turned into an in-app navigation.

A day's sources unlock once that day is over (UTC, like the daily challenge). Opening them marks the day in the browser (`factually.sources.viewed.v1`), and from then on that day can no longer be played in that browser unless it was already completed. Only today's game can be submitted to Daily Community Stats, so a game played after seeing the answers never counts.

## Run locally

Requirements: Node.js and pnpm.

```sh
pnpm install
pnpm dev
```

Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` if you want to connect to your Supabase project. The app can show expected community statistics without a configured backend; result submissions require the deployed Edge Function.

## Build and tests

```sh
pnpm test
pnpm build
```

## Global claim inventory and daily challenges

Daily challenges are generated **server-side, once per date**, and stored permanently. Every player receives the same nine claims and the same round assignment. Reloading, using another browser, or opening a second session never produces a different challenge.

Two logical data stores hold this state, and the rotation adds two tables beside them:

| Store | Table | Purpose |
|---|---|---|
| `claim-usage.json` | `public.claim_usage` | Per-claim usage flags and permanent replacement pairing |
| `daily-challenges.json` | `public.challenge_assignments` | The frozen nine claims for each date |
| — | `public.challenge_claims` | The same nine, normalised to one row per claim, so the batch rule is an indexed lookup |
| — | `public.rotation_state` | The threshold snapshot and the date the mixed period began |

The two files are exportable to JSON through `public.inventory_export()`, which returns exactly the two documented shapes so the inventory can be inspected and backed up.

### Usage model

Each claim tracks two **independent** flags, plus the dates the rotation needs:

- `used_as_main` — it has served as one of the nine primary claims at least once.
- `used_as_replacement` — it has been consumed as a wildcard replacement at least once.
- `main_usage_date` / `replacement_usage_date` — the **first** time each of those happened, kept for audit.
- `last_main_usage_date` — the most recent day it was one of the nine.
- `last_exposure_date` — the most recent day it was shown to a player in **any** capacity. A claim served as a Swap replacement was still shown, so it counts here as well.
- `main_appearances` — how many days it has been one of the nine.

The two flags stay independent: a claim consumed as a replacement can still be one of the nine, and a claim that has been one of the nine can still be a replacement target.

### Permanent replacement pairing

Every claim has a stable, same-category partner, formed once and persisted. Within each category, claim IDs are sorted with a numeric-aware comparator (so `fact-2` precedes `fact-10`) and adjacent entries are paired, giving disjoint one-to-one pairs. Pairing never depends on JSON, storage, or insertion order, and an existing valid pairing is never rewritten.

The daily selector draws each category's three claims from **three distinct pairs**, which guarantees a Swap target is never already on the table.

### Swap semantics

A claim always resolves to its permanent partner — the same claim, for every player, forever. The global `used_as_replacement` flag records that the partner has been served at least once; it **never** invalidates an already-established assignment. A later player swapping the same claim still receives the same partner, and the response's `consumedNow` flag reports whether that particular request performed the first consumption.

### Claim rotation

The nine claims of a day **rotate** through the library instead of being consumed once and never seen again. `src/rotation.ts` holds the rules, the solver and their tests; the database re-checks every rule before it stores a day, so an illegal board can never be persisted.

Four rules bind, in this order:

1. **Batch rule** — two claims that have ever shared a day may never share a day again. The batch is the whole nine, so the day's claims come from nine different earlier days.
2. **Swap-pair rule** — at most one member of a permanent swap pair per day, so a Swap can never put a duplicate on the table.
3. **Cooldown** — a claim cannot be used again until it has been absent for **21 days**. Absence is measured from the last time a player saw it, in any capacity.
4. **Composition** — the fresh period uses three new claims per category; the mixed period aims for two new and one returning.

The **fresh period** lasts until at least half of every category has been used. The threshold is a snapshot of half the library size, taken the first time the rotation runs, so growing the library later cannot move the switch date. When the threshold is reached the next day is the first **mixed** day, and from then on each category aims for two new and one returning claim.

The mix degrades one step at a time rather than failing a day: `2 new + 1 returning` → `1 new + 2 returning` → `3 new + 0 returning` → `0 new + 3 returning`. The switch is one-way — a day built from the mixed ladder stays mixed.

The rules govern the **nine the server selects**. A Swap is a player-initiated substitution to a fixed partner, and it is exempt from the batch rule and the cooldown check; the replacement it serves does, however, count as an exposure and pushes that claim's cooldown out.

The solver runs in TypeScript so the rules can be proved by tests (`src/rotation.test.ts`, including a three-hundred-day run that checks every rule on every day). The database is still the authority: `inventory_commit_rotation()` validates the shape, the swap pairs, the cooldown and the batch rule, and refuses anything illegal with `ROTATION_REJECTED`.

### Capacity

Unused claims are no longer a finite resource. The rotation recycles the library, so the library does not "run dry"; what limits the system is the **batch rule**. Any two claims may share a day at most once, and each day spends 36 of the `C(C-1)/2` possible pairs, so the rotation lives at most `C(C-1)/72` days: roughly 1,700 days at 350 claims and 4,900 days at 600. In practice a greedy solver runs out of legal combinations much earlier — around day 270 at 350 claims — so the library should keep growing, and a smarter solver would push that date out further.

`public.inventory_diagnostics()` reports the rotation state alongside the pool sizes: the threshold snapshot, how many claims of each category have been used, how many have never been used, and the date the mixed period began.

### Migration and back-fill

The migration seeds `claim_usage` from the bundled library with all flags `false`. Historical usage could not be reconstructed from the old client-only storage, so **the tracker begins at the migration date**: claims used before it are not retroactively marked.

Past daily challenges (`2026-10-13` onward) were originally selected by a deterministic hash. `scripts/backfill-history.cjs` reproduces them exactly and emits `supabase/backfill-history.sql`, which freezes them as permanent snapshots so the Archive keeps reproducing. Frozen history is never regenerated, even if the inventory changes later.

> **Known edge case:** the `2026-10-14` historical challenge contains both members of a replacement pair (`bull-83` and `bull-84`), which the newer pair-exclusion rule forbids. History is preserved unchanged, so a Swap on either claim in that one past challenge is refused rather than duplicating a claim on screen.

### Adding claims to the library

The Edge Function bundles `src/claims.json` at deploy time, and the server is what
selects the day's nine. **Pushing a new library to GitHub is not enough** — the
function has to be redeployed, or the database never learns the new claims:

```sh
npm run claims:validate     # check the library against git HEAD
supabase functions deploy community
```

Reconciliation is automatic: the next `challenge` request appends the new IDs as
unused (`used_as_main = false`) and repairs any missing pairing. Existing usage
records are never reset and existing pairs are never re-paired.

Two rules govern how claims may be added, because the permanent swap pairing is
built by pairing **adjacent IDs within each category**:

1. **Add an even number of claims per category.** An odd count leaves one claim per
   category without a swap partner, and `validateLibrary()` rejects the library.
2. **Continue the numbering from the bottom of the category** (`fact-151`+,
   `kinda-101`+, `bull-101`+). A new ID that sorts *between* existing IDs shifts the
   pairing of every claim after it, and the database keeps the old pairs — leaving
   claims pointing at partners that are already paired elsewhere.

`npm run claims:validate` enforces both rules, plus the per-claim field contract
(`id`, `category`, `claim`, `explanation`, `sources[]`, `obscurity` 1-10,
`replacementEligible`) and the requirement that existing claims are never removed.

### Deploying the inventory

Apply the migration and deploy the Edge Function:

```sh
supabase db push
supabase functions deploy community --no-verify-jwt
```

The rotation adds two migrations: `202610210001_claim_rotation.sql` (the exposure
dates, the batch history, the rotation state and the three rotation RPCs) and
`202610210002_claim_rotation_fixes.sql` (the archive import can no longer corrupt
the inventory, and exposure dates can never move backwards).

Historical challenges are imported automatically: the first time the archive asks
for a date before the inventory existed, that date's original hash-selected claims
are frozen as an immutable snapshot. `node scripts/backfill-history.cjs` also
generates `supabase/backfill-history.sql`, which can be run in the SQL editor to
pre-populate the same dates in one pass. The import only records usage for a day
it actually creates, so it is safe to run again over days that already exist.

### Previewing a day before it is stored

The `rotation` action runs the solver and the validator against the live
inventory without storing anything, so a day can be inspected before it is
committed. It is guarded by the same admin token as `diagnostics`:

```sh
curl -X POST "$SUPABASE_URL/functions/v1/community" \
  -H "content-type: application/json" \
  -H "x-inventory-token: $INVENTORY_ADMIN_TOKEN" \
  -d '{"action":"rotation","challengeDate":"2026-10-24","challengeVersion":"claims-v1"}'
```

The response carries the phase (`fresh` or `mixed`), the composition of each
category, the proposed rounds, and a `problems` array — empty when the day
obeys every rule.

### Checking the inventory

Set the admin token once (it enables the guarded `diagnostics` action; without it
the action returns `404` to everyone):

```sh
supabase secrets set INVENTORY_ADMIN_TOKEN=<a-long-random-string>
```

Then, from your machine, export both data stores as real files and print the
inventory summary:

```sh
npm run inventory:export
```

This writes `data/claim-usage.json` and `data/daily-challenges.json` and prints
the rotation state — the phase, the threshold snapshot, how many claims of each
category have been used and how many have never been used — alongside the pool
sizes, exhausted claims, available replacements and any broken pairs. The token
is read from the `INVENTORY_ADMIN_TOKEN` env var or `~/.factually-inventory-token`.

The "never used" count is the number that decides when the library needs more
claims: the mixed period spends two of them per category per day.

With the same token you can also read the raw JSON from the Supabase SQL editor:

```sql
select public.inventory_diagnostics();
select jsonb_pretty(public.inventory_export() -> 'claimUsage');
select jsonb_pretty(public.inventory_export() -> 'dailyChallenges');
```

If `VITE_SUPABASE_*` is not configured, the app falls back to the bundled deterministic selector so the board stays playable offline; in that mode the inventory is local and not shared.

## Supabase community statistics

The Leaderboard screen is now a daily community statistics screen. Before 100 accepted submissions, it shows a date-seeded estimate based on each daily claim’s `obscurity` rating. At 100 or more accepted submissions, it shows aggregates from completed games. Results are counted as submissions, not verified unique players.

Players must explicitly opt in on the final results screen before a submission is sent. The submission contains the challenge date, claim IDs and answers, wildcard usage, score inputs, and a random browser token. It does not include a name or email. Raw submissions have Row Level Security enabled and no public read policy; the Edge Function validates a result and calculates the stored score. CAPTCHA is not enabled in this first version.

### Deploy the Supabase backend

1. Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), then authenticate and link this repository to your project:

   ```sh
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```

2. In the Supabase Dashboard, open **Settings → API Keys** and copy your **secret key**. Set it as an Edge Function secret without adding it to `.env` or the frontend:

   ```sh
   supabase secrets set SUPABASE_SECRET_KEY=YOUR_SECRET_KEY
   ```

3. Apply the migration and deploy the function:

   ```sh
   supabase db push
   supabase functions deploy community
   ```

4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in your local `.env` and in Cloudflare Pages build environment variables. Never use the secret key in the frontend or Cloudflare Pages variables.

The migration creates a private submissions table and a server-only aggregate function. The Edge Function uses the same bundled claim data and daily selection logic as the app to validate the challenge, category assignments, wildcard usage, and calculated score before accepting a result. Each browser token can submit once per challenge date; clearing browser storage or using another browser can create another token, so counts must not be presented as verified unique people.

### Deploy to Cloudflare Pages

Build the app with `pnpm build` and deploy the generated `dist` directory. In Cloudflare Pages, use `pnpm build` as the build command and `dist` as the output directory. Configure the two `VITE_SUPABASE_*` public values in the project’s build environment before deploying.

`pnpm build` also prerenders static HTML (`scripts/prerender.mjs`) for home, How to play, About, Contact, Privacy, Terms, the historical archive and the sources page of every finished day, in both languages, plus `sitemap.xml`, `robots.txt` and `_redirects`. The archive comes from the Edge Function's public `archive` action, which lists stored days strictly before today, so **deploy the Edge Function before the first build** that includes this script. The build fails rather than publishing a site without the archive. To build offline, point `PRERENDER_ARCHIVE_JSON` at a file shaped like `{ "YYYY-MM-DD": [[ids], [ids], [ids]] }`.

Pages are written as `about.html`, `es/acerca-de.html` and so on, which Cloudflare Pages serves at `/about` and `/es/acerca-de`. Play routes are rewritten to a `noindex` shell (`app.html`). Any other path without a file gets `404.html` with a real 404 status; it loads the full app, so routes rendered in the browser (such as a day whose sources page has not been prerendered yet) still work, and anything else shows the 404 page.

New days are published by a rebuild after midnight UTC. Create a deploy hook in Pages (**Settings → Builds → Deploy hooks**), then deploy the cron Worker in `cloudflare/rebuild-cron`:

```sh
cd cloudflare/rebuild-cron
npx wrangler secret put DEPLOY_HOOK_URL
npx wrangler deploy
```

Expected brain-trap results use claims with the optional brain-trap editorial tag; until such tags are added, the highlight falls back to the hardest expected claim. In real-results mode both currently use low accuracy, so the same claim may appear in both highlights.
