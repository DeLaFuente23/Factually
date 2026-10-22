# Factually...

Three claims. Three verdicts. How well can you tell fact from fiction?

The world is full of facts so ridiculous they sound made up, half-truths that hide a catch, and convincing lies that seem perfectly reasonable. Factually... challenges you to tell them apart.

## How to play

Each round presents three surprising claims. Assign one FACT!, one KINDA?, and one BULLSH1T. Complete three rounds to earn up to 10 points. Every claim includes an explanation and sources.

Daily challenges are selected deterministically from the bundled JSON library using the UTC date. The claim library is public in the static app and can be inspected by visitors. Game progress and local results are stored in the browser under the versioned `factually.v2` key.

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

Two logical data stores hold this state:

| Store | Table | Purpose |
|---|---|---|
| `claim-usage.json` | `public.claim_usage` | Per-claim usage flags and permanent replacement pairing |
| `daily-challenges.json` | `public.challenge_assignments` | The frozen nine claims for each date |

Both are exportable to JSON through `public.inventory_export()`, which returns exactly the two documented shapes so the inventory can be inspected and backed up.

### Usage model

Each claim tracks two **independent** flags:

- `used_as_main` — it has served as one of the nine primary claims. It can never serve as a main claim again.
- `used_as_replacement` — it has been consumed as a wildcard replacement. It can never be consumed as a replacement again, but remains eligible as a **main** claim while `used_as_main` is false.

A claim is permanently exhausted only when **both** are true.

### Permanent replacement pairing

Every claim has a stable, same-category partner, formed once and persisted. Within each category, claim IDs are sorted with a numeric-aware comparator (so `fact-2` precedes `fact-10`) and adjacent entries are paired, giving disjoint one-to-one pairs. Pairing never depends on JSON, storage, or insertion order, and an existing valid pairing is never rewritten.

The daily selector draws each category's three claims from **three distinct pairs**, which guarantees a Swap target is never already on the table.

### Swap semantics

A claim always resolves to its permanent partner — the same claim, for every player, forever. The global `used_as_replacement` flag records that the partner has been served at least once; it **never** invalidates an already-established assignment. A later player swapping the same claim still receives the same partner, and the response's `consumedNow` flag reports whether that particular request performed the first consumption.

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

### Capacity

Selecting 3 main claims per category per day, the current library sustains **33 days** before any category starves (100 KINDA / 100 BULLSHIT at 3/day). FACT lasts 50 days. `public.inventory_diagnostics()` reports remaining capacity and the per-category breakdown; when a category runs out the challenge endpoint returns `409` naming the starved category instead of reusing exhausted claims.

### Deploying the inventory

Apply the migration and deploy the Edge Function:

```sh
supabase db push
supabase functions deploy community
```

Historical challenges are imported automatically: the first time the archive asks
for a date before the inventory existed, that date's original hash-selected claims
are frozen as an immutable snapshot. `node scripts/backfill-history.cjs` also
generates `supabase/backfill-history.sql`, which can be run in the SQL editor to
pre-populate the same dates in one pass.

### Checking how many days are left

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

This writes `data/claim-usage.json` and `data/daily-challenges.json` and prints the
remaining daily-challenge capacity per category, unused main claims, exhausted
claims, available replacements, and any broken pairs. The token is read from the
`INVENTORY_ADMIN_TOKEN` env var or `~/.factually-inventory-token`.

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

Expected brain-trap results use claims with the optional brain-trap editorial tag; until such tags are added, the highlight falls back to the hardest expected claim. In real-results mode both currently use low accuracy, so the same claim may appear in both highlights.
