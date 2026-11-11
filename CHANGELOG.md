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
