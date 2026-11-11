# F1 SIM Change Log: series and seasons

Build `f1sim0008`. Includes your `site/config.js`.

## To deploy

Copy the zip's contents over the repository, commit and push. **Set up database** applies `20261111000006_series.sql`. Hard-refresh the site. Your existing league becomes Formula 1's first season (2026); nothing is lost.

## Series

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

## Seasons

| What | How it works |
| --- | --- |
| Seasons page | Everyone sees the current season and every catalogued one: champions, teams' champions, final standings and every result. |
| Catalogue a season | Race Control, after the last round. Saves the final standings and champions; no weekends can be opened until the next season starts. |
| Start a new season | Name it, choose whether players keep their seats, and (in series with development) how much of each car's development carries over: none, half or all. |
| Fresh each season | Budgets, upgrades in progress, power units, sponsors and contracts. |
| Carried on | Driver ratings, development, careers, awards, relationships and diaries. |
