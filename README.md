# F1 SIM

A multiplayer Formula 1 league. Today's real grid is the starting point; players' characters take seats as drivers, team principals and race engineers, in place of the real people. Race weekends are simulated lap by lap, and anyone holding a seat can make calls from their pit wall. Media and everyone else write for the Paddock.

**To set it up, follow [SETUP.md](SETUP.md).**

## What's in it

- **The Grid**: 11 teams, five seats each (team principal, two drivers, two race engineers). Race Control puts characters into seats or opens seats for applications.
- **Team HQ**: each team's car, budget and upgrades. Team principals order upgrades within a season budget and earn more from results; drivers spend development points earned from results.
- **Careers**: every driver's record, race by race, with head-to-heads against team-mates.
- **Race Weekend**: practice (engineers use limited runs to find the set-up the driver wants, and learn how long the tyres last), qualifying, then the race, run by Race Control a lap, five laps or the whole race at a time. Pit walls: driving mode, pit stops and tyres, team orders, and drivers refusing them.
- **Championship**: drivers' and constructors' standings. Points go to whoever drove the car that weekend.
- **Paddock**: news and interviews from the media, and paddock life from everyone else, with press notes from the latest race.
- **Your characters**: players make as many as they like and play one at a time.
- **Race Control**: seat applications, every character in the league, car tuning and an audit record. The Administrator also manages accounts, the invite code and backups.

## What's in this repository

```
site/                     the website (published by Cloudflare: output directory "site")
  index.html              page and styles
  app.js                  the app: race engine, Formula Racing V3.0 adapter, the league
  bridge.js               connects the app to Supabase: sign-in, data, live updates, images, downloads, Discord
  config.js               YOUR Supabase Project URL and publishable key (the only file you edit)
  manifest.webmanifest, sw.js, icon-*.png   installable on phones
  _headers, robots.txt    keep it out of search engines; no referrer leaks
functions/api/discord.js  Discord relay for posting race results (optional, see SETUP.md)
wrangler.jsonc, worker/   the same relay when the site runs as a Cloudflare Worker
supabase/migrations/      database set-up, applied automatically by GitHub Actions
.github/workflows/        database set-up, keep-awake, optional GitHub Pages
```

## How it fits together

- **Cloudflare** serves the site from this **private** repository. Free, unlimited bandwidth.
- **Supabase** holds the database, accounts and uploaded images (free plan: 500 MB database, 1 GB images).
- **GitHub Actions** sets up the database and keeps it awake, using three repository secrets.
- **Accounts** are usernames only, with an optional invite code. No email or personal data is collected.

## Updating

Replace the changed files, commit and push. Keep your `site/config.js`.
