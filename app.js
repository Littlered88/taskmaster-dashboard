// --- Splash Screen ---
// Shown on load unless the user previously ticked "Don't show this again",
// in which case it's skipped entirely. Independent of the view-loading
// fade-in below — the dashboard loads normally underneath regardless of
// whether the splash is shown, it's purely an overlay layer on top.
const SPLASH_DISMISSED_KEY = "taskmaster_splash_dismissed";

function initSplashScreen() {
  const splash = document.getElementById("splash-screen");
  if (!splash) return;

  const alreadyDismissed = localStorage.getItem(SPLASH_DISMISSED_KEY) === "true";
  if (alreadyDismissed) {
    splash.classList.add("dismissed");
    return;
  }

  const continueBtn = document.getElementById("splash-continue-btn");
  const dontShowCheckbox = document.getElementById("splash-dont-show");

  continueBtn.addEventListener("click", () => {
    if (dontShowCheckbox.checked) {
      localStorage.setItem(SPLASH_DISMISSED_KEY, "true");
    }
    splash.classList.add("dismissed");
  });
}

initSplashScreen();

// --- WebSocket Setup ---
const socket = new WebSocket("ws://localhost:7071");

// Global state cache to support filtering
let globalTaskList = [];
let globalCompletedIds = [];
let globalProgress = {};
let globalPinnedIds = [];

// Shop/unlocks state. The catalogue (allUnlocks) is only ever sent once,
// on connect — ownership changes after that arrive as small targeted
// UNLOCK_PURCHASED messages rather than a full catalogue resend.
let globalUnlockCatalogue = [];
let globalOwnedPerkIds = new Set();
let globalOwnedRegionIds = new Set();
let globalAvailablePoints = 0;
let activeShopTab = "REGIONS";

// Tracks whether view fragments have finished loading and are in the DOM.
// The WebSocket can receive data before fragments finish fetching — and
// since the server now sends BOTH a stats payload and a catalogue payload
// on connect, a single "pending" slot isn't enough (the second message
// would silently overwrite the first). Queue instead, replay in order
// once views are ready.
let viewsReady = false;
let pendingMessageQueue = [];

socket.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (!viewsReady) {
    pendingMessageQueue.push(data);
    return;
  }
  routeIncomingMessage(data);
};

// Distinguishes the three message types the server can push, based on
// the payloadType discriminator field present on all of them.
function routeIncomingMessage(data) {
  switch (data.payloadType) {
    case "UNLOCKS_CATALOGUE":
      handleUnlocksCatalogue(data);
      break;
    case "UNLOCK_PURCHASED":
      handleUnlockPurchased(data);
      break;
    case "PURCHASE_FAILED":
      handlePurchaseFailed(data);
      break;
    default:
      // STATS payload (or older payloads without the field yet)
      updateDashboard(data);
  }
}

// --- View Fragment Loading ---
// Fetches every view fragment in parallel and injects them into their
// container before the page is revealed, avoiding any flash/placeholder
// state when switching between Tasks/Unlocks/Stats.
async function loadViews() {
  const containers = document.querySelectorAll("[data-view-src]");

  const fetches = Array.from(containers).map(async (container) => {
    try {
      const response = await fetch(container.dataset.viewSrc);
      if (!response.ok) {
        throw new Error(`${container.dataset.viewSrc} returned ${response.status}`);
      }
      container.innerHTML = await response.text();
    } catch (err) {
      console.error("Failed to load view fragment:", container.dataset.viewSrc, err);
      container.innerHTML = `<div class="placeholder-text">Failed to load this view. Try refreshing the dashboard.</div>`;
    }
  });

  await Promise.all(fetches);

  viewsReady = true;
  document.body.classList.add("loaded");

  // Re-attach nav click handlers now the sections exist
  attachNavHandlers();

  // Replay any messages that arrived before views were ready, in order
  if (pendingMessageQueue.length > 0) {
    pendingMessageQueue.forEach(routeIncomingMessage);
    pendingMessageQueue = [];
  } else {
    // No data yet — still run an empty filter pass so the task grid
    // shows its "no tasks" state correctly rather than staying blank
    filterTasks();
  }
}

loadViews();

