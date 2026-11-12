# F1 SIM changelog

Every release of F1 SIM, newest first. The version the site is running shows at the bottom of the menu.

## How the version numbers work

Versions are written **MAJOR.MINOR.PATCH**, for example `0.9.1`.

| Part | Goes up when | Example |
| --- | --- | --- |
| PATCH (the last number) | Fixes and small changes that add nothing new to play | 0.9.0 to 0.9.1 |
| MINOR (the middle number) | New features | 0.9.1 to 0.10.0 |
| MAJOR (the first number) | The league is ready for players (1.0.0), or a change that means starting the league again | 0.x to 1.0.0 |

Each release says whether it needs a **database update**. When it does, the **Set up database** action runs it after you push; it adds to the database and never removes your league's records.

## Pushing a release

1. Copy the release's files over the repository.
2. Commit with the version first in the summary, for example: `v0.9.1: combined changelog, version shown in the app`.
3. Push. If the release needs a database update, check that **Set up database** finished.
4. Hard-refresh the site and check the version at the bottom of the menu.

Optionally, tag the commit with the version too (`v0.9.1`), so GitHub lists every release under **Releases and tags**.

---

## v0.40.2: driver titles only in the drivers' career standings

12 November 2026. Build `f1sim-0.40.2`. **No database update.**

| Area | What it does |
| --- | --- |
| Career standings | On Championship → Career: every championship → Drivers, titles now count only seasons as a driver. Titles from team roles (a consultant's or team principal's team title) were being listed there too; they stay under Team principals, Race engineers or Other roles, labelled with the role. |

---

## v0.40.1: seats open by default, and the grid set out by role

12 November 2026. Build `f1sim-0.40.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Open by default | Every seat is open to applications when it's made: when today's grid is loaded and when a new series is set up. Reloading the grid keeps existing seats as they are. A seat a player leaves (handed back, or after a transfer) opens again. A seat a player takes closes, as before. |
| Open or close every seat | On The Grid, Race Control has Open every seat and Close every seat for the series on screen (seats players hold aren't affected). Use Open every seat once on a league made before this version, whose seats were created closed. |
| Set out by role | The whole grid groups its columns under Drivers (red), Team principal (gold) and Race engineers (blue): a header band over each group, a strong divider between groups, a shaded principal column, and a role label on every seat (Driver 1, Team principal, Engineer 2). The Discord grid image is grouped the same way. |
| Wording | Engineer posts with no one in them read "Open post" (or "Vacant post" when closed); open seats read "Open", or "Open · 2 applied" once there are applications. The race engineers tile counts open and vacant posts separately. |

---

## v0.40.0: the top navigation bar

12 November 2026. Build `f1sim-0.40.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Category menus | The top bar is now a navigation bar with four menus: Formula, Endurance, Rally and Touring. The Formula menu shows the series currently on (e.g. "Formula · Formula 1"); its first section, Racing in F1 SIM, switches the whole site to Formula 1, Formula 2, Formula 3 or any series you've set up (Race Control also gets Set up a series). Below it, and in the other menus, are the championships not raced in F1 SIM (GP2, IndyCar, Super Formula; WEC, Le Mans, IMSA; WRC, WRC2, World Rallycross, Dakar; DTM, BTCC, Supercars and the rest), each with how many characters have it on their record. |
| Not raced yet | Choosing one of those opens its championship page (leaderboard and champions from career records) with a note that it isn't raced in F1 SIM yet. Its menu is highlighted while you're there. |
| Series strip | Pages that depend on the series (The Grid, Teams, Team HQ, Race Weekend, Calendar, Championship outside the hub, Seasons, Test Track) have a strip under the title to switch between the Formula series. Teams' own series tabs are replaced by it. |
| Menus | One menu opens at a time; Escape or a click elsewhere closes them. On phones the menus sit on their own row and open full width. The old series dropdown is gone. |
| World Rallycross | Added to the rally championships for career records (from 2014). |
| Home | Players' seat applications show again above the weekend card ("Application for driver, car 2 at Ferrari: waiting for Race Control"), with decisions shown for a week. |

---

## v0.39.1: each series' grid goes to its own channel

12 November 2026. Build `f1sim-0.39.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Grid channels | Each series' grid now goes to its own grid channel (`DISCORD_WEBHOOK_F2_GRID`), else that series' teams channel (`DISCORD_WEBHOOK_F1_TEAMS`, `_F2_TEAMS`, `_F3_TEAMS`), else `DISCORD_WEBHOOK_GRID`, else `DISCORD_WEBHOOK_TEAMS`, else the default. Before, without a grid webhook it went to the default channel. The Grid page says which channel it will go to. |
| Either spelling | `DISCORD_WEBHOOK_F1_TEAM` and `DISCORD_WEBHOOK_F1_TEAMS` (and the same for every series, and the general `DISCORD_WEBHOOK_TEAM`/`TEAMS`) both work, for grids and team cards. |

---

## v0.39.0: the new Grid page

12 November 2026. Build `f1sim-0.39.0`. **No database update** (the Discord relay is updated: it can now edit a message it posted).

| Area | What it does |
| --- | --- |
| Find a seat | Players without a seat start here: "Find a seat for …", for their character's role. Open now: big cards for seats taking applications (team, seat, who's in it now, the team's position, points and engine, the line-up) with Apply for this seat, or Applied and Withdraw. Could open: the other seats for that role, each with Interested, so Race Control can see who'd take it. Held by players. Open seats in other series are mentioned. Players waiting for approval are told they can apply once approved. |
| Whole grid | Every team as a row and every seat as a chip (two drivers, team principal, race engineers; F3's three cars too): Player, Open seat (taking applications, with the number of applications), Real person, or Vacant post, with pictures. Filter by role, or show open seats only. Tiles count player-held seats, open seats and applications waiting. Players can apply straight from an open seat's chip; clicking anyone opens their page. Team names open the team page. |
| Race Control | The whole grid is Race Control's view. Clicking any seat opens a panel: who sits there (the same controls as before: put a character in, hand it back, open it for applications, ratings), the applications with Give them the seat or Turn down, and who's interested. The Car button stays on each team. |
| The grid on Discord | "Post the grid to Discord" posts an image of the whole grid (to `DISCORD_WEBHOOK_GRID`, else the default channel). Posting again edits the same message instead of adding a new one; if it was deleted, a new one is posted. With "Keep the Discord grid up to date" on, it updates itself a few seconds after any seat change. |
| Open for players | On Teams, "(open for players)" now appears only on seats Race Control has opened for applications. |

---

## v0.38.0: the championship hub

12 November 2026. Build `f1sim-0.38.0`. **No database update.**

| Area | What it does |
| --- | --- |
| What's up for grabs | The new front of the Championship page. A card for every championship: the league's series (Formula 1, Formula 2, Formula 3) and every championship in canon career records (WRC and so on). Each lists its prizes (drivers' title, constructors' title, Grand Prix win, pole position, podium, points finish, fastest lap) with who's leading now, who won it last, and your character's chance. "Show": For your character (their championships first), Every championship, or Records (most titles and wins in each). |
| Your chance | Worked out from the standings and the races left: Won, In contention (leading, or within one win of the lead), In reach, Long shot, Out of reach (not possible with the points left), or Not for your role / Not racing here, each with a reason ("P5, 28 behind", "Best finish so far: P4", "McLaren are P1: your results count"). Team principals see their team's chances; race engineers their car's. A line under each card says how many points are still to be won. |
| Career records | A league championship's card also shows titles in the same series from career records ("Title before F1 SIM"). Career-record championships count driver seasons; team-role seasons stay in the role standings. |
| Leaderboards | Each card opens that championship's page. League series: This season (drivers, constructors), All-time (drivers, constructors, team principals, race engineers) and Champions (every catalogued season, plus titles before F1 SIM from career records). Career-record championships: a leaderboard by titles, wins and podiums, and the champions by year. |
| The other views | This season, All-time in F1 SIM and Career: every championship stay as tabs. |

---

## v0.37.1: pictures for real people, and "open for players" on Teams

12 November 2026. Build `f1sim-0.37.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Pictures for real people | Race Control can add a picture for any real driver or team principal: on a team's page ("Pictures for real people", listing the real people in its seats, with how many have one), or on the person's own page (Add, Change or Remove the picture). |
| Where faces show | Every face on the Teams pages (index cards, line-up, everyone who has driven for the team), the exported team card, timing exports and the character page now uses the player's portrait or the real person's picture, with initials only when there's neither. |
| Open for players | A real person in a seat a player can take is marked "(open for players)": on the Teams index cards (drivers and team principal), the team's line-up, and the exported team card ("Car 2 · open for players", "Andrea Stella (open for players)"). Players in seats are tagged Player as before. |

