# F1 SIM Change Log: driver moments, profiles, awards and team depth

Build `f1sim0006`. Includes your `site/config.js`.

## To deploy

Copy the zip's contents over the repository, commit and push. **Set up database** applies `20261111000005_paddock.sql`. Hard-refresh the site.

## Driver moments

| What | How it works |
| --- | --- |
| When | A player's driver within 0.9s of the car ahead (attack), with a car within 0.9s behind (defend), or at a safety-car restart. At most one moment per car every five laps. |
| Choices | Attack: around the outside, down the inside, use the boost, bide your time. Defend: cover the inside, hold your line, let them by. Restart: go for the jump, play it safe. |
| Odds | Shown on each choice, from the drivers' overtaking and defence, the circuit and the battery. The race uses the same numbers. Contact can cost time or end the race. |
| Live races | The run waits up to 45 seconds for the driver's call. Without an answer, the driver's instinct (from their aggression) decides. |
| Race Control | Can switch driver moments off, and sees who's still choosing. |

## Notifications and announcements

A bell and a Notifications page: application and seat decisions, new seats, weekends opening and finishing, contract offers, a team-mate saving race plans, awards, and driver moments waiting. Race Control posts announcements (also to Discord if ticked) from the Race Control page.

## Driver profiles

Every driver's page now has: portrait upload, nickname and hometown, life before Formula 1, helmet design, the trophy cabinet, relationships declared by players (rival, friend, mentor, unfinished business), track rivals worked out from the race logs, a career timeline, a diary, and the race-by-race record.

## Awards, Driver of the Day and driver cards

| What | How it works |
| --- | --- |
| Awards | Pole, race and sprint wins, fastest lap, biggest climber, set-up of the weekend (for engineers), Driver of the Day. Worked out from the results. |
| Driver of the Day | Everyone votes once after each race (and can change it) until the next weekend opens. |
| Driver cards | Drawn in the browser: driver card, new signing, pole, race winner, Driver of the Day. Download for anyone; Race Control can post to Discord with the image. |

## Team depth

| What | How it works |
| --- | --- |
| Power units | 4 per car per season. From the second weekend, the team principal or the car's engineer can fit a new one during practice. Beyond the allowance: 10-place grid penalty (5 for each after) and £1m. Older units fail more often and lose a little power. After a power unit failure a new one goes in automatically. Teams without players change theirs every six weekends. |
| Crash repairs | £0.8m from the budget for each accident. |
| Sponsors | The team principal signs one deal for the season: title partner, performance partner, reliability backer or young talent fund, each paying differently. |
| Contracts | The team principal offers players in the team's seats a salary, length and terms; the player signs or turns it down. Salaries come out of the budget at each Grand Prix. |
| Rapport | Each weekend the same player engineer and player driver lock in a set-up together: 10% clearer practice feedback (up to 50%) and +1 set-up quality (up to +4). |