// --- Navigation Logic ---
function attachNavHandlers() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      // 1. Remove active class from all nav items and views
      document.querySelectorAll(".nav-item").forEach((nav) => nav.classList.remove("active"));
      document.querySelectorAll(".view-section").forEach((view) => view.classList.remove("active"));

      // 2. Add active class to clicked nav item
      const clickedItem = e.currentTarget;
      clickedItem.classList.add("active");

      // 3. Show the corresponding section
      const targetId = clickedItem.getAttribute("data-target");
      document.getElementById(targetId).classList.add("active");
    });
  });
}

// --- Data Management & Rendering ---
function updateDashboard(data) {
  // 1. Cache the global state
  globalTaskList = data.availableTasks || [];
  globalCompletedIds = data.completedTaskIds || [];
  globalProgress = data.currentTaskProgress || {};

  // 2. Populate the Tasks page summary cards (only present while the
  // Tasks fragment is loaded — guarded since other views don't have
  // these elements).
  const availablePoints = data.totalPointsEarned - data.totalPointsSpent;
  updateTasksSummaryCards(availablePoints, data.completionPercentage);

  // 3. Render Tasks
  filterTasks();
}

function updateTasksSummaryCards(availablePoints, completionPercentage) {
  const pointsEl = document.getElementById("tasks-points-value");
  const completedEl = document.getElementById("tasks-completed-value");
  const completedSubEl = document.getElementById("tasks-completed-sub");
  const inProgressEl = document.getElementById("tasks-in-progress-value");
  const closestEl = document.getElementById("tasks-closest-value");
  const closestSubEl = document.getElementById("tasks-closest-sub");

  // Elements only exist while the Tasks fragment is in the DOM — bail
  // quietly if we're not currently on that page rather than throwing.
  if (!pointsEl) return;

  pointsEl.innerText = availablePoints.toLocaleString();

  completedEl.innerText = `${globalCompletedIds.length} / ${globalTaskList.length}`;
  completedSubEl.innerText = `${(completionPercentage || 0).toFixed(1)}% overall`;

  // Find tasks with partial progress (trackable, not yet completed, target > 1).
  // Progress is clamped to target — some trackers (e.g. varbit-driven kill
  // counts or CA totals) can report a raw value higher than the task's
  // target, which would otherwise show nonsense like "18 / 12 — -6 to go".
  const trackableTypes = ["KILL", "PROCESSING", "INVENTORY", "VARBIT", "EXPERIENCE", "CHAT"];
  const inProgressTasks = globalTaskList.filter((task) => {
    if (globalCompletedIds.includes(task.id)) return false;
    if (!task.tracker) return false;
    const target = task.tracker.target || 0;
    const progress = globalProgress[task.id] || 0;
    const isTrackable = trackableTypes.includes(task.tracker.type.toUpperCase());
    return isTrackable && progress > 0 && target > 1;
  });

  inProgressEl.innerText = inProgressTasks.length;

  if (inProgressTasks.length === 0) {
    closestEl.innerText = "—";
    closestSubEl.innerText = "—";
    return;
  }

  const closest = inProgressTasks.reduce((best, task) => {
    const target = task.tracker.target || 1;
    const progress = Math.min(globalProgress[task.id] || 0, target);
    const pct = progress / target;
    const bestTarget = best.tracker.target || 1;
    const bestProgress = Math.min(globalProgress[best.id] || 0, bestTarget);
    const bestPct = bestProgress / bestTarget;
    return pct > bestPct ? task : best;
  });

  const closestTarget = closest.tracker.target || 0;
  const closestProgress = Math.min(globalProgress[closest.id] || 0, closestTarget);
  closestEl.innerText = closest.name;
  closestSubEl.innerText = `${closestProgress} / ${closestTarget} — ${closestTarget - closestProgress} to go`;
}

