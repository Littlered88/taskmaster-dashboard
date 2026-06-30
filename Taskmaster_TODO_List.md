# Taskmaster — TODO List

## In Progress
- Task data population — remaining regions to complete:
  - ~~Kharidian Desert~~ ✅ Complete
  - ~~Fremennik Province~~ ✅ Complete
  - ~~Great Kourend~~ ✅ Complete (4 tasks pending verification on higher-level account)
  - ~~Morytania~~ ✅ Complete
  - Tirannwn — first pass complete, pending Dean's review
  - Varlamore — trackers actively being added
  - Wilderness — first pass complete, pending Dean's review
  - Misthalin (file does not exist yet)
  - Ocean files (Ardent, Shrouded, Western, Northern, Sunset, Unquiet — files do not exist yet)

## Dashboard Features
- **Stats screen** — design and implement the stats/progress page on the dashboard
- **Settings page** — full settings page on the dashboard covering account type,
  difficulty, starting region, and any other configurable options. Note: distinct
  from the existing first-run setup wizard; this provides ongoing access to config
  after setup is complete
- **First-run setup options on dashboard** — move account type, difficulty and
  starting region display to the dashboard. Config options currently locked after
  setup (partially overlaps with settings page above — consider consolidating)
- **Dashboard region detail page** — full region information page linked from
  "More..." in RegionSelectionDialog and grace period panel
- **WebSocket reconnection handling** — dashboard does not currently attempt to
  reconnect if the WebSocket connection drops
- **Offline/demo mode** — bundle a `demo_data.json` in the dashboard repo
  mirroring the WebSocket payload structure exactly. Dashboard automatically falls
  back to this data when no WebSocket connection is available, allowing prospective
  users to try the dashboard via the GitHub Pages URL without installing the plugin.
  Consider an optional manual toggle to force demo mode even when the plugin is
  running, useful for showing the dashboard to others without exposing personal
  account data
- **High scores (far future)** — opt-in community progress leaderboard. Requires
  external backend infrastructure, explicit RuneLite approval (data leaving the
  client), and clear opt-in/privacy disclosure. Defer until plugin is established
  with an active user base; approach RuneLite with usage data to support the request

## Plugin Hub Submission Prep
- **WebSocket toggle** — add a boolean config option in `TaskmasterConfig.java`
  to enable/disable the WebSocket server. Plugin should listen for config changes
  via `onConfigChanged` to start/stop the server dynamically without requiring a
  client restart
- **Config description for WebSocket** — add a clear description to the WebSocket
  config option explaining that the server runs locally on localhost:7071 and that
  no player data is sent to any external server. The GitHub Pages dashboard only
  serves static files; all player data stays on the player's own machine
- **Review AGENTS.md** — go through all Plugin Hub submission guidelines in
  AGENTS.md before submitting and ensure no remaining violations

## Balancing
- **Review all unlock JSON files** — go through shops, guilds, bosses, minigames,
  storage, raids, skilling, transportation, and islands JSON files and verify
  entries are correct, complete, and consistently formatted
- **Categorise unlocks by progression stage** — tag each unlock as early/mid/late
  game based on intended progression stage. Cross-reference current costs against
  task reward values per tier to identify misalignment (e.g. Barrows at 2000
  points vs Easy tasks awarding only 10 points each — 200 tasks for one unlock)
- **Task list balancing for account types** — review task availability and
  appropriateness per account type (MAIN, IRONMAN, UIM etc.) once account type
  filtering is implemented
- **Task reward rebalancing** — current per-tier task rewards (Easy: 10, Medium:
  50, Elite: 250) create an early-game bottleneck — Easy+Medium tasks across
  completed regions total ~35,410 points, while Elite alone is nearly triple that.
  Consider rebalancing tier rewards (e.g. Easy 10→20, Medium 50→75, Elite
  250→~200) once unlock categorisation above is done and remaining task files are
  populated, so the full picture is known before adjusting
- **Re-run cost/availability analysis once all task files complete** — current
  estimate assuming ~7 remaining files at average 11,721 points/region gives
  ~210,992 total available points. Cross-check against region+unlock costs per
  difficulty:
  - Squire (0.5x): 189,500 total cost — currently ~100%+ completable (small surplus)
  - Adventurer (0.75x): 284,250 — ~74% completable
  - Champion (1.0x): 379,000 — ~56% completable
  - Legend (1.5x): 568,500 — ~37% completable
  - Mythic (2.0x): 758,000 — ~28% completable (matches target 20-30%)
  - Champion's ~56% may feel too restrictive for the "default" difficulty —
    revisit once playtesting is possible

## Pending Features
- **Account type task filtering** — filter tasks based on selected account type
  (MAIN, IRONMAN, UIM etc.). Model is in place, implementation pending
- **Region unlock cost formula** — replace the placeholder linear formula in
  getNextRegionUnlockCost() with a proper scaling formula tied to difficulty
  multiplier
