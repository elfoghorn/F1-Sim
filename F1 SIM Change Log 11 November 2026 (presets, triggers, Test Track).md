# F1 SIM Change Log: presets, triggers, official races and the Test Track

Build `f1sim0007`. Includes your `site/config.js`. No database change.

## To deploy

Copy the zip's contents over the repository, commit and push, then hard-refresh.

## Changes

| Area | What it does |
| --- | --- |
| Team presets | Each team has its own preset, built from how it likes to race (McLaren's aggressive two-stop, Williams' lift and coast, and so on). Four general presets too: safe one-stop, attacking two-stop, wet-weather gamble, safety-car opportunist. Loading one fills all three plans and their triggers, using what the team knows about the tyres. |
| Race approach | Balanced, attacker, defender or tyre saver. It picks the driving mode lap by lap (push when there's a car to catch or someone close behind, manage in clean air) and decides driver moments in official races. Each driver's natural approach comes from their driving style. |
| Defaults | A car in a team with players but no saved plans uses the team's own preset and the driver's natural approach. Teams without players keep the AI strategist. |
| Triggers | Up to six per car: when a safety car comes out (optionally between two laps), rain starts, the track dries, places are lost or gained from the grid, or tyre wear reaches a level, then switch to Plan A, B or C, push, manage, or box. Each fires once, with a chance of the team acting on it (always, 75%, half the time, 25%). The race log says when a trigger fires, or when the team sticks with the plan. |
| Official races | On by default when opening a weekend. Once the race starts, nobody can change anything from the pit wall: the plans, triggers and race approach run the cars, and driver moments follow the approach. Race Control can untick it for a weekend to allow live calls. |
| Randomness | When opening a weekend, Race Control sets the chance of rain (the circuit's usual, none, 20, 40, 60 or 90%), how often safety cars and crashes happen, and how often cars break down (fewer, as usual, more, chaos). The forecast in every team's strategy card reflects it. |
| Test Track | The same simulator, with the league's grid, cars, upgrades and ratings, run in each person's own browser. Pick any car, circuit, weather and randomness; load presets, build plans and triggers, set the approach and set-up; then run qualifying and the race live or lap by lap with full control: modes, stops, plan switches and driver moments. Nothing is saved or counted. |
