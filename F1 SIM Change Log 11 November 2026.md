# F1 SIM Change Log: 11 November 2026

Build `f1sim0001`. F1 SIM is a full conversion of UNTSF-COMM: every Muv-Luv part is gone, and what remains is the infrastructure (Supabase sign-in, live data, roles, Discord relay, phone install) with a Formula 1 league built on it. It needs its **own new Supabase project**; see SETUP.md.

## What's new

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

## Removed

Everything from UNTSF-COMM: TSFs, equipment and the catalogue, eishi files, missions, combat, the campaign map, research, production, procurement, personnel records, posters, the starter catalogue and the old migrations.

## Known limits

- The calendar is V3.0's 23 rounds, not the exact 2026 calendar.
- No grid penalties, stewards' decisions or blue flags yet.
- No driver development between seasons yet.