---

## v0.37.0: invite codes enforced and generated by the system

12 November 2026. Build `f1sim-0.37.0`. **Database update: migration 8 (`20261111000008_invite_codes.sql`).** Let "Set up database" finish after pushing.

| Area | What it does |
| --- | --- |
| Always required | Every new account needs a valid invite code, apart from the very first (the Administrator's). With no code issued, new accounts are closed. Signing in to an existing account never needs a code. |
| Generated by the system | Accounts and backups → Invite code → Generate a code: the database makes a 10-character code from letters and digits that can't be mixed up (no O, 0, I or 1), using a secure random source. Only a one-way hash is stored, so the code is shown once, large, with a Copy button. Generating a new code makes the old one stop working. Close sign-ups removes it. The card shows whether a code is active and when it was made. Typing a code in by hand is no longer possible. |
| Sign-up screen | The invite box says "10 characters, from Race Control". Codes are accepted in upper or lower case, with or without spaces. An empty box is caught before anything is sent; a wrong code says so; with no code issued, the screen says new accounts are closed and to ask Race Control. |

---

## v0.36.1: date and time on exports

12 November 2026. Build `f1sim-0.36.1`. **No database update.**

| Area | What it does |
| --- | --- |
| On the images | Every export shows when it was made, in UK time (GMT, or BST in summer), e.g. "12 Nov 2026, 12:56 GMT": timing sheets (portrait and widescreen), the calendar and standings, team cards, character sheets and acceptance cards, and transfer cards. |
| In Discord | Every post from F1 SIM ends with a small "As of" line using Discord's own timestamp, so each reader sees the time in their own time zone. |
| Files | The race report (.txt, and .json as "exported") and the Google Doc character sheet say when they were exported, with the time. |

---

## v0.36.0: team cards to Discord by series and by team; principals and engineers on Teams

12 November 2026. Build `f1sim-0.36.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Team card channels | A team card posted to Discord goes to the team's own channel if there is one (`DISCORD_WEBHOOK_TEAM_<TEAM>`, e.g. `DISCORD_WEBHOOK_TEAM_MCLAREN` or `DISCORD_WEBHOOK_TEAM_F2_PREMA`), else its series' teams channel (`DISCORD_WEBHOOK_F2_TEAMS`, `DISCORD_WEBHOOK_F3_TEAMS`…), else `DISCORD_WEBHOOK_TEAMS`, else the standings channel, else the default. The card panel says where it will go and the exact webhook name for that team. Works for every series. |
| Post every team | On Teams, Race Control has "Post every … team to Discord": every team card of the series shown, each to its right channel, with progress. |
| Principals and engineers | Each team card on Teams lists the team principal and each race engineer post (players tagged, open posts shown), for earlier seasons too (from who ran the team at that season's last race). The exported card shows the principal and "Car 1: … · Car 2: …" with players marked. A team's Previous championships tab lists the team principals and race engineers it has had, with seasons, races and wins. |
| Setup | The new webhook names are in SETUP.md. |

---

## v0.35.0: race involvement levels for players

12 November 2026. Build `f1sim-0.35.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Three levels | Each player character chooses how involved they are in the race sim. **Hands-off**: the car runs on defaults (a standard set-up and practice, the default race strategy), and driver moments settle themselves straight away. **Set-up only**: they plan practice and choose the set-up; the race strategy, live calls and driver moments are automatic. **Full**: everything, as before (the default for everyone). |
| Switch any time | The switch is at the top of the Race Weekend page and on the Home weekend card. It can be changed race to race or mid-weekend; the level in force at each stage is the one used. |
| What changes | Hands-off players see the simple weekend page (timing and entry list) instead of the pit wall; practice runs they planned are set aside and their calls are refused with an explanation. On set-up only, the Race plan view is hidden, saved race plans and strategy calls aren't used, and no driver moments are created for their car (so the live race doesn't wait for them). Switching back to Full brings their saved plans back into use. |
| Race Control | Home's weekend card lists hands-off cars separately ("Hands-off (defaults): …") instead of waiting on them to plan. |

---

## v0.34.0: careers and standings for team principals, engineers and other roles; JSON updates

12 November 2026. Build `f1sim-0.34.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Roles in career seasons | Each career season has a role: driver, team principal, sporting director, race engineer, strategist, consultant or another team role. In a team role, wins, podiums, poles and the championship are the team's results that season (a race engineer's are their car's). The role shows under the team in the career record. |
| Who ran each race | Every finished race now records each team's principal and each car's race engineer (players, or the computer-run real principal), so credit stays with whoever held the post at the time. |
| Standings by role | The Championship's all-time and career views have Drivers, Team principals, Race engineers and Other roles. Team principals are ranked on their team's results while in charge and get the constructors' title; race engineers on their car's results and get the drivers' title; other roles come from canon career seasons. |
| Character pages | "Wins and podiums by championship" splits by role: as a driver, then as team principal, sporting director, consultant and so on, with team results labelled as team titles, wins and podiums. |
| JSON updates existing characters | An uploaded character updates an existing one when its id matches or, without an id, when its name matches one you can edit. The preview says "Update … (matched by name)", with "Create a new character" as the alternative. Only the fields in the file change. Career seasons merge: a season with the same years, series and role is updated (players' changed seasons go back to Race Control; unchanged ones keep their status), new ones are added, and seasons not in the file stay. Race Control's "Approved, with the ratings in the file" also updates approved drivers' ratings. |

---

## v0.33.0: teams on approval, and transfer posts

12 November 2026. Build `f1sim-0.33.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Team on approval | The decision card for a driver, team principal or race engineer has "Team and seat on approval", filled in from their team preference: their first-choice team's open seat, then their second choice, or the first open seat anywhere if they're happy to go to any team. Seats held by other players are shown but can't be picked; "Don't seat them yet" leaves them unseated. Approving seats them first, then posts the acceptance card, so the card and the message name the team ("approved as driver for McLaren"). |
| Transfers | When Race Control moves an approved character from one team to another (on The Grid, or by accepting a seat application), a Transfer card is posted to Discord: their portrait, FROM the old team TO the new one in the teams' colours, and the new seat, with the message "Transfer: … moves from McLaren to Red Bull as driver, car #28", @mentioning the player. Moving between seats in the same team doesn't post. A switch on The Grid turns transfer posts off. |
| Discord | New channel `DISCORD_WEBHOOK_TRANSFERS` for transfer cards; without it they go to the default channel. Added to SETUP.md. |

---

## v0.32.0: managing and deleting characters

12 November 2026. Build `f1sim-0.32.0`. **No database update.**

| Area | What it does |
| --- | --- |
| All characters | A list at the bottom of the Race Control page with every character: player, role, status, seat and race results. Search by character or player name, filter by status (drafts, waiting, returned, approved, retired), and Open, Retire, Restore or Delete each one. |
| Deleting | Delete opens a panel that says exactly what goes: the character, their application and sheet, their seat (which becomes open), seat applications, connections, diary entries, contracts, team branding uploads, planned runs and votes. Type the character's name to confirm. Any race results stay in the history under their name, so standings and past seasons don't change. Deleting is blocked while the character is in the open weekend. "Retire instead" is offered alongside. |
| On the application | Race Control sees "Delete this character" at the bottom of every application. |
| Restore | Retired characters can be restored from the list. |

---

## v0.31.0: a new Home, and connections on the character sheet

