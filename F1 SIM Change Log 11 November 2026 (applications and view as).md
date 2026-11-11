# F1 SIM Change Log: character applications and View as

Build `f1sim0004`. Includes your `site/config.js`. No database change.

## To deploy

Copy the zip's contents over the repository, commit and push, then hard-refresh.

## Changes

| Area | What it does |
| --- | --- |
| Character applications | Every new character is an application: who they are, then (for drivers) a background and rolled ratings, then Race Control. Only approved characters can apply for seats. |
| Driver backgrounds | Formula 2 graduate, karting prodigy, IndyCar or endurance convert, team reserve driver, returning veteran. Each sets the rating range, experience and small adjustments. Fixed once you roll. |
| Rolling | Five numbers for pace, consistency, wet weather, overtaking and defence, plus mental strength. Two re-rolls; the latest roll stands. Arrange the five numbers across the ratings. Nobody starts above 90. Choose a driving style. |
| Fair rolls | Rolls are worked out from the character and the roll number, so they can't be shopped for, and approval recalculates the ratings rather than trusting the application. Race Control sees every roll. |
| Approval | Race Control approves (the ratings become the driver record every session uses) or returns the application with a note. |
| The weekend explained | Each driver's page explains how every rating plays out across practice, qualifying, the race and development. |
| View as | Race Control picks any character in the top bar and sees the league exactly as they do: Home, seat, Team HQ, pit wall, practice. Anything done counts as that character and stays the player's record. A banner shows whose view you're in. |
