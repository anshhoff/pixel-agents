# Living office: design

Status: approved 2026-10-17 · Branch: `remote-ingest`

Every room means something: a character walks to the zone that matches what its
session is doing, so the board reads at a glance. Behaviour is client-side
animation driven by signals the board already has. The server only adds what it
alone knows.

## Zones

Zones are layout **Areas** (`areas` + `areaTiles` in the layout JSON, an existing
feature) with reserved labels:

| Label      | Room                       | Spots                             |
| ---------- | -------------------------- | --------------------------------- |
| `Entrance` | Reception by the main door | the door tile (spawn/despawn)     |
| `Smoke`    | Balcony off the lounge     | standing spots around the ashtray |
| `Lounge`   | Sofas                      | sofa seats                        |
| `Meeting`  | Meeting room               | table chairs                      |
| `Server`   | Server room                | standing spots facing the racks   |
| `Cafe`     | Café                       | counter and bistro seats          |

A layout without a zone simply skips that behaviour, so the default layout still works.

## Rules (first match wins)

| Signal                                                                     | Destination                              | Effect                                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| sleeping (`agentSleep`)                                                    | Lounge seat                              | dimmed, 💤                                                                                             |
| needs permission, or running `AskUserQuestion`                             | Meeting chair                            |                                                                                                        |
| current tool is a test/build command (phase `test` with a live shell tool) | Server spot                              | rack LEDs blink                                                                                        |
| active                                                                     | own desk seat                            | name plate shows the repo                                                                              |
| turn ended, waiting on the user                                            | Smoke spot                               | cigarette + rising puffs; back to the desk on `active`                                                 |
| short gap between tools, sometimes                                         | Café counter, then back                  | coffee cup                                                                                             |
| `agentCreated`                                                             | spawn at Entrance door, walk to the desk |                                                                                                        |
| `agentClosed`                                                              | walk to the Entrance door, then despawn  |                                                                                                        |
| `dailyStats` gains a push or PR                                            | bell rings at the desk                   | confetti; a trophy appears on the trophy wall (cups = PRs, boxes = pushes, at most one per shelf slot) |

**Hysteresis**: keep a destination for at least 8 s, so fast tool bursts don't make a
character pace back and forth. Sub-agents follow their parent's zone, except
`active`, where they take the nearest free desk.

## Ambience

- **Office cat**: one built-in pet wanders the office.
- **Windows**: wall windows tint with the local time: day, dusk, night.
- **Lights**: at night the canvas dims a little. A room with nobody in it dims further.
- **Name plates**: a small plate on each occupied desk with the repo name. A repo tends to
  keep the same desk, through the existing Directory → Area seat bias.

## Art (sprite pack)

`remote/office-pack/` is an external furniture pack in the same format as
`dist/assets/furniture/*` (16 px grid, manifest + PNG), drawn to match the default palette:

- ASHTRAY_STAND
- SERVER_RACK (2 LED frames)
- RECEPTION_DESK
- BELL
- TROPHY_CUP (gold, silver, bronze)
- TROPHY_BOX
- COFFEE_MACHINE
- WATER_COOLER
- WINDOW (day, dusk, night)
- NAME_PLATE
- BALCONY_RAILING
- stone floor tile

Effects drawn by the renderer rather than shipped as furniture: smoke puffs, confetti, cigarette.

## Additions (user decisions, 2026-10-17)

- **Labels: task title + repo**, e.g. `Draft review by email · hobbyfi-blog`.
  - The title comes from the session transcript's `ai-title` records (newest wins), read by the server and sent with the agent.
  - Remote (Mac) sessions have no transcript here, so they keep `💻 Mac · repo`.
- **Sound: bell + needs-you chime.**
  - A bell when a push or PR lands.
  - The existing chime on a permission request or a turn ending.
  - Browsers need one click on the tab to unlock audio. The board shows a small "🔈 click to enable sound" hint until then.
- **Phone alerts (ntfy)**:
  - The server POSTs once per wait to `https://ntfy.sh/<random topic>` when an agent has waited on the user for 15 min.
  - Body: `⏳ <title> · <repo> is waiting on you (15m)`. Nothing else: no commands, no paths.
  - The topic is stored in `~/.pixel-agents/alerts.json` and is off when absent. The user subscribes in the ntfy app.
- **Background agents → compact "remote workers"**:
  - Background/headless sessions get small tiles in a corner panel (status dot + title + repo) instead of full characters.
  - Detection: the session list's `kind` is not `interactive`. Hook-only local sessions that never appear in the list within 30 s are treated as headless.
  - Remote sessions are always full characters.
- **Crowding**:
  - When Smoke has no free spot, extra waiters go to the Cafe.
  - When no desk is free, extra workers take Cafe/Lounge seats.
  - Sessions shorter than ~20 s skip the walk-in/walk-out animation.

## Phases (each shown to the user before the next)

- **A. Living office**: zones in the layout, destination engine, entrance walk in/out,
  smoke, lounge, meeting, server. Also task-title labels, remote-worker tiles for background
  agents, and ntfy phone alerts.
- **B. Celebrations**: bell (with sound), confetti, trophies on the trophy wall.
- **C. Ambience**: café coffee runs, cat, day/night windows and lights, name plates.