12 November 2026. Build `f1sim-0.31.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Connections on the sheet | Connections are now the last section of every character page, grouped by kind (family, friends, rivals, work, romance), with who counts the character as a connection and their on-track rivals. The owner adds a connection right there ("Add a connection" in the page's buttons jumps to it). The old Relationships card is gone; the Connections page and its map stay. |
| Home for players | The current race weekend at the top: round, circuit and stage, the stage strip, their car's key numbers and what to do now, with a button to their pit wall (or the next round, with its date and the last podium, when no weekend is open). Below it, their character sheet in full. Application status, contract offers and "no seat yet" show as notes above. Players waiting for approval see the same, with the note about the rest of the site. |
| Home for Race Control and moderators | A dashboard: the season's progress, the open weekend's stage with who still has to plan their runs and the next step as one button (Run FP1, Run qualifying, Run the next session…), or the next round to open; what's waiting (character applications, career seasons, seat applications); recent activity; the grid's player seats; the championship's top five; and Discord. Race Control members playing a character can switch to the player view. |

---

## v0.30.0: historical series and year checks in career records

12 November 2026. Build `f1sim-0.30.0`. **No database update.**

| Area | What it does |
| --- | --- |
| More series | Career records now offer the series older careers ran in: GP2 Series, GP3 Series, FIA F3 European Championship, Formula Nippon and Indy Lights (single-seaters), and WRC3, Junior WRC, Production Car WRC, Super 2000 WRC and the European Rally Championship (rally). |
| Year checks | Each series knows the years it ran under that name. A season dated outside them is flagged, with what it was called then (for example "WRC2 began in 2013; before that, use Production Car WRC or Super 2000 WRC"): when saving the season, in the career record on the application, in Race Control's decision checklist, and in JSON uploads. Flagged seasons can still be saved; Race Control decides. |
| Major achievements | Titles and wins in GP2, Formula Nippon, WRC2, the Production Car WRC and the Super 2000 WRC also count as major achievements needing approval. |
| Non-drivers' racing past | Team principals, engineers and others with canon seasons in other championships (a former rally champion, say) show "Wins and podiums by championship" on their page and appear in the career standings. |

---

## v0.29.1: Personality on the character sheet

12 November 2026. Build `f1sim-0.29.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Personality | A new Personality field in the main part of the character form, just before the backstory (both when creating a character and inline on the application). "About them" is now labelled Backstory. |
| Where it shows | Under "Who they are" on the application (Personality, then Backstory), as a Personality card before the Backstory card on the character page, in Race Control's decision checklist, and as its own section before the backstory in the Google Doc. JSON downloads and uploads include it. |

---

## v0.29.0: JSON download and upload for characters and seasons

12 November 2026. Build `f1sim-0.29.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Characters out | Download a character as JSON (Export panel), all your characters (Your characters), or every character (Race Control). The file has the details, story, flavour, career seasons, team preference, picture link and ratings, plus each character's id. |
| Characters in | Upload a JSON file on Your characters. Each character is checked and listed before importing. Players' uploads arrive as drafts: ratings in the file are ignored (they roll on the site) and career seasons await Race Control. Keeping a character's id updates that character instead of creating a new one. Race Control can upload from the Race Control page as drafts, or approved with the ratings in the file. |
| Character template | "Download a template": an example with every field and notes on the allowed values. |
| Seasons out | On the Seasons page, download any season as JSON: series, name, engine era, and every round with its results (position, driver, team, points, grid, stops). |
| Seasons in (Race Control) | Upload a past season: results are matched to drivers and teams by name, points are filled in from the series' points tables when missing, and new names are added to the record as drivers. Problems (an unknown track or team) are listed and stop the import. The season becomes a catalogued season: on the Seasons page, in Teams' previous championships, and in the all-time and career standings. Uploading a season with the same name again replaces it. A file for the current season only sets its engine era and round dates. |
| Season template | "Download a template": an example season with notes on tracks, engines, sessions and teams. |

---

## v0.28.0: Teams, and all-time and career standings

12 November 2026. Build `f1sim-0.28.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Teams | A new menu item, open to everyone (players waiting for approval too). Every team of a series as a card in its colours: engine, championship position and points, its drivers (players tagged) with their standings, and who runs it. Tabs switch between series; a season picker goes back to previous championships ("2026: champions McLaren"), showing that season's final standings. |
| A team's page | A banner in the team's colours (with its logo and car photo when set), and two tabs. This season: championship position, points, wins, podiums, poles and fastest laps; the line-up (drivers, team principal, race engineers; open posts shown as "Apply on the site"); points by round; race by race for both cars. Previous championships: honours (constructors' and drivers' titles, Grand Prix wins, podiums), season by season (engines, position, points, wins, podiums, drivers and their championship finishes) and everyone who has driven for the team. |
| Team card | "Export the team card": an image of the team this season (position, points, wins, podiums, both drivers with portraits, principal and engineers, honours, points by round) to download, or for Race Control to post to Discord. |
| Championship: all-time | A new view: every F1 SIM season of the series added up, for drivers (seasons, starts, wins, podiums, poles, points, titles) and constructors (seasons, wins, podiums, points, titles). Titles count once a season is catalogued. |
| Championship: career | A new view across every championship: F1 SIM races in every series plus each driver's canon seasons in other championships (Formula 2, F1 Academy, WEC and so on), ranked by titles, wins and podiums, with the titles listed. |

---

## v0.27.0: flavour on the character sheet, and Connections

12 November 2026. Build `f1sim-0.27.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Flavour sections | Nine optional sections on every character sheet: goals and motivation, fears and insecurities, appearance, habits, hobbies, likes, dislikes, skills and family. They sit in an "Add flavour (optional)" fold-out in the character form (inline on the application page, and when creating a character), so players can fill them in now or come back any time. |
| Where flavour shows | A "More about them" card on the character page, a "Flavour" card on the application, a line in Race Control's decision checklist ("Flavour: 7 of 9 optional sections"), and a "More about them" section in the Google Doc. |
| Connections page | A new menu item. A character's connections, each with who, what they are and the story; adding and removing them; and who counts the character as a connection. Kinds come in five groups: family (sibling, parent, child, cousin), friends (friend, best friend), rivals (rival, nemesis, unfinished business), work (mentor, protégé, team-mate, former team-mate, manager, colleague) and romance (partner, ex). |
| Across the paddock | A map of every connection in the league: people as dots in their team colours (player characters outlined), connections as lines in their group's colour, several connections between the same two people bowed apart. Filter by group, click anyone to open their page, or read them all as a list. |
| Relationships | The character page's Relationships card uses the same, wider set of kinds. |

---

## v0.26.1: approvals as a list

12 November 2026. Build `f1sim-0.26.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Applications list | On the Race Control page, waiting applications are compact rows: picture, name, role, nationality, when it was sent, the team preference, and tags for seasons to check, major achievements, no picture or no face claim. Click a row to open the application. Approved characters with new or changed career seasons are listed the same way. |
| Decision on the application | A waiting application opens with "Race Control: decision" at the top: a checklist (picture, face claim, story, team preference, background and rolls, career seasons still to mark), the note to the player, the acceptance-post tick box, Approve, Return with the note, and for drivers Give an extra re-roll and Reset the ratings. After approving or returning, Race Control goes back to the list. |
| Career seasons | In the application's career record, Race Control marks each season Canon or Not canon; approving makes the rest canon. |

---

## v0.26.0: edit on the application page, and fixing the rolls

12 November 2026. Build `f1sim-0.26.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Inline editing | "Edit details" on the application page opens the form right there, in place of "Who they are", instead of a side panel: picture and face claim, name, role, nationality, code and number, Discord username, nickname, where they're from, story, before Formula 1 and helmet. Save changes or Cancel. Changing the role shows or hides the driver fields straight away. (Creating a new character still uses the side panel.) |
| Change background or years | After rolling, a player can change their background or years once. The ratings are cleared and they roll again (a fresh allowance). Every earlier roll is kept under "Earlier attempts", for the player and Race Control. A second change needs Race Control. |
| Extra re-roll | Race Control can give a driver an extra re-roll, from the application review or the application page, with an optional note. If the application had been sent, it comes back to the player with the note. |
| Reset the ratings | Race Control can reset a driver's ratings: the rolls are cleared, background and years unlocked, and the next rolls are new numbers. A sent or approved application reopens with a note; an approved driver keeps their seat, menu and current ratings until Race Control approves them again, when the new ratings replace the old. |
| Fairness | Rolls that were never reset are unchanged. Race Control sees every roll, including earlier attempts. |

---

## v0.25.0: team preference, wins and podiums, and the new-player menu

12 November 2026. Build `f1sim-0.25.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Team preference | Drivers, race engineers and team principals get a "Team" step in their application: pick a first-choice team from cards showing every team in its colours with its engine and how many seats (or posts) players already hold, a second choice, why (optional), or "Happy to go to any team". A series picker shows Formula 2, Formula 3 and other series' teams. It can be changed until approval, then shows read-only. Media and paddock characters don't get the step. |
| Race Control's review | Each application shows the preference ("Wants: McLaren (first choice), Williams (second)", with the reason), or "No team preference given". Race Control still seats the character. |
| Wins and podiums by championship | A new section on every driver's character page, for everyone to see: titles, wins, podiums and championships in total, and a row per championship (seasons, titles, wins, podiums, a wins and podiums bar, best finish). F1 SIM races count automatically; other championships come from canon career seasons. |
| What new players see | Until a player has an approved character, the menu shows only Home, The Grid, Calendar, Championship, Seasons and Your characters (character pages still open from The Grid and the Championship). Other pages send them Home with a note, and Home says the rest opens once Race Control approves their character. |

