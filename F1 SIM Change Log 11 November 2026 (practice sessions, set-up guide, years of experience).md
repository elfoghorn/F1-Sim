# F1 SIM Change Log: practice sessions, set-up guidance and years of experience

Build `f1sim0009`. Includes your `site/config.js`. No database change.

## To deploy

Copy the zip's contents over the repository, commit and push, then hard-refresh.

## Changes

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
