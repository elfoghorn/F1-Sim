# F1 SIM Change Log: live race weekend

Build `f1sim0003`. The race weekend is broken into stages and can run live. This build includes your own `site/config.js`, so nothing needs re-entering.

## To deploy

Copy the zip's contents over the repository, commit and push, then hard-refresh the site. No database change this time.

## Changes

| Area | What it does |
| --- | --- |
| Stages | A strip across the weekend: Practice, Q1, Q2, Q3, Race, Result. |
| Qualifying a session at a time | Race Control runs Q1, Q2 and Q3 separately. Each shows only the sessions run so far, who's out, and the fastest time in purple, so nothing later leaks. |
| Live race | Race Control presses play and the race runs itself at a chosen speed (a lap every 4, 2 or 1 seconds). Everyone sees each lap as it happens, and pit-wall calls apply on the next lap. Optionally pauses for safety cars. Pause, step a lap, or run to the flag at any time. |
| Timing | Fastest lap of the race in purple, personal bests in green, places gained or lost since the start. Click any driver to follow them. |
| Race view tabs | Race log, lap chart (every car's position lap by lap, the followed driver or players in bold), tyre strategy, and a driver tab: position, gap, best lap, stops, tyre wear, battery, lap-time bars, stints and their own race log. |
| Results so far | Every finished weekend, with its full race view. |