---

## v0.24.1: F1 Academy, simpler career record, Discord username only

12 November 2026. Build `f1sim-0.24.1`. **No database update.** Optional: a Discord bot to turn usernames into pings (SETUP.md, Discord).

| Area | What it does |
| --- | --- |
| Career record | F1 Academy added to the single-seater series. Starts and Class or category removed from the form, the tables, the totals and the exports. The check is now "more wins than podiums". |
| Discord username only | The Discord user ID field is gone. The character form asks for the Discord username (for @mentions); a leading @ and spaces are removed. |
| Acceptance pings | The acceptance post names the player's Discord username. With a Discord bot set up (`DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` in Cloudflare), the relay looks the username up on the server and makes it a real ping, matching the exact username first, then the display name or server nickname. Without the bot, or if the player isn't found, the @username is written as plain text. Race Control's message says which happened. |

---

## v0.24.0: picture and face claim on the application

12 November 2026. Build `f1sim-0.24.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Character form | A "Picture and face claim" section at the top of the first step (new character, and Edit details): upload a picture (JPEG, PNG or WebP, resized to fit) with a preview, change or remove it, and a Face claim field for who the picture shows. Both are saved with the character. |
| Application | A new "Picture and face claim" step in the application's progress strip. The picture and face claim show under "Who they are". Sending an application without them asks first, so it can still be sent. |
| Race Control's review | Each application shows the picture and the face claim, or "No face claim given" and "No picture" warnings. |
| Character page and exports | The face claim appears in the character's particulars and in the Google Docs character sheet. |

---

## v0.23.1: Current driver background

12 November 2026. Build `f1sim-0.23.1`. **No database update.**

| Area | What it does |
| --- | --- |
| New background | "Current driver": already on the grid and proven over full seasons. Ratings roll from 74 to 88 (average about 81), with +2 consistency and +2 defence; experience 60; 3 to 6 years or 7 years or more in racing. |

---

## v0.23.0: character sheet exports and acceptance posts

12 November 2026. Build `f1sim-0.23.0`. **No database update.** Optional: a new Discord webhook secret, `DISCORD_WEBHOOK_APPROVALS` (SETUP.md, Discord).

| Area | What it does |
| --- | --- |
| Editing | "Edit details" is available at every stage: draft, with Race Control, returned and approved. Details, story, before Formula 1, helmet, nickname, Discord, career record and portrait can all be changed. After approval, name, code and number changes also update the character on the grid and in their seat. The role is fixed once approved, and the rolled ratings stay fixed (they still grow with development points). |
| Discord user ID | A new optional field on the character, with how to find it (Developer Mode, then Copy User ID). Needed for @mentions; a Discord username alone can't ping anyone. |
| Export | "Export" on the application page and "Export the character sheet" on the character page (for the owner and Race Control). |
| Photo cards | Character sheet: portrait, name, role and team, particulars, rating bars for drivers, career totals and the start of their story, in the driver card style. Acceptance card: "Welcome to the grid", a large portrait, an Approved stamp, and the role and seat. |
| Google Doc | "Download for Google Docs (.docx)": a styled document of the whole sheet in Titillium Web with team-colour accents: a dark header with the portrait, particulars, ratings drawn as bars, story, before Formula 1, the career record (F1 SIM seasons and canon seasons), relationships and recent diary entries. Open it in Google Drive with New, File upload, then Open with Google Docs; it opens in Word too. |
| Acceptance post | When Race Control approves a character, the acceptance card is posted to Discord with an @mention of the player (when the character has a Discord user ID). A tick box in the review turns it off for that approval. The card can also be posted again from the export panel. |
| Discord channels | New optional webhook `DISCORD_WEBHOOK_APPROVALS` for acceptance cards; without it they go to the default channel. |

---

## v0.22.0: career records

12 November 2026. Build `f1sim-0.22.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Career record on the application | A new card on every application page. Players add seasons one at a time: year or years, series, class or category, team, starts, wins, podiums, poles, championship finish and notes. Seasons can be edited or removed. |
| Series | Single-seaters (Formula 1 for returning veterans, Formula 2, Formula 3, Formula Regional, Formula 4, Super Formula, Formula E, IndyCar, Indy NXT, karting), endurance (WEC, Le Mans 24 Hours, IMSA, European Le Mans Series, GT World Challenge), rally (WRC, WRC2, Dakar; starts become rallies and poles become stage wins), touring (DTM, BTCC, Supercars) and any other series by name. |
| Admin approval | Every season waits for Race Control. Titles and wins in the top series (Formula 1, Formula 2, IndyCar, Super Formula, Formula E, WEC, Le Mans, IMSA, WRC) are flagged as major achievements. In the application review, Race Control marks seasons canon or not canon; approving the character makes the rest canon. |
| Later changes | A season added or changed after approval goes back to awaiting approval, and appears in a new "Career record changes" list on the Race Control page. |
| On the character page | A Career record section: totals (titles, starts, wins, podiums, poles), the character's F1 SIM seasons worked out from their results (series, team, starts, wins, podiums, poles, points and championship position, marked "so far" for the current season), then their canon seasons grouped as single-seaters, endurance, rally, touring and other. |
| Who sees what | Everyone sees canon seasons. The owner and Race Control also see seasons awaiting approval or not canon, marked as such. |

---

## v0.21.0: race incidents

