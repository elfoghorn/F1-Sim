# Setting up F1 SIM

About an hour, start to finish, and nothing costs money. You'll end up with the site on Cloudflare at an address you choose, the code in a **private** GitHub repository, and the database, accounts and images on Supabase.

**Use a new Supabase project for F1 SIM.** Don't point it at a database another site already uses: the set-up assumes an empty project.

## Part 1: Supabase (about 10 minutes)

1. Sign in at **supabase.com** and click **New project**: name `f1-sim`, click *Generate* for the database password and **save it**, region West EU (London). Leave **"Automatically expose new tables"** unticked.
2. When it's ready, open **Settings → API Keys** (or **Connect**) and save the **Project URL** (`https://abcdefghijkl.supabase.co`; the part before `.supabase.co` is your **project reference**) and the **Publishable key** (`sb_publishable_…`). Never put the *secret* key or the database password in the repository.
3. **Authentication → Sign In / Providers → Email**: switch **Confirm email** off and **Save**. This is required; F1 SIM uses usernames, and no email is ever sent. Leave the Email provider itself on.
4. Your avatar → **Account preferences → Access Tokens → Generate new token**, name it `github-f1-sim`, and save the value.

## Part 2: The repository (about 10 minutes)

1. In **GitHub Desktop**: **File → New repository**, name it `f1-sim`, **Create repository**.
2. Copy everything from this package into that folder, including the hidden `.github` folder.
3. Open `site/config.js` and replace the two placeholders with your Project URL and publishable key.
4. **Commit to main**, then **Publish repository** with **"Keep this code private"** ticked.

## Part 3: Connect GitHub to Supabase (about 5 minutes)

On github.com, open the repository: **Settings → Secrets and variables → Actions → New repository secret**, and add:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the access token (Part 1, step 4) |
| `SUPABASE_DB_PASSWORD` | the database password (Part 1, step 1) |
| `SUPABASE_PROJECT_ID` | your project reference |

Then **Actions → Set up database → Run workflow**, and wait for the green tick.

## Part 4: Put the site online with Cloudflare (about 10 minutes)

1. At **cloudflare.com** (free plan): **Workers & Pages → Create → Pages → Connect to Git**, and allow it to see only the `f1-sim` repository.
2. Project name (this becomes the address, e.g. `f1-sim.pages.dev`), production branch `main`, framework preset **None**, build command empty, **build output directory `site`**.
3. **Save and Deploy**. From now on every push publishes automatically.

If you run it as a Worker (`*.workers.dev`) instead, `wrangler.jsonc` sets it up; its `name` must match the Worker's name in Cloudflare.

## Part 5: Your league (about 10 minutes)

1. Open the site and choose **Create an account**. **The first account becomes the Administrator**, with Race Control.
2. On **Home**, choose **Load today's grid**: 11 teams with their real drivers and team principals, and 23 circuits.
3. Make a character of your own if you'll play too (**Your characters**).
4. On **The Grid**, open the seats you want players to apply for, or put characters straight into seats.

## Part 6: Test before inviting anyone (about 15 minutes)

In a private window:
- [ ] Create a second account. It should be a **player**.
- [ ] Make a driver character and apply for an open seat. As Race Control, approve it on **Race Control**: the character should replace the real driver on The Grid.
- [ ] Open a weekend on **Race Weekend**. As the player, send a pit-wall call; as Race Control, run a lap and check the call appears in the race log.
- [ ] Run to the flag and check **Championship**.
- [ ] As the player, try to open Race Control's pages: they should say they're for Race Control.

## Part 7: Invite players

1. **Accounts and backups → Invite code → Generate a code.** The system makes a 10-character code (no O, 0, I or 1). Copy it straight away: it's shown only once. Every new account needs it; until you generate one, sign-ups are closed. Generate a new code any time (the old one stops working), or **Close sign-ups**.
2. Send players the site address and the code. They create an account, then a character.
3. To give someone Race Control, change their role on **Accounts and backups**. Only the Administrator changes roles.

## Optional: post to Discord (about 10 minutes)

Race Control can post race results, timing exports, announcements and driver cards to Discord. Discord doesn't accept posts straight from a web page, so the site uses a small relay, `functions/api/discord.js`, which Cloudflare runs alongside the site. It keeps every webhook as an encrypted secret and only accepts posts from Race Control.

1. In Discord, for each channel you want to post to: **Server Settings → Integrations → Webhooks → New Webhook**, pick the channel, name it `F1 SIM`, **Copy Webhook URL**.
2. In Cloudflare: **Workers & Pages → your project → Settings → Variables and Secrets → Add**, type **Secret**, with a name from the table below and the webhook URL as the value.
3. **Redeploy** (push any change, or **Retry deployment**). On the **Race Control** page, **Discord channels → Check the channels** shows which are set up and where each kind of post goes.

