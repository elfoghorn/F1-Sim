# F1 SIM Change Log: race strategy

Build `f1sim0005`. Includes your `site/config.js`.

## To deploy

Copy the zip's contents over the repository, commit and push. **Set up database** applies `20261111000004_strategy.sql`. Hard-refresh the site.

## Changes

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