11 November 2026. Build `f1sim-0.21.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Incident catalogue | Races now draw from 40 kinds of incident in eight groups: driver errors and crashes, contact between cars, pile-ups, tyres, stewards, mechanical, pit lane, and outside events. "What can happen?" (beside the weekend settings, and on the Test Track) lists each one, how often it happens on the usual settings and what it does. |
| Crash levels | Lock-up (1 to 2.5s, sometimes a flat-spotted tyre), off and rejoin (3 to 7s), spin (8 to 16s), through the gravel (15 to 30s), front wing damage (slower until the car pits for a new nose), beached in the gravel (out, virtual safety car), hits the barrier (out, safety car, sometimes a red flag), heavy crash (out, often a red flag). |
| Contact | When one car attacks another: a touch, a puncture, wing damage, one car out or both out. Stewards often penalise whoever caused it. |
| Pile-ups | First-lap and restart tangles of 2 to 5 cars, and rare pile-ups of 5 to 8 cars with a red flag. |
| Mechanical | Ten ways to retire (power unit, gearbox, hydraulics, energy store, fuel pressure, electrical shutdown (a third restart after a power cycle), brakes, suspension, engine fire, overheating) and four to carry on with: loss of power, gearshift problems, brake temperatures, floor damage. More for less reliable cars and worn power units, and by engine era: V8s fail least, V12s most. |
| Tyres and pit lane | Punctures (more at street circuits and on worn tyres), tyre failures past 85% wear, wheel nut problems, stalls, unsafe releases and pit-lane speeding. |
| Outside events | Debris, debris in a brake duct, an animal on the track, a spectator on the track, a loose drain cover (red flag), a sudden cloudburst (only when the weekend's weather isn't set to dry), and lightning (red flag; in the last quarter the race isn't resumed and the results stand). |
| Red flags | The race stops; the gaps close up; every car gets fresh tyres and repairs; the race restarts behind the safety car. The live race pauses at a red flag, as at a safety car. |
| Penalties | 5 or 10 seconds, served at the next pit stop or added to the race time at the finish. |
| On screen | The timing tower shows penalties to serve (+5s) and cars with damage or a problem. The race log marks red flags, penalties, damage and incidents. The race report includes them all. |
| Settings | Three settings scale the groups: "Crashes, contact and driver errors", "Mechanical failures and pit problems" and the new "Outside events". Each now has None, as well as fewer, as usual, more and chaos. |
| How often (measured) | Over 240 dry races on the usual settings: 2.5 retirements, 0.9 safety cars, 0.7 virtual safety cars, a red flag about one race in seven, and 1.2 penalties per race. On chaos with a 60% chance of rain: 7.5 retirements, 2.7 safety cars, 2 virtual safety cars and a red flag in more than half of races. |

---

## v0.20.0: calendar and championship exports

11 November 2026. Build `f1sim-0.20.0`. **No database update.** Optional: two new Discord webhook secrets (SETUP.md, Discord).

| Area | What it does |
| --- | --- |
| Calendar export | "Export calendar" on the Calendar page: an image of every round in two columns, with dates, each finished round's winner (in team colour), the next round or the one on now in red, sprint weekends marked, and testing at the top. |
| Championship exports | "Export standings" on the Championship page. Drivers: the top three as cards with points and the gap to the leader (player portraits included), everyone else below with points. Constructors: each team's points as a bar in team colours, with its engine and wins. Both: a widescreen image with drivers and constructors side by side. |
| Look | Carbon or light, as for timing exports. |
| Sharing | Anyone can download the image. Race Control can post it to Discord, choosing a channel or leaving it on automatic. |
| Discord channels | Two new optional webhooks: `DISCORD_WEBHOOK_CALENDAR` and `DISCORD_WEBHOOK_STANDINGS` (per series too, such as `DISCORD_WEBHOOK_F2_STANDINGS`). Without them, posts go to the default channel. The Race Control page lists them. |

---

## v0.19.0: engine eras and engine makers

11 November 2026. Build `f1sim-0.19.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Engine eras | Each season has an engine era, chosen by Race Control on the Seasons page (or when starting a new season): V6 turbo hybrid (2026 rules), V6 turbo hybrid (2014 to 2025), V8, V10, V12, V6 turbo without hybrid, or fully electric. Formula 1 starts on the 2026 hybrids; Formula 2 and Formula 3 on the V6 turbo. |
| How eras race | Hybrids: the battery recharges by driving mode and pays for the overtaking boost (the 2014 to 2025 cars are quicker, with a cheaper, stronger boost). V8: quicker, a small battery boost, very reliable. V10: about a second quicker over a lap, no battery or boost, power matters more, thirstier, harder on tyres, more failures. V12: the most power, the most fuel, the most failures. Electric: no fuel weight, but the battery drains as cars push; a flat battery costs over a second a lap, so everyone manages it. |
| What changes | Lap times, how much power counts at each circuit, the battery and boost, fuel weight, tyre wear, the failure rate, and the power-unit allowance (4 for the hybrids and electric, 8 for V8s, no limit for V10, V12 and V6 turbo). |
| Engine makers | Every maker (Mercedes, Ferrari, Honda, Red Bull Ford, Audi, and the spec engines in F2 and F3) has ratings for power, reliability, efficiency and driveability. Power adds top speed and pace; reliability cuts failures; efficiency is worth lap time in hybrid and electric eras; driveability is kinder to tyres. |
| A new era | Reshuffles the makers' ratings, so the order can change. The 2026 hybrids start from today's order. Race Control can reshuffle again or set any rating by hand. |
| Moving teams | Race Control can move a team to another maker for the season. Moves and ratings carry into the next season. |
| Labels | The Grid and Team HQ show each team's engine, such as "Mercedes V10" or "Honda electric". |
| No-hybrid eras | The pit wall shows "no battery", and driver moments drop the boost option. |
| Car development | Carrying development into a new season no longer carries the engine's effect with it. |
| Fix | Cataloguing a season kept only its results and lost anything else stored on it; it now keeps everything. |

---

## v0.18.0: the Carbon look

