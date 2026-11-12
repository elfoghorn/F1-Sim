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

1. **Accounts and backups → Invite code**: set a code of at least 6 characters. New accounts then need it.
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
- With the invite code on, new accounts need it. It's stored only as a one-way hash.

## Privacy

Accounts are a username and a password (stored as a hash by Supabase). Each username becomes an internal sign-in name on your own Supabase domain; nothing is ever sent to it. No real name, email or contact detail is asked for. Characters are fiction; real drivers and team principals appear in race results only.