function renderTasks(availableTasks, completedTaskIds, currentTaskProgress) {
  const list = document.getElementById("task-list");
  list.innerHTML = "";

  availableTasks.forEach((task) => {
    try {
      const isCompleted = completedTaskIds.includes(task.id);

      // 1. Pre-calculate progress to determine the container's CSS class
      let progress = (currentTaskProgress && currentTaskProgress[task.id]) || 0;
      let target = task.tracker ? task.tracker.target || 0 : 0;
      const isTrackable =
        task.tracker &&
        ["KILL", "PROCESSING", "INVENTORY", "VARBIT", "EXPERIENCE", "CHAT"].includes(task.tracker.type.toUpperCase());

      const isInProgress = !isCompleted && isTrackable && progress > 0 && target > 1;

      // 2. Apply the correct status class
      const item = document.createElement("div");
      let statusClass = "";
      if (isCompleted) statusClass = "completed";
      else if (isInProgress) statusClass = "in-progress";

      const isPinned = globalPinnedIds.includes(task.id);
      if (isPinned) statusClass += " pinned-card";

      item.className = `task-item ${statusClass}`;

      // 3. Format Strings
      const tierLower = task.tier ? task.tier.toLowerCase() : "unknown";
      const tierFormatted = task.tier
        ? task.tier.charAt(0).toUpperCase() + task.tier.slice(1).toLowerCase()
        : "Unknown";
      const tierClass = `tier-${tierLower}`;
      const rawRegion = task.region || "GLOBAL";
      const region = rawRegion
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");

      // --- ICON RESOLUTION LOGIC ---
      let iconUrl = "https://static.runelite.net/cache/item/icon/23814.png"; // 1. Default (Scroll)

      // 2. Explicit JSON Override (Highest Priority)
      if (task.icon) {
        if (typeof task.icon === "string") {
          // If it's a string (e.g., "AGILITY"), point to your local assets folder
          iconUrl = `./assets/skills/${task.icon}.png`;
        } else if (typeof task.icon === "number") {
          // If it's a number (e.g., 13069), fetch the exact item from RuneLite
          iconUrl = `https://static.runelite.net/cache/item/icon/${task.icon}.png`;
        }
      }
      // 3. Safe Fallback to tracker.ids (Only for Item-based tasks!)
      else if (task.tracker && task.tracker.ids && task.tracker.ids.length > 0) {
        // Whitelist ONLY the tracker types where the IDs explicitly represent Items
        const safeItemTrackers = ["EQUIPMENT", "INVENTORY", "PROCESSING"];

        if (safeItemTrackers.includes(task.tracker.type.toUpperCase())) {
          iconUrl = `https://static.runelite.net/cache/item/icon/${task.tracker.ids[0]}.png`;
        }
      }

      let progressBarHTML = "";

      if (
        task.tracker &&
        ["KILL", "PROCESSING", "INVENTORY", "VARBIT", "EXPERIENCE", "CHAT"].includes(task.tracker.type.toUpperCase())
      ) {
        const target = task.tracker.target || 0;
        if (target > 1) {
          const progress = (currentTaskProgress && currentTaskProgress[task.id]) || 0;
          const clampedProgress = Math.min(progress, target);
          const percentage = Math.floor((clampedProgress / target) * 100);

          if (!isCompleted) {
            progressBarHTML = `
                            <div class="task-progress-container">
                                <div class="task-progress-text">
                                    <span>Progress</span>
                                    <span>${clampedProgress} / ${target}</span>
                                </div>
                                <div class="task-progress-track">
                                    <div class="task-progress-fill" style="width: ${percentage}%;"></div>
                                </div>
                            </div>
                        `;
          }
        }
      }

      const buttonHTML = isCompleted
        ? `<button class="btn-action">✓ Completed</button>`
        : `<button class="btn-action" onclick="sendCompleteTask(${task.id})">Mark Complete</button>`;

      const pinClass = isPinned ? "pinned" : "";
      // Pin icon (📌/📍) rather than a padlock — a lock reads as
      // "this task is locked/unlocked" rather than "pin to top",
      // which was confusing since unrelated lock states also exist
      // elsewhere in the dashboard (e.g. region/unlock cards).
      const pinIcon = isPinned ? "📌" : "📍";

      // Points reward, derived from tier (matches TaskmasterTier.java
      // server-side values — no separate points field on the task yet)
      const tierPoints = { EASY: 10, MEDIUM: 50, HARD: 100, ELITE: 250, MASTER: 500 };
      const points = tierPoints[(task.tier || "").toUpperCase()] || 0;

      // Attach click event to open the modal
      item.onclick = () => openTaskDetails(task.id);

      item.innerHTML = `
                <div>
                    <div class="task-header">
                        <div class="task-title-group">
                            <img src="${iconUrl}" alt="Task Icon" class="task-icon" onerror="this.src='https://static.runelite.net/cache/item/icon/23814.png'" />
                            <h4>${task.name}</h4>
                        </div>
                        <button class="btn-pin ${pinClass}" onclick="event.stopPropagation(); togglePin(${task.id})" title="${isPinned ? "Unpin Task" : "Pin Task"}">${pinIcon}</button>
                    </div>
                    <div class="task-meta">
                        <span class="meta-tag">${region}</span>
                        <span class="meta-tag ${tierClass}">${tierFormatted}</span>
                        <span class="meta-tag points">+${points} pts</span>
                    </div>
                    ${progressBarHTML}
                </div>
            `;

      list.appendChild(item);
    } catch (e) {
      console.error("DEBUG - Failed to render task:", task);
      console.error("DEBUG - Error details:", e.message);
    }
  });
}

