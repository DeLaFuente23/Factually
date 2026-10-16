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
