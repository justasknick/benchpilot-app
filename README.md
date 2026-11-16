# BenchPilot web app

This repository holds the **built** BenchPilot web app, published with GitHub Pages at
https://justasknick.github.io/benchpilot-app/

Do not edit files here by hand. The source lives in the private `benchpilot-extension` repository (`webapp/`).
To publish a new version: run `node scripts/build-webapp.mjs` there, copy the contents of `dist-webapp/` here on a
branch, and open a pull request.

Only public values are in this code (the Supabase URL and its publishable key, which row-level security limits).