11 November 2026. Build `f1sim-0.18.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Carbon | The whole site has a new look: dark graphite, white type, and F1 red for what matters most. It's the same for everyone, whatever their device's light or dark setting. |
| Type | Titillium Web throughout, with italic headings and a red slanted underline under page titles. |
| Slanted shapes | The active menu item, the current stage, selected tabs and filters, the main buttons and the Race Weekend page's section labels are red and slanted. |
| Details | Square corners, a red line under the top bar, red highlights for the next round on the calendar, the current session and the stat that matters now, and red-tinted rows for your own cars in timing. |
| Exports and cards | Timing exports default to Carbon (red podium steps, a red slant under the stage title, Titillium Web); the light option is still there. Driver cards use Titillium Web. |
| Phones | The browser bar and installed app use the Carbon colour. |

---

## v0.17.0: calendar, pre-season testing and race reports

11 November 2026. Build `f1sim-0.17.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Calendar | A new page in the menu with every round of the season for the series being shown. Each card says whether the round is done (with the podium, pole and Driver of the Day), on now, next or still to come (circuit type, chance of rain, and who won there last season). Filter by all rounds, done or to come. |
| What happened | Clicking a finished round opens that weekend: the classification, awards, Driver of the Day, the race (timing, race log, lap chart, tyres, each driver's race) and, new, the rest of the weekend: every practice session with its conditions and timesheet, and qualifying session by session. Sprints have their own button. |
| Dates | Race Control can give each round a date (Set dates); the cards show it. |
| Pre-season testing | A new kind of weekend Race Control can open at any circuit ("Pre-season testing" in the session list). Three test days, each with 6 runs per car, running like full practice sessions: weather, red flags, crashes, failures, timesheets and debriefs. Race Control runs each day, then finishes testing. |
| What testing counts for | Not the championship, prize money, power units or development points. It does count towards engineer and driver rapport. Crashes in testing still cost repairs. |
| Testing pages | The stage strip shows the three days. A finished test shows the fastest time of the whole test for each driver and each day's timesheet. Timing exports work for each test day. Testing appears first on the calendar. |
| Race report | A "Race report" button beside Export timing, for any weekend with something to report. Three downloads: **.txt** (a readable account, stage by stage and lap by lap), **.json** (the complete data) and **.csv** (one row per car per lap, plus events). |
| What's in the report | Each practice or test session: conditions, incidents, timesheet, and the players' runs with their dials, tyres, lap times, tyre life and the driver's feedback. Qualifying session by session, penalties and the grid. The race lap by lap: each car's position, gap to the leader, lap time, tyre and its age, pit stops and retirements, the weather, and every event (passes, mistakes, stops, safety cars, triggers, driver moments). Then the result. |

---

## v0.16.0: league logo and Discord channels

11 November 2026. Build `f1sim-0.16.0`. **No database update.** Optional: new Discord webhook secrets (SETUP.md, Discord).

| Area | What it does |
| --- | --- |
| League logo | Race Control uploads the league's logo on the Race Control page. Plain background around it is trimmed off automatically, so a wallpaper with the logo in the middle works. It shows in the top bar, on timing exports and on driver cards. |
| Discord channels | Each kind of post has its own optional webhook: `DISCORD_WEBHOOK_RESULTS`, `DISCORD_WEBHOOK_TIMING`, `DISCORD_WEBHOOK_ANNOUNCEMENTS` and `DISCORD_WEBHOOK_CARDS`, with `DISCORD_WEBHOOK` for everything else. A series code makes one for a single series, such as `DISCORD_WEBHOOK_F2_RESULTS`. Each post tries the series channel, then the general one, then the default. |
| Channel check | The Race Control page shows which channels are set up and where each kind of post will go. |
| Choosing a channel | When exporting timing, Race Control can pick any channel, or leave it on automatic. The panel says where it was posted. |
| Fix | Timing exports were sent to a channel called "results" whether or not one existed; without `DISCORD_WEBHOOK_RESULTS` the post failed. They now fall back to the default channel. |
| Setup guide | SETUP.md lists every webhook secret the site uses. |

---

## v0.15.0: timing sheet export

11 November 2026. Build `f1sim-0.15.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Export timing | A button on the Race Weekend page (beside the stage strip, or under the title in the three-column layout) once there's timing to share. |
| Every stage | Each practice session once it has run, Q1, Q2 and Q3 as they finish (or qualifying in one-session series), the race at the current lap, and the result. Drivers knocked out show "Out in Q1" or "Out in Q2"; retirements show "Out". |
| 1. Podium | Portrait, 1080 by 1350. P1 to P3 on podium steps (P1 in the middle and tallest) with portraits, car numbers, team colours and times, and the rest of the field in two columns below. |
| 2. Broadcast | Widescreen, 1920 by 1080. P1 to P3 as three big cards with large position numbers in team colour, and a timing tower for everyone else. In the race, tyres and their age, and a live marker. |
| Look | Dark or light. |
| Portraits | Player characters show their uploaded portraits; real drivers show initials and their car number. |
| Sharing | Anyone can download the image. Race Control can post it to Discord (the results channel), with the stage as the message. |

---

## v0.14.0: development points by races, and team development

11 November 2026. Build `f1sim-0.14.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Driver development points | Now earned from races, not results: **1 point for every 4 Grands Prix started** (sprints don't count). |
| Season cap | Each season of a series has a cap of 1 point per 4 rounds on its calendar: 5 in Formula 1's 23 rounds, 3 in Formula 2's 13. A driver racing in two series earns in each. |
| Years of experience | Still scale the points: ×1.5 for 1 to 2 years, ×0.75 for 7 years or more. |
| Unspent points | Carry on to the next season; only the earning is capped. |
| Driver panel | Shows the points to spend, this season's Grands Prix, how many of the season's points are earned, and how many more races to the next. |
| Team development points | Each team earns **2 points for every 4 Grands Prix** of the season. The team principal spends them in Team HQ, a point at a time: overall pace +0.3, top speed +0.5, cornering +0.5, reliability +1.5, kindness to tyres +1.5 or pit crew +1.5. Not during a race weekend. |
| Teams without a player | Put their points into pace by themselves. |
| Season reset | Team points and what they bought reset each season. How much of the car's development carries over is still the "car development carried over" choice when Race Control starts the new season. |
| Spec series | Formula 2, Formula 3 and custom series built on their rules have no team development. |

---

## v0.13.0: Characters

11 November 2026. Build `f1sim-0.13.0`. **No database update.**

| Area | What it does |
| --- | --- |
| Characters page | A new page in the menu showing every approved character in the league, in three views. |
| Cards | Portrait cards in team colours with the car number, role, team and series, and three numbers that suit the role: races, podiums and points for drivers; team points, team position and upgrades for team principals; weekends, set-up awards and rapport for race engineers; posts, interviews and diary entries for media and paddock life. Search, filter by role and series, and sort by team, name, points or newest. |
| By team | The paddock by series and team, with each team's banner and logo. Player characters stand out; real and computer-run people are greyed; open seats have "Apply for this seat", which takes you to that series' Grid. Media, paddock life and characters without a seat are listed underneath. Shows only teams with players or open seats unless you untick it. |
| Register | A directory with filters for role, series and years of experience, and a preview of whoever you select: portrait, story, numbers, latest diary entry and rival, with a button to their page. |
| Character pages | Every name on the site now opens a redesigned page: the team banner with the portrait, role, team and series, details, and the big numbers (for drivers, races, podiums, points and championship position). Then three columns: particulars (helmet, career before F1, contract, race engineer, other series they race in) and relationships; story, diary and timeline; ratings, trophy cabinet and race by race. Owners get buttons to change their portrait, write in the diary, add a relationship and edit details. Real drivers and media characters have pages too. |

---

## v0.12.0: pit-wall Race Weekend layout, team branding

11 November 2026. Build `f1sim-0.12.0`. **Database update:** `20261111000007_branding.sql`.

| Area | What it does |
| --- | --- |
| Race Weekend layout | For players, the page is now three columns with nothing hidden behind tabs, in the site's own colours and type. Left: the car (with its team logo), the weekend's sessions and how each went, what to work on, and what the car will use if you do nothing. Middle: the work. Right: the latest debrief and a short timesheet; after qualifying, the qualifying debrief and the grid; in the race, your car and the race log. |
| Big numbers | Along the top, changing with the stage: in practice the next session, chance of rain, runs to plan and confidence; before the race the stage, grid slot, confidence and laps; in the race the lap, position, tyre and plan. |
| Work on | Practice: set-up, race plan, full timing, entry list. Qualifying: qualifying, race plan, entry list. Race: timing (the tower, then the driver, lap chart or tyre strategy beneath it), race plan, entry list. |
| Two cars | A team principal picks the car at the top of the left column. |
| Without a seat | People without a seat this weekend keep the simpler tabbed page. |
| Team branding | Each team can have a logo, a banner photo and a car photo. The team principal uploads them in Team HQ (they count while they hold the seat), or Race Control does for any team. Team HQ shows them in a banner across the top; The Grid shows the logo and car photo; the Race Weekend page and drivers' profiles show the logo. |
| Database | Team principals' uploaded pictures belong to the account that uploaded them. |

---

## v0.11.1: drivers can follow practice

11 November 2026. Build `f1sim-0.11.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Drivers in practice | A driver whose car has a player race engineer used to see "nothing to do" in practice. They now see who runs their car's practice, the set-up guide, the planned runs, the results and the debriefs, without the controls. |
| Fix: race log | Driver-moment lines in the race log had a red box around them, borrowed from the driver-moment card. |

---

## v0.11.0: a streamlined Race Weekend, and nothing to lock in

11 November 2026. Build `f1sim-0.11.0`. **No database update.**

| Area | What it does |
| --- | --- |
| What's happening now | The Race Weekend page opens with one card: the current stage and what to do (for example "FP2 is next: plan up to 2 runs per car"), then a line for each of your cars with runs left, confidence, the set-up it will use for qualifying and the race plans it will use. During the race it shows position, grid slot and the plan running. |
| Tabs | Practice: **Set-up**, **Race plan**, **Timing**, **Entry list**. After qualifying: **Qualifying debrief**, **Race plan**, **Timing**, **Entry list**. During an official race, **Timing** first (nobody can make calls); in races that allow calls, **Pit wall** first. People without a seat see Timing and the Entry list. Race Control's controls stay at the top. |
| One car at a time | A team principal switches between their two cars with buttons, instead of seeing both stacked. |
| Tidier practice panel | The set-up guide folds into one line showing the engineer's guess, with a button to put it on the dials. Only the current session's runs and the latest debrief show; earlier ones are tucked underneath. |
| Nothing to lock in | A car's qualifying set-up is, in order: dials chosen for qualifying (optional), the latest set-up run this weekend, the set-up it used at its last race (scored against what this circuit and driver need), or a standard set-up. The panel always says which one applies. |
| Plans carry over | If nobody saves race plans this weekend, the car uses its plans from its last race, with stop laps and trigger laps resized to this race's length, then the team's own preset. The Race plan tab starts from whichever applies. |
| Qualifying debrief | Says where the set-up came from. |
| Triggers | The Triggers section folds away to one line ("3 triggers set") and stays open while you edit it. |

---

## v0.10.1: seat applications across series

11 November 2026. Build `f1sim-0.10.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Fix: approving across series | Approving a seat application, or putting a character in a seat, now hands back only their other seat **in that seat's series**. Before, it used the series Race Control happened to be viewing, so approving an F2 application while viewing F1 could take away the character's F1 seat. |
| Series on applications | Race Control's seat applications show which series each one is for, and players' Home lists show the series beside each application. |

---

## v0.10.0: full practice sessions

11 November 2026. Build `f1sim-0.10.0`. **No database update.**

Practice can now run like qualifying, as part of the full race weekend, with its own weather and chaos. The Test Track keeps its fixed conditions for experimenting.

| Area | What it does |
| --- | --- |
| Choosing per weekend | When opening a weekend, Race Control picks **Full sessions** (the default) or **Quick** (runs report straight away and it's always dry, as before). |
| Planning runs | In full sessions, teams plan each session's runs (set-up runs, long runs, qualifying simulations) and can take them off the plan until the session runs. Nobody sees a result until then. |
| Running a session | Race Control runs FP1, FP2 and FP3 (or the one practice session) in turn, like Q1, Q2 and Q3. |
| Session weather | Each session's weather is drawn from the weekend's weather and Race Control's chance of rain: dry, damp or wet, and rain can arrive or clear halfway through. The practice panel shows the chance of rain. |
| Wet running | Set-up feedback is much harder to read on a damp or wet track, and a set-up found in the wet only half counts towards confidence. Long runs on slicks become intermediate or full-wet runs with no dry tyre data. Lap times are slower, and qualifying simulations give a wider guess. |
| Red flags | Can cut runs short. |
| Crashes | Likelier in the damp and wet, for less experienced drivers and on qualifying simulations. A crash ends that car's session, knocks the driver's confidence and costs £0.4m in repairs. |
| Mechanical failures | From the team's reliability. A failure ends that car's session. |
| How often | On normal settings, about one crash, one failure and one red flag over a practice weekend. Race Control's safety-car and failure settings scale them; on "chaos" with 90% rain, about three of each. |
| Session report | Above each timesheet: the conditions, and every incident. Cars that lost all their running show no time. |
| Debriefs | Now include the conditions, which runs were lost and why, and the crash's cost to confidence. |
| Fix | A technical driver's set-up guide said they "can't stand nothing in particular"; it now says they can't stand a car that's out of balance. |

---

## v0.9.1: combined changelog and version in the app

11 November 2026. Build `f1sim-0.9.1`. **No database update.**

| Area | What it does |
| --- | --- |
| Changelog | The nine separate change logs are combined into this file, with version numbers from v0.1.0. |
| Version file | `VERSION` in the repository holds the current version. |
| Version in the app | The bottom of the menu shows which version the site is running, so you can match it to this file and your commits. |

---

## v0.9.0: Practice sessions, set-up guidance and years of experience

11 November 2026. Build `f1sim0009`. **No database update.**

| Area | What it does |
| --- | --- |
| Driving style and set-up | Each driving style moves the ideal set-up. A charger or qualifier wants more wing and a stiffer car; a smooth driver or strategist a softer car and a more open differential; a defender less wing for straight-line speed. Set-up quality is now measured against what this driver wants, not just the team. |
| Set-up guide | On each car's practice panel: what the circuit rewards, what the driver likes and can't stand, how that differs from a typical driver, and the engineer's best guess at the dials, with a button to put it on the dials. The guess closes in after every session, faster with an experienced driver and with rapport. |
| Practice sessions | A Grand Prix weekend has FP1, FP2 and FP3 with 2 runs each. Sprint weekends, and F2/F3-style series, have one session with 4 runs. Race Control ends each session; qualifying can still be run early. |
| Timesheets | Ending a session posts its timesheet for every car. Early sessions are race-fuel running; the last ends with low-fuel qualifying runs. Earlier sessions stay available underneath. |
| Session debriefs | For each player's car after every session: its position and gap, how close the set-up is to what the driver wants, the single biggest gain to make next, the driver's comfort, what to do in the next session, and confidence before and after. |
| Confidence | Builds with every session the car runs, more when the set-up suits the driver. Worth up to 0.2s a lap in qualifying and the race. Cars nobody plays run at half confidence, so a full practice programme beats them and skipping practice costs you. |
| Qualifying debrief | Before the race: grid position and gap to pole, how much the set-up and confidence cost, where a perfect lap would have put the car, any grid penalty, and advice on the race plans. |
| Years of experience | Applicants choose 1 to 2 years, 3 to 6 years, or 7 years or more, and roll the exact number with their ratings. Years set the experience rating. Backgrounds limit the choice (a karting prodigy has 1 to 6 years; a returning veteran 7 or more). |
| Years and development | 1 to 2 years earns development points ×1.5; 3 to 6 years ×1; 7 or more ×0.75, with +1 mental strength. |
| Years on profiles | Profiles show years of experience, rising by one for each catalogued season the driver raced in. |
| Fix | Waiting calls during practice showed "undefined" instead of the car. |

---

## v0.8.0: Series and seasons

11 November 2026. Build `f1sim0008`. **Database update:** `20261111000006_series.sql`.

#### Series

| What | How it works |
| --- | --- |
| Series switch | When more than one series exists, a switch in the top bar changes the whole site: The Grid, Team HQ, Race Weekend, Championship, Seasons and the Test Track all show that series. |
| Formula 2 | 11 teams (Invicta, Campos, DAMS, Hitech, ART, MP, Prema, Rodin, AIX, Trident, Van Amersfoort), 2 cars each, identical cars, 13-round calendar. One qualifying session. Sprint (40% of F1 distance, 10-8-6-5-4-3-2-1) and feature race (56%, F1 points, a stop required). |
| Formula 3 | 10 teams, 3 cars each, identical cars, 9 rounds. One qualifying session. Sprint (37%, 10 to 1) and feature (45%), no pit stops required. |
| Custom series | Name, short code, colour, rules like F1, F2 or F3, driver standard (elite, feeder, junior), 4 to 14 teams, 2 or 3 cars each. Starts with fictional teams and drivers; rename teams and tune cars from The Grid. |
| Drivers | F2, F3 and custom series start with fictional drivers. Players' characters take their seats exactly as in F1. |
| Spec series | No upgrades or power units in F2, F3 or custom series built on their rules; smaller budgets. Contracts, sponsors and rapport still apply. |
| Calendars | Race Control ticks which circuits each series visits, on the Series page. |
| Characters | One set of ratings everywhere, and one seat in each series. Careers, development points, awards and profiles count every series. |

#### Seasons

| What | How it works |
| --- | --- |
| Seasons page | Everyone sees the current season and every catalogued one: champions, teams' champions, final standings and every result. |
| Catalogue a season | Race Control, after the last round. Saves the final standings and champions; no weekends can be opened until the next season starts. |
| Start a new season | Name it, choose whether players keep their seats, and (in series with development) how much of each car's development carries over: none, half or all. |
| Fresh each season | Budgets, upgrades in progress, power units, sponsors and contracts. |
| Carried on | Driver ratings, development, careers, awards, relationships and diaries. |

---

## v0.7.0: Presets, triggers, official races and the Test Track

11 November 2026. Build `f1sim0007`. **No database update.**

| Area | What it does |
| --- | --- |
| Team presets | Each team has its own preset, built from how it likes to race (McLaren's aggressive two-stop, Williams' lift and coast, and so on). Four general presets too: safe one-stop, attacking two-stop, wet-weather gamble, safety-car opportunist. Loading one fills all three plans and their triggers, using what the team knows about the tyres. |
| Race approach | Balanced, attacker, defender or tyre saver. It picks the driving mode lap by lap (push when there's a car to catch or someone close behind, manage in clean air) and decides driver moments in official races. Each driver's natural approach comes from their driving style. |
| Defaults | A car in a team with players but no saved plans uses the team's own preset and the driver's natural approach. Teams without players keep the AI strategist. |
| Triggers | Up to six per car: when a safety car comes out (optionally between two laps), rain starts, the track dries, places are lost or gained from the grid, or tyre wear reaches a level, then switch to Plan A, B or C, push, manage, or box. Each fires once, with a chance of the team acting on it (always, 75%, half the time, 25%). The race log says when a trigger fires, or when the team sticks with the plan. |
| Official races | On by default when opening a weekend. Once the race starts, nobody can change anything from the pit wall: the plans, triggers and race approach run the cars, and driver moments follow the approach. Race Control can untick it for a weekend to allow live calls. |
| Randomness | When opening a weekend, Race Control sets the chance of rain (the circuit's usual, none, 20, 40, 60 or 90%), how often safety cars and crashes happen, and how often cars break down (fewer, as usual, more, chaos). The forecast in every team's strategy card reflects it. |
| Test Track | The same simulator, with the league's grid, cars, upgrades and ratings, run in each person's own browser. Pick any car, circuit, weather and randomness; load presets, build plans and triggers, set the approach and set-up; then run qualifying and the race live or lap by lap with full control: modes, stops, plan switches and driver moments. Nothing is saved or counted. |

---

## v0.6.0: Driver moments, notifications, profiles, awards and team depth

11 November 2026. Build `f1sim0006`. **Database update:** `20261111000005_paddock.sql`.

#### Driver moments

| What | How it works |
| --- | --- |
| When | A player's driver within 0.9s of the car ahead (attack), with a car within 0.9s behind (defend), or at a safety-car restart. At most one moment per car every five laps. |
| Choices | Attack: around the outside, down the inside, use the boost, bide your time. Defend: cover the inside, hold your line, let them by. Restart: go for the jump, play it safe. |
| Odds | Shown on each choice, from the drivers' overtaking and defence, the circuit and the battery. The race uses the same numbers. Contact can cost time or end the race. |
| Live races | The run waits up to 45 seconds for the driver's call. Without an answer, the driver's instinct (from their aggression) decides. |
| Race Control | Can switch driver moments off, and sees who's still choosing. |

#### Notifications and announcements

A bell and a Notifications page: application and seat decisions, new seats, weekends opening and finishing, contract offers, a team-mate saving race plans, awards, and driver moments waiting. Race Control posts announcements (also to Discord if ticked) from the Race Control page.

#### Driver profiles

Every driver's page now has: portrait upload, nickname and hometown, life before Formula 1, helmet design, the trophy cabinet, relationships declared by players (rival, friend, mentor, unfinished business), track rivals worked out from the race logs, a career timeline, a diary, and the race-by-race record.

#### Awards, Driver of the Day and driver cards

| What | How it works |
| --- | --- |
| Awards | Pole, race and sprint wins, fastest lap, biggest climber, set-up of the weekend (for engineers), Driver of the Day. Worked out from the results. |
| Driver of the Day | Everyone votes once after each race (and can change it) until the next weekend opens. |
| Driver cards | Drawn in the browser: driver card, new signing, pole, race winner, Driver of the Day. Download for anyone; Race Control can post to Discord with the image. |

#### Team depth

| What | How it works |
| --- | --- |
| Power units | 4 per car per season. From the second weekend, the team principal or the car's engineer can fit a new one during practice. Beyond the allowance: 10-place grid penalty (5 for each after) and £1m. Older units fail more often and lose a little power. After a power unit failure a new one goes in automatically. Teams without players change theirs every six weekends. |
| Crash repairs | £0.8m from the budget for each accident. |
| Sponsors | The team principal signs one deal for the season: title partner, performance partner, reliability backer or young talent fund, each paying differently. |
| Contracts | The team principal offers players in the team's seats a salary, length and terms; the player signs or turns it down. Salaries come out of the budget at each Grand Prix. |
| Rapport | Each weekend the same player engineer and player driver lock in a set-up together: 10% clearer practice feedback (up to 50%) and +1 set-up quality (up to +4). |

---

## v0.5.0: Race strategy

11 November 2026. Build `f1sim0005`. **Database update:** `20261111000004_strategy.sql`.

| Area | What it does |
| --- | --- |
| Three plans per car | The team principal, the car's race engineer and its driver can each build Plan A, B and C: the starting tyre, up to three stops (lap and tyre), and whether to take a stop under a safety car when one is due within 10 laps. The last plans saved are the ones the car uses, and the team sees who saved them. |
| Weather calls | Each plan says when to go onto wet tyres if it rains (straight away, after a lap, or gamble on slicks until it's properly wet) and when to come back onto slicks (straight away, after a dry lap, or carefully after a few). The car follows them lap by lap. |
| Tyre knowledge | The planner shows how long each tyre lasts here: measured by practice long runs, or a rough guide if they weren't done. It warns about stints longer than the tyre lasts and plans that use only one dry tyre. **Suggest plans** fills in a one-stop, an attacking two-stop and an alternative one-stop. |
| Choosing the start plan | One plan is set for the start; the car starts on its tyre (or on wet tyres if the race starts wet). |
| Switching mid-race | From the pit wall, any of the three can switch the car to another plan. It keeps the stops still ahead in that plan, and its weather calls. |
| Plans in the race | A planned car stops on its planned laps, early under a safety car if the plan says so, or early if a tyre is finished. A stop off wet tyres counts as the next planned stop. Cars without plans keep the AI strategist. |
| Forecast | The planner shows the forecast for the race: dry, rain expected, a wet start, or the circuit's chance of rain. |
| Database | Saved plans belong to the account that saved them. |

---

## v0.4.0: Character applications and View as

11 November 2026. Build `f1sim0004`. **No database update.**

| Area | What it does |
| --- | --- |
| Character applications | Every new character is an application: who they are, then (for drivers) a background and rolled ratings, then Race Control. Only approved characters can apply for seats. |
| Driver backgrounds | Formula 2 graduate, karting prodigy, IndyCar or endurance convert, team reserve driver, returning veteran. Each sets the rating range, experience and small adjustments. Fixed once you roll. |
| Rolling | Five numbers for pace, consistency, wet weather, overtaking and defence, plus mental strength. Two re-rolls; the latest roll stands. Arrange the five numbers across the ratings. Nobody starts above 90. Choose a driving style. |
| Fair rolls | Rolls are worked out from the character and the roll number, so they can't be shopped for, and approval recalculates the ratings rather than trusting the application. Race Control sees every roll. |
| Approval | Race Control approves (the ratings become the driver record every session uses) or returns the application with a note. |
| The weekend explained | Each driver's page explains how every rating plays out across practice, qualifying, the race and development. |
| View as | Race Control picks any character in the top bar and sees the league exactly as they do: Home, seat, Team HQ, pit wall, practice. Anything done counts as that character and stays the player's record. A banner shows whose view you're in. |

---

## v0.3.0: Live race weekend

11 November 2026. Build `f1sim0003`. **No database update.**

| Area | What it does |
| --- | --- |
| Stages | A strip across the weekend: Practice, Q1, Q2, Q3, Race, Result. |
| Qualifying a session at a time | Race Control runs Q1, Q2 and Q3 separately. Each shows only the sessions run so far, who's out, and the fastest time in purple, so nothing later leaks. |
| Live race | Race Control presses play and the race runs itself at a chosen speed (a lap every 4, 2 or 1 seconds). Everyone sees each lap as it happens, and pit-wall calls apply on the next lap. Optionally pauses for safety cars. Pause, step a lap, or run to the flag at any time. |
| Timing | Fastest lap of the race in purple, personal bests in green, places gained or lost since the start. Click any driver to follow them. |
| Race view tabs | Race log, lap chart (every car's position lap by lap, the followed driver or players in bold), tyre strategy, and a driver tab: position, gap, best lap, stops, tyre wear, battery, lap-time bars, stints and their own race log. |
| Results so far | Every finished weekend, with its full race view. |

---

## v0.2.0: Roles: practice, budgets, upgrades and driver careers

11 November 2026. Build `f1sim0002`. **Database update:** `20261111000003_roles.sql`.

| Area | What it does |
| --- | --- |
| Practice programme | Each car gets 4 practice runs. Set-up runs: the driver describes what the car is doing for each of downforce, suspension and differential. Long runs show how long a tyre lasts. Qualifying simulations show roughly where the car would qualify. Lock in a set-up for qualifying; cars nobody locks in run a standard set-up. A well-found set-up is worth about three tenths a lap. Experienced drivers give clearer feedback. |
| Who runs practice | The team principal, the car's race engineer, or its driver if no player engineers that car. |
| Team budget | £30m development budget for the season, plus £1m per Grand Prix, £0.05m per point and £0.8m when the sponsors' target is met. |
| Upgrades | Eight projects (front wing, floor, low-drag and high-downforce packages, power unit modes, reliability, suspension, pit crew), each with a cost, a build time and a chance of not working fully. The team principal orders them; Race Control starts them when it opens the next weekend, two at a time, within the budget. |
| Teams without a player in charge | Develop on their own: one upgrade every second race. |
| Driver development | Points from results: one per Grand Prix, plus points finishes, podiums, wins and beating the team-mate. Spend them on ratings (costlier above 80 and 90). Experience grows with races. |
| Careers | A page for every driver: starts, wins, podiums, poles, points, team-mate head-to-heads and every race. Race engineers' pages show the set-ups they found. Names on The Grid, Team HQ and the Championship link to them. |
| Team HQ | The car with its upgrades, the people, the budget, development, and your own driver's development. |
| Database | Practice runs, upgrade orders and development belong to the account that made them. |

---

## v0.1.0: F1 SIM: the first standalone build

11 November 2026. Build `f1sim0001`. **Database update:** `20261111000001_f1_sim.sql and 20261111000002_member_backfill.sql`.

| Area | What it does |
| --- | --- |
| Race engine | Lap by lap and seeded, so any race can be replayed: tyres and wear, fuel, weather, overtaking with overtake mode, safety cars, pit stops, reliability, team orders, an AI strategist per team. |
| Formula Racing V3.0 data | 11 teams, 22 drivers, 23 circuits and V3.0's ratings, through an adapter. Team strategies are the AI strategist's habits. |
| The Grid | Today's grid as the default: team principal, two drivers and two race engineers per team. Characters replace the real people when they take a seat. |
| Seat applications | Race Control opens seats; players apply as a character with a pitch; approving fills the seat and declines the rest. |
| Race Weekend | Practice with set-ups, qualifying, the race; Race Control runs one lap, five, or to the flag, optionally stopping at safety cars. |
| Pit walls | Team principal: orders and every call. Race engineer: set-up, stops, mode. Driver: mode, stops, refusing an order. |
| Championship | Drivers and constructors, with sprints. |
| Paddock | News, interviews and paddock-life posts by characters; press notes from the latest race. |
| Characters | Several per account, one played at a time: driver, team principal, race engineer, media or paddock life. |
| Race Control | Applications, every character, car tuning, driver ratings, an audit record, Discord results. |
| Accounts and backups | Roles, password resets, account removal, invite code, backup and restore. |
| Database | One migration for a new project: ownership rules for characters, applications, posts and calls. |
| Look | A new design for the whole site, light and dark, on phones and desktops. |

#### Removed

Everything from UNTSF-COMM: TSFs, equipment and the catalogue, eishi files, missions, combat, the campaign map, research, production, procurement, personnel records, posters, the starter catalogue and the old migrations.

#### Known limits

- The calendar is V3.0's 23 rounds, not the exact 2026 calendar.
- No grid penalties, stewards' decisions or blue flags yet.
- No driver development between seasons yet.