- **Multiple trackers per task** — change tracker field from single object to
  array to support tasks requiring multiple tracking mechanisms (e.g. catch with
  or without butterfly jar). Requires handler refactoring and progress
  deduplication logic. Defer until post-release

## Technical Debt
- **Task card horizontal overflow** — task cards in the side panel expand beyond
  available width. Previous fix attempts caused tasks to disappear. Needs fresh
  investigation
- **TaskmasterIDs constant lookup map** — replace raw integer IDs in JSON with
  named constants resolved at runtime via a static map. Defer until LTS
- **Chat message value extraction** — extend capture group tracker to support
  other message formats beyond XP values. Currently specific to Sq'irkjuice
  pattern
- **Update boss kill count CHAT trackers** — update boss tasks that use the CHAT
  tracker to parse the number of kills from the chat message using the
  captureGroup pattern, rather than incrementing by 1 per message. Ensures
  correct progress tracking for players who already have kills before starting
  the challenge
- **Hitsplat tracker** — add HITSPLAT tracker type using onHitsplatApplied event,
  supporting damage threshold checks (getAmount()), player source verification
  (isMine()), and target NPC matching. Useful for tasks requiring specific damage
  in a single hit
- **Session tracker** — add SESSION tracker type for tasks requiring uninterrupted
  progress within a single instance or area visit (e.g. "Defeat Vorkath 15 times
  without leaving"). Requires a session counter that resets when the player leaves
  the tracked area, using onGameStateChanged and area polygon detection
- **Task dependency tracker** — add requiredTaskIds field to TaskmasterTracker
  allowing a task's progress to be driven by the completion of other tasks. Check
  in completeTask() whether any tasks depend on the just-completed task and award
  progress accordingly. Useful for aggregate tasks like "Equip every Dagannoth
  King ring" satisfied by completing individual sub-tasks
- **ChatTaskHandler resetClickContext() collision** — resetClickContext() after a
  CHAT match can null lastClickedOption before a PROCESSING task triggered by the
  same item gain event evaluates interactionOptions. Worked around case-by-case
  so far by removing interactionOptions from affected tasks. Needs a proper fix —
  investigate whether resetClickContext() in ChatTaskHandler is load-bearing for
  any existing tasks before removing/restructuring

## Completed
- ✅ Persistence layer refactor — atomic JSON save data
- ✅ Region selection dialog — replaced JOptionPane with proper UI
- ✅ Replace Javalin with Java-WebSocket + GitHub Pages
- ✅ Split TaskmasterTaskHandler into focused handlers
- ✅ Fix threading issue in reloadData
- ✅ Address isLocationLocked default behaviour
- ✅ First-run setup flow — wizard, grace period, anti-smuggling checks
- ✅ Demote verbose logging to debug-gated logs
- ✅ Codebase cleanup and performance optimisations
- ✅ Capture group tracker — extract numeric values from chat messages
- ✅ conditionVarbit and minValue tracker fields
- ✅ messageType tracker field
- ✅ Kharidian Desert task data population
- ✅ Fremennik Province task data population
- ✅ Great Kourend task data population
- ✅ Morytania task data population
- ✅ PROJECTILE tracker — onProjectileMoved handler with source location validation
- ✅ menuTargets field — match spell/item names in MenuOptionClicked menuTarget text
- ✅ Wildcard entity ID (-1) support for INTERACT tasks
- ✅ onWidgetLoaded support in InteractTaskHandler for interface-triggered tasks
- ✅ Area validation for EQUIPMENT tasks
- ✅ accumulate and trackDecrease fields for varbit delta tracking
- ✅ reassign_task_ids.py — standardised task ID format (RRTNNN)
- ✅ calculate_unlock_costs.py — total unlock cost analysis with difficulty multiplier breakdown
- ✅ EXPERIENCE tracker extended to support interactionOptions and menuTargets
- ✅ Task page filter/search state persisted across dashboard refreshes
- ✅ Dashboard favicon added
- ✅ Interactive region map — SVG world map with land and ocean regions, region
  banners, hover label, jewel-toned unlock colours, water mask clipping oceans
  to sea areas, gold border world boundary, dynamic task distribution bar
- ✅ Region info panel — tabbed layout (Overview/Content/Unlocks) with task
  distribution stacked bar, tag sections with optional wiki links, dynamic task
  counts calculated from live plugin data with regionTaskSummary fallback for
  unowned regions
- ✅ EMOTE tracker type — AnimationChanged + proximity NPC/object scan, indexed
  in TaskmasterDataManager, configurable searchRadius defaulting to 4 tiles
- ✅ INTERACT wildcard fix — tasks with menuTargets now exempt from entityId=0
  guard, enabling item-on-item inventory interactions to be tracked
- ✅ regionTaskSummary compact payload field — per-region tier counts sent on
  startup for all regions (not just owned), enabling task distribution display
  for unowned regions on the dashboard map