| Secret name | What posts there |
| --- | --- |
| `DISCORD_WEBHOOK` | Required. Everything that doesn't have its own channel. |
| `DISCORD_WEBHOOK_RESULTS` | Race results, and result exports. |
| `DISCORD_WEBHOOK_TIMING` | Practice, qualifying and live timing exports. |
| `DISCORD_WEBHOOK_ANNOUNCEMENTS` | Race Control announcements. |
| `DISCORD_WEBHOOK_CARDS` | Driver cards: signings, poles, wins, Driver of the Day. |
| `DISCORD_WEBHOOK_CALENDAR` | The season calendar. |
| `DISCORD_WEBHOOK_STANDINGS` | Drivers' and constructors' championship standings. |
| `DISCORD_WEBHOOK_APPROVALS` | Acceptance cards when Race Control approves a character, @mentioning the player. |
| `DISCORD_WEBHOOK_TRANSFERS` | Transfer cards when Race Control moves a character to another team, @mentioning the player. |
| `DISCORD_WEBHOOK_ANNOUNCEMENTS` | Race Control announcements, including each race weekend's stages as they happen (switch these on or off on the Race Control page). Any series can have its own: `DISCORD_WEBHOOK_WEC_ANNOUNCEMENTS`, `DISCORD_WEBHOOK_F2_ANNOUNCEMENTS`. Covers race weekend stages too. |
| `DISCORD_WEBHOOK_GRID` | The grid: one post that Race Control keeps up to date (it's edited in place as seats change). Each series' grid goes to `DISCORD_WEBHOOK_<SERIES>_GRID` if set, else that series' teams channel (`DISCORD_WEBHOOK_F1_TEAMS`, `_F2_TEAMS`, `_F3_TEAMS`), else `DISCORD_WEBHOOK_GRID`, else `DISCORD_WEBHOOK_TEAMS`, else the default. `_TEAM` and `_TEAMS` both work. |
| `DISCORD_WEBHOOK_TEAMS` | Team cards from the Teams pages ("Export the team card" and "Post every team"). |
| `DISCORD_WEBHOOK_F2_TEAMS`, `DISCORD_WEBHOOK_F3_TEAMS` | Team cards for Formula 2 or Formula 3 teams only. Any series works: `DISCORD_WEBHOOK_<SERIES>_TEAMS`. |
| `DISCORD_WEBHOOK_TEAM_<TEAM>` | A channel for one team, e.g. `DISCORD_WEBHOOK_TEAM_MCLAREN`, `DISCORD_WEBHOOK_TEAM_REDBULL`, `DISCORD_WEBHOOK_TEAM_F2_PREMA`. The team's card panel shows its exact name. A team card goes to its team's channel first, then its series' teams channel, then `DISCORD_WEBHOOK_TEAMS`, then the standings channel, then the default. |

For a separate channel per series, put the series code first: `DISCORD_WEBHOOK_F2_RESULTS`, `DISCORD_WEBHOOK_F3_TIMING`. A post tries the series channel, then the general one, then `DISCORD_WEBHOOK`. When exporting timing, Race Control can also pick any channel by hand.

**Optional: pinging players.** Acceptance cards mention the player's Discord username. To make that a real ping, add a small bot:
1. At discord.com/developers/applications choose **New Application**, open **Bot**, choose **Reset Token**, copy the token, and turn on **Server Members Intent**.
2. Under **OAuth2 → URL Generator** tick **bot** (no permissions needed), open the link it makes, and add the bot to your server.
3. In Discord, turn on Developer Mode (Settings → Advanced), right-click your server's icon and choose **Copy Server ID**.
4. In Cloudflare add two secrets: `DISCORD_BOT_TOKEN` (the token) and `DISCORD_GUILD_ID` (the server ID), then redeploy.

Without them, posts still go out, with the @username written as plain text.

Treat webhook URLs like passwords. If one leaks, delete it in Discord and make a new one.

## Phones

F1 SIM works in any phone browser. To install it like an app: on iPhone, **Share → Add to Home Screen**; on Android, **⋮ → Add to Home screen**.

## Backups

The free plan has no automatic backups. Every few race weekends, download one from **Accounts and backups** and keep it somewhere safe, not in the repository. **Restore a backup** brings one back.

## Troubleshooting

| You see | Do this |
|---|---|
| **"Almost there"** on the site | `site/config.js` still has the placeholders. Fill it in, commit and push. |
| A blank page or 404 on Cloudflare | **Build output directory** must be `site`. Then **Retry deployment**. |
| **Set up database** is red: *Secrets missing* | Add the three secrets (Part 3) and run it again. |
| **Set up database** is red: *password authentication failed* | `SUPABASE_DB_PASSWORD` is wrong. Reset it in Supabase, update the secret, run again. |
| **"Your account isn't set up in the database yet"** | The database workflow hasn't run successfully. Run **Set up database**. |
| **"Email address … is invalid"** when signing up | **Confirm email** is still on (Part 1, step 3). |
| A player forgot their password | **Accounts and backups → Reset password**. |
| **"Project paused"** in Supabase | Resume it, then **Actions → Keep database awake → Enable workflow**. |
| The site shows an old version | Hard-refresh: **Ctrl + Shift + R**. On a phone, close the app fully and reopen it. |
| *"No Discord webhook is set up yet"* | The secrets must be named `DISCORD_WEBHOOK` (or `DISCORD_WEBHOOK_…`, see the table in the Discord section) and apply from the next deployment. |

## What the database enforces

- Only signed-in members can read anything.
- Only Race Control changes the grid, ratings, cars, circuits and race weekends.
- Characters, seat applications, paddock posts and pit-wall calls belong to the account that made them: only that account, or Race Control, can change or delete them.
- Race Control checks every pit-wall call against the seats before it reaches the race.
- Only the Administrator changes roles, and nobody can promote themselves.
- Every new account needs the current invite code (only the first account, the Administrator's, doesn't). Codes are generated by the database and stored only as a one-way hash. Signing in to an existing account never needs a code.

## Privacy

Accounts are a username and a password (stored as a hash by Supabase). Each username becomes an internal sign-in name on your own Supabase domain; nothing is ever sent to it. No real name, email or contact detail is asked for. Characters are fiction; real drivers and team principals appear in race results only.

## Autopilot: races that run themselves

Give a race weekend a timetable and it runs by itself: practice sessions, qualifying and the race happen when they're due, the race moves on at the speed you chose, and the Discord announcements go out, whether or not anyone from Race Control is online. The autopilot uses the site's own rules: it's a hidden browser signed in as a Race Control "robot" account, doing what Race Control's buttons do.

### 1. Make the robot account (once)

1. Sign out, then create a new account on the site with an invite code (Accounts and backups → Invite code). Call it something like `autopilot` and give it a long password that you don't use anywhere else.
2. Sign back in as yourself, go to **Accounts and backups → Accounts**, and set the robot account's role to **Race Control**.

### 2. Let GitHub run it (once)

1. In the GitHub repository: **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Add:
   - `F1SIM_RUNNER_USER`: the robot account's username
   - `F1SIM_RUNNER_PASSWORD`: its password
2. Still under **Actions**, open the **Variables** tab and add `F1SIM_AUTOPILOT` with the value `on`.
3. Check it works: **Actions → Race autopilot → Run workflow**. After a couple of minutes the run should be green, and on a weekend with the autopilot on, the Autopilot card says when it last checked in.

The workflow checks every 10 minutes while `F1SIM_AUTOPILOT` is `on`. Set it to `off` between race weekends: the scheduled runs are then skipped straight away and use no Actions minutes. (Public repositories have unlimited Actions minutes; private ones have 2,000 a month on the free plan, and each check uses about 2.)

Optional variables:
- `F1SIM_SITE_URL`: the site's address, if it isn't https://f1-rp-sim.co.uk/
- `F1SIM_AUTOPILOT_MINUTES`: keep checking every minute for that many minutes each run (for example `9`), so races move on minute by minute instead of every 10 minutes. This uses about 10 Actions minutes per run.

GitHub may delay scheduled runs by a few minutes when it's busy; the autopilot always catches up to where the timetable says things should be.

### 3. Give a weekend a timetable

Open the weekend as usual. On the Race Weekend page, the **Autopilot** card (Race Control only) asks for:
- when practice starts, and how far apart the sessions are (with quick practice there's nothing to schedule)
- when qualifying runs
- when the race starts, and how fast it runs: for GP, a lap every so many minutes; for endurance, real time or faster (24 hours in 4, 2 or 1)

**Save and post the timetable** switches the autopilot on for that weekend and posts the timetable to the announcements channel, with times shown in each reader's own time zone. Players see the timetable on the Race Weekend page and set their plans before each session.

### Instead of GitHub: any computer left on

On a computer that stays on during the race weekend (with [Node.js](https://nodejs.org) 20 or later):

```
cd runner
npm install
npx playwright install chromium
```

Then, each time (Windows PowerShell: use `$env:F1SIM_RUNNER_USER="autopilot"` and so on):

```
F1SIM_RUNNER_USER=autopilot F1SIM_RUNNER_PASSWORD='the password' node autopilot.mjs --loop
```

It checks every minute until you stop it with Ctrl+C. While a Race Control tab is open on the site, that tab helps too: it runs the autopilot every minute.

