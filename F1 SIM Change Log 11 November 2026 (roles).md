# F1 SIM Change Log: roles update

Build `f1sim0002`. Gives race engineers, team principals and drivers real decisions.

## To deploy

Copy the zip's contents over the repository (keep your own `site/config.js`), commit and push. **Set up database** applies `20261111000003_roles.sql`. Hard-refresh the site.

## Changes

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