// --- Filter/Search Functionality ---
function filterTasks() {
  const searchTerm = document.getElementById("task-search").value.toLowerCase();
  const regionFilter = document.getElementById("region-filter").value;
  const tierFilter = document.getElementById("tier-filter").value;
  const statusFilter = document.getElementById("status-filter").value;
  const sortOrder = document.getElementById("sort-filter").value;

  // 1. Filter the cached global list
  let filtered = globalTaskList.filter((task) => {
    // ALWAYS return pinned tasks, bypassing all filters
    if (globalPinnedIds.includes(task.id)) return true;

    const matchesSearch =
      task.name.toLowerCase().includes(searchTerm) ||
      (task.description && task.description.toLowerCase().includes(searchTerm));
    const taskRegion = (task.region || "GLOBAL").toUpperCase();
    const matchesRegion = regionFilter === "ALL" || taskRegion === regionFilter;
    const taskTier = (task.tier || "UNKNOWN").toUpperCase();
    const matchesTier = tierFilter === "ALL" || taskTier === tierFilter;

    const isCompleted = globalCompletedIds.includes(task.id);
    let matchesStatus = true;

    if (statusFilter === "COMPLETED") {
      matchesStatus = isCompleted;
    } else if (statusFilter === "INCOMPLETE") {
      matchesStatus = !isCompleted;
    } else if (statusFilter === "IN-PROGRESS") {
      let progress = (globalProgress && globalProgress[task.id]) || 0;
      let target = task.tracker ? task.tracker.target || 0 : 0;
      const isTrackable =
        task.tracker &&
        ["KILL", "PROCESSING", "INVENTORY", "VARBIT", "EXPERIENCE", "CHAT"].includes(task.tracker.type.toUpperCase());
      matchesStatus = !isCompleted && isTrackable && progress > 0 && target > 1;
    }

    return matchesSearch && matchesRegion && matchesTier && matchesStatus;
  });

  // 2. Sort the remaining filtered list
  const tierWeights = { EASY: 1, MEDIUM: 2, HARD: 3, ELITE: 4, MASTER: 5, UNKNOWN: 0 };

  filtered.sort((a, b) => {
    // Force pinned tasks to the very top
    const aPinned = globalPinnedIds.includes(a.id);
    const bPinned = globalPinnedIds.includes(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;

    if (sortOrder === "TIER_ASC") {
      return (
        (tierWeights[(a.tier || "UNKNOWN").toUpperCase()] || 0) -
        (tierWeights[(b.tier || "UNKNOWN").toUpperCase()] || 0)
      );
    } else if (sortOrder === "TIER_DESC") {
      return (
        (tierWeights[(b.tier || "UNKNOWN").toUpperCase()] || 0) -
        (tierWeights[(a.tier || "UNKNOWN").toUpperCase()] || 0)
      );
    } else if (sortOrder === "AZ") {
      return a.name.localeCompare(b.name);
    }
    return 0; // Default sort
  });

  // 3. Render the newly filtered and sorted array
  renderTasks(filtered, globalCompletedIds, globalProgress);
}

// --- Reset Filters ---
function resetFilters() {
  // Reset all inputs to their default values
  document.getElementById("task-search").value = "";
  document.getElementById("region-filter").value = "ALL";
  document.getElementById("tier-filter").value = "ALL";
  document.getElementById("status-filter").value = "ALL";
  document.getElementById("sort-filter").value = "DEFAULT";

  // Re-run the filter logic to update the dashboard
  filterTasks();
}

// --- Send data back to the Plugin ---
function sendCompleteTask(taskId) {
  const payload = {
    action: "COMPLETE_TASK",
    taskId: taskId,
  };

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// --- Pinning Logic ---
function togglePin(taskId) {
  if (globalPinnedIds.includes(taskId)) {
    globalPinnedIds = globalPinnedIds.filter((id) => id !== taskId);
  } else {
    globalPinnedIds.push(taskId);
  }
  filterTasks(); // Instantly refresh the UI
}

// --- Modal Logic ---
function openTaskDetails(taskId) {
  // Find the specific task data
  const task = globalTaskList.find((t) => t.id === taskId);
  if (!task) return;

  const isCompleted = globalCompletedIds.includes(task.id);
  const tier = task.tier ? task.tier.charAt(0).toUpperCase() + task.tier.slice(1).toLowerCase() : "Unknown";
  const rawRegion = task.region || "GLOBAL";
  const region = rawRegion
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  // Set Text
  document.getElementById("modal-title").innerText = task.name;
  document.getElementById("modal-desc").innerText = task.description;
  document.getElementById("modal-region").innerText = region;
  document.getElementById("modal-tier").innerText = tier;

  // Resolve Icon (re-using your existing logic pattern)
  let iconUrl = "https://static.runelite.net/cache/item/icon/23814.png";
  if (task.icon) {
    if (typeof task.icon === "string") iconUrl = `./assets/skills/${task.icon}.png`;
    else if (typeof task.icon === "number") iconUrl = `https://static.runelite.net/cache/item/icon/${task.icon}.png`;
  } else if (task.tracker && task.tracker.ids && task.tracker.ids.length > 0) {
    const safeItemTrackers = ["EQUIPMENT", "INVENTORY", "PROCESSING"];
    if (safeItemTrackers.includes(task.tracker.type.toUpperCase()))
      iconUrl = `https://static.runelite.net/cache/item/icon/${task.tracker.ids[0]}.png`;
  }
  const modalIcon = document.getElementById("modal-icon");
  modalIcon.src = iconUrl;
  modalIcon.onerror = () => (modalIcon.src = "https://static.runelite.net/cache/item/icon/23814.png");

  // Set Button (Only show if incomplete)
  const footer = document.getElementById("modal-footer");
  if (isCompleted) {
    footer.innerHTML = `<button class="btn-action" style="background: transparent; border: 1px solid var(--accent-green); color: var(--accent-green); cursor: default;">✓ Completed</button>`;
  } else {
    footer.innerHTML = `<button class="btn-action" onclick="sendCompleteTask(${task.id}); closeTaskDetails()">Mark Complete</button>`;
  }

  // Show Modal
  document.getElementById("task-modal").classList.add("active");
}

function closeTaskDetails(event) {
  // If an event is passed, ensure we only close if the dark overlay background was clicked, not the inner modal
  if (event && event.target.id !== "task-modal") return;
  document.getElementById("task-modal").classList.remove("active");
}
// =====================================================================
// --- Shop / Unlocks View ---
// =====================================================================

const SHOP_CATEGORIES = [
  { id: "REGIONS", label: "Regions & Oceans" },
  { id: "ISLANDS", label: "Islands" },
  { id: "SHOPS", label: "Shops" },
  { id: "GUILDS", label: "Guilds" },
  { id: "MINIGAMES", label: "Minigames" },
  { id: "SKILLING", label: "Skilling" },
  { id: "STORAGE", label: "Storage" },
  { id: "TRANSPORTATION", label: "Transportation" },
  { id: "ITEMS", label: "Items" },
  { id: "SKILLING_BOSSES", label: "Skilling Bosses" },
  { id: "BOSSES", label: "Bosses" },
  { id: "RAIDS", label: "Raids" },
];

// Per-category filter config. Each entry lists which filter keys apply to
// that category — the filter bar only renders dropdowns for keys listed
// here, with options derived dynamically from the actual catalogue data
// rather than hardcoded, so adding a new filterable field later (e.g.
// shopType, difficulty) just means adding the key here once that field
// actually exists in the unlock JSON data.
const CATEGORY_FILTERS = {
  SHOPS: ["region"],
  // GUILDS: ['region'],
  // BOSSES: ['region', 'difficulty'],  // 'difficulty' field doesn't exist in data yet
};

const FILTER_LABELS = {
  region: "Region",
};

// Search is global/cross-category by design — see project discussion:
// scoping search to the active tab would mean searching for something
// in the wrong category returns nothing, which is a bad experience.
// A non-empty query switches #shop-content into a flat cross-category
// results view and the tab bar is de-emphasized until cleared.
let globalShopSearchQuery = "";

// Active filter selections for the CURRENTLY VIEWED category only.
// Reset whenever the category tab changes, since a region filter
// selected on Shops has no obvious meaning carried over to Bosses.
let globalShopActiveFilters = {};

// Sort order — A-Z by default. Persists across tab switches and search
// (unlike filters), since a sort preference is a personal display
// preference rather than something tied to a specific category's data.
let globalShopSortOrder = "AZ";

// --- Incoming message handlers ---

function handleUnlocksCatalogue(data) {
  globalUnlockCatalogue = data.allUnlocks || [];
  globalOwnedPerkIds = new Set(data.initiallyOwnedPerks || []);
  globalOwnedRegionIds = new Set(data.initiallyOwnedRegions || []);
  globalAvailablePoints = data.availablePoints || 0;

  renderShopTabs();
  renderShopFilterBar();
  renderShopContent();
}

function handleUnlockPurchased(data) {
  globalOwnedPerkIds.add(data.unlockId);
  globalAvailablePoints = data.availablePoints;

  // Targeted update — no full re-render needed for state we already
  // hold in memory, but re-rendering the current tab is still far
  // cheaper than a full catalogue resend would have been, and keeps
  // the affordability/owned state of every visible card in sync.
  renderShopContent();
}

function handlePurchaseFailed(data) {
  const card = document.querySelector(`[data-unlock-id="${data.unlockId}"]`);
  if (!card) return;
  card.classList.add("shake");
  setTimeout(() => card.classList.remove("shake"), 400);
}

// --- Outgoing purchase request ---

function sendPurchaseUnlock(unlockId) {
  const payload = {
    action: "PURCHASE_UNLOCK",
    unlockId: unlockId,
  };
  socket.send(JSON.stringify(payload));
}

// --- Search ---

function handleShopSearch() {
  const input = document.getElementById("shop-search");
  globalShopSearchQuery = input.value.trim().toLowerCase();

  // Searching de-emphasizes (but doesn't hide) the tabs, since the
  // active tab becomes irrelevant while a cross-category search is
  // active — clearing the query falls back to whichever tab was
  // selected before the search started.
  const tabsContainer = document.getElementById("shop-tabs");
  if (tabsContainer) {
    tabsContainer.classList.toggle("de-emphasized", globalShopSearchQuery.length > 0);
  }

  renderShopContent();
}

function matchesSearchQuery(unlock) {
  if (!globalShopSearchQuery) return true;
  const haystack = `${unlock.name} ${unlock.description || ""}`.toLowerCase();
  return haystack.includes(globalShopSearchQuery);
}

// --- Filtering ---

function renderShopFilterBar() {
  const filterBar = document.getElementById("shop-filter-bar");
  if (!filterBar) return;

  const filterKeys = CATEGORY_FILTERS[activeShopTab];

  // No filters defined for this category (or we're on a search results
  // view, or the Regions tab which has no filter bar at all) — hide it
  // entirely rather than showing an empty bar.
  if (!filterKeys || filterKeys.length === 0 || globalShopSearchQuery) {
    filterBar.innerHTML = "";
    filterBar.classList.add("hidden");
    return;
  }

  filterBar.classList.remove("hidden");

  filterBar.innerHTML = filterKeys
    .map((key) => {
      const options = getFilterOptions(key);
      return `
            <select class="shop-filter-select" data-filter-key="${key}" onchange="handleShopFilterChange(this)">
                <option value="">All ${FILTER_LABELS[key] || key}</option>
                ${options.map((opt) => `<option value="${opt}">${formatRegionName(opt)}</option>`).join("")}
            </select>
        `;
    })
    .join("");
}

// Derives the distinct set of values present for a given filter key,
// from the actual catalogue data for the active category — so the
// dropdown only ever shows options that exist, never an empty/dead one.
function getFilterOptions(key) {
  const itemsInCategory = globalUnlockCatalogue.filter((u) => u.category === activeShopTab);

  if (key === "region") {
    const regions = new Set(itemsInCategory.map((u) => u.parentRegion).filter(Boolean));
    return Array.from(regions).sort();
  }

  return [];
}

function handleShopFilterChange(selectEl) {
  const key = selectEl.dataset.filterKey;
  const value = selectEl.value;

  if (value) {
    globalShopActiveFilters[key] = value;
  } else {
    delete globalShopActiveFilters[key];
  }

  renderShopContent();
}

function matchesActiveFilters(unlock) {
  for (const [key, value] of Object.entries(globalShopActiveFilters)) {
    if (key === "region" && unlock.parentRegion !== value) return false;
  }
  return true;
}

// --- Sorting ---

function handleShopSortChange(selectEl) {
  globalShopSortOrder = selectEl.value;
  renderShopContent();
}

function sortUnlocks(items) {
  const sorted = [...items];

  switch (globalShopSortOrder) {
    case "AZ":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "ZA":
      sorted.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case "PRICE_LOW_HIGH":
      sorted.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
      break;
    case "PRICE_HIGH_LOW":
      sorted.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
      break;
    case "REGION":
      sorted.sort((a, b) => (a.parentRegion || "").localeCompare(b.parentRegion || "") || a.name.localeCompare(b.name));
      break;
    case "AFFORDABLE_FIRST":
      sorted.sort((a, b) => {
        const aOwned = globalOwnedPerkIds.has(a.id) || globalOwnedRegionIds.has(a.id);
        const bOwned = globalOwnedPerkIds.has(b.id) || globalOwnedRegionIds.has(b.id);
        const aAffordable = !aOwned && globalAvailablePoints >= a.cost;
        const bAffordable = !bOwned && globalAvailablePoints >= b.cost;

        const rank = (owned, affordable) => (owned ? 1 : affordable ? 0 : 2);
        const aRank = rank(aOwned, aAffordable);
        const bRank = rank(bOwned, bAffordable);

        if (aRank !== bRank) return aRank - bRank;

        if (aRank === 2) {
          return a.cost - b.cost || a.name.localeCompare(b.name);
        }

        return a.name.localeCompare(b.name);
      });
      break;
    default:
      sorted.sort((a, b) => a.name.localeCompare(b.name));
  }

  return sorted;
}

// --- Tab rendering ---

function renderShopTabs() {
  const tabsContainer = document.getElementById("shop-tabs");
  if (!tabsContainer) return;

  tabsContainer.innerHTML = SHOP_CATEGORIES.map(
    (cat) => `
        <div class="shop-tab ${cat.id === activeShopTab ? "active" : ""}" data-tab="${cat.id}">
            ${cat.label}
        </div>
    `,
  ).join("");

  tabsContainer.querySelectorAll(".shop-tab").forEach((tabEl) => {
    tabEl.addEventListener("click", () => {
      activeShopTab = tabEl.dataset.tab;
      globalShopActiveFilters = {};
      renderShopTabs();
      renderShopFilterBar();
      renderShopContent();
    });
  });
}

// --- Content rendering ---

function renderShopContent() {
  const container = document.getElementById("shop-content");
  if (!container) return;

  updateShopSummaryCards();

  if (globalShopSearchQuery) {
    renderSearchResults(container);
  } else if (activeShopTab === "REGIONS") {
    renderRegionsTab(container);
  } else {
    renderUnlockGrid(container, activeShopTab);
  }
}

function renderSearchResults(container) {
  const matches = sortUnlocks(globalUnlockCatalogue.filter(matchesSearchQuery));

  if (matches.length === 0) {
    container.innerHTML = `<div class="placeholder-text">No unlocks found matching "${globalShopSearchQuery}".</div>`;
    return;
  }

  container.innerHTML = `
        <div class="unlock-grid">
            ${matches.map((u) => renderUnlockCard(u, true)).join("")}
        </div>
    `;
}

function updateShopSummaryCards() {
  const pointsEl = document.getElementById("shop-points-available");
  if (pointsEl) pointsEl.innerText = globalAvailablePoints.toLocaleString();

  const regionsOwnedEl = document.getElementById("shop-regions-owned");
  if (regionsOwnedEl) {
    const totalRegions = globalUnlockCatalogue.filter((u) => u.category === "REGION" || u.category === "OCEAN").length;
    regionsOwnedEl.innerText = `${globalOwnedRegionIds.size} / ${totalRegions}`;
  }
}

function renderRegionsTab(container) {
  const regions = sortUnlocks(globalUnlockCatalogue.filter((u) => u.category === "REGION" || u.category === "OCEAN"));

  if (regions.length === 0) {
    container.innerHTML = `<div class="placeholder-text">No region data available.</div>`;
    return;
  }

  container.innerHTML = `
        <div class="region-grid">
            ${regions.map(renderRegionCard).join("")}
        </div>
    `;
}

function renderRegionCard(region) {
  const isOwned = globalOwnedRegionIds.has(region.id);
  const statusClass = isOwned ? "owned" : "locked";
  const statusIcon = isOwned ? "🔓" : "🔒";

  const costOrLabel = isOwned
    ? `<span class="region-owned-label">Owned</span>`
    : `<span class="region-cost-value">${region.cost.toLocaleString()} pts</span>`;

  return `
        <div class="region-card ${statusClass}" data-unlock-id="${region.id}">
            <div class="region-card-header">
                <h4>${region.name}</h4>
                <span class="region-status-icon">${statusIcon}</span>
            </div>
            <div class="region-card-cost">
                ${costOrLabel}
            </div>
        </div>
    `;
}

function renderUnlockGrid(container, category) {
  const items = sortUnlocks(globalUnlockCatalogue.filter((u) => u.category === category).filter(matchesActiveFilters));

  if (items.length === 0) {
    const hasActiveFilters = Object.keys(globalShopActiveFilters).length > 0;
    const message = hasActiveFilters
      ? "No unlocks match the selected filters."
      : "No unlocks available in this category yet.";
    container.innerHTML = `<div class="placeholder-text">${message}</div>`;
    return;
  }

  container.innerHTML = `
        <div class="unlock-grid">
            ${items.map((u) => renderUnlockCard(u, false)).join("")}
        </div>
    `;
}

function renderUnlockCard(unlock, showCategoryTag) {
  const isOwned = globalOwnedPerkIds.has(unlock.id);
  const canAfford = globalAvailablePoints >= unlock.cost;
  const cardClass = isOwned ? "owned" : canAfford ? "affordable" : "";

  const categoryTag = showCategoryTag
    ? `<span class="unlock-category-tag">${formatRegionName(unlock.category)}</span>`
    : "";

  const regionTag = unlock.parentRegion
    ? `<span class="unlock-region-tag">${formatRegionName(unlock.parentRegion)}</span>`
    : "";

  const footer = isOwned
    ? `<span class="owned-badge">✓ Unlocked</span>`
    : `
            <div class="unlock-cost">
                <span class="cost-label">Cost</span>
                ${unlock.cost.toLocaleString()} pts
            </div>
            <button class="btn-unlock" ${canAfford ? "" : "disabled"}
                    onclick="sendPurchaseUnlock('${unlock.id}')">Unlock</button>
        `;

  return `
        <div class="unlock-item ${cardClass}" data-unlock-id="${unlock.id}">
            <div class="unlock-item-header">
                <h4>${unlock.name}</h4>
                <div class="unlock-tag-group">
                    ${categoryTag}
                    ${regionTag}
                </div>
            </div>
            <div class="unlock-desc">${unlock.description || ""}</div>
            <div class="unlock-footer">
                ${footer}
            </div>
        </div>
    `;
}

function formatRegionName(regionId) {
  return regionId
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
