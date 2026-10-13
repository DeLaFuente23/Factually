# Factually...

A local-first daily trivia and deduction game built with React, TypeScript, and Vite.

## Run locally

- Install Node.js 20 or newer.
- Run `npm install`.
- Run `npm run dev` and open the local URL shown by Vite.
- Run `npm test` for game-logic tests and `npm run build` for a production build.

## Deploy to Cloudflare Pages

Create a Pages project connected to this repository. Set the build command to `npm run build` and output directory to `dist`. No environment variables or server are required.

## Prototype notes

Daily challenges are deterministically selected from the bundled JSON library using the UTC date. The client-side data can be inspected by visitors. Game progress and personal results are stored locally in the browser (versioned key `factually.v1`); they do not sync across devices. The initial library has 18 records drawn from the supplied Factually_Final.txt.
