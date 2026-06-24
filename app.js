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
const TIER_POINTS = { EASY: 10, MEDIUM: 50, HARD: 100, ELITE: 250, MASTER: 500 };

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
let globalRegionInfo = {};

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

  fetch("region_info.json")
    .then((r) => r.json())
    .then((data) => {
      globalRegionInfo = data;
    })
    .catch(() => {});

  viewsReady = true;
  document.body.classList.add("loaded");

  const taskSearch = sessionStorage.getItem("tm_task_search");
  const taskRegion = sessionStorage.getItem("tm_task_region");
  const taskTier = sessionStorage.getItem("tm_task_tier");
  const taskStatus = sessionStorage.getItem("tm_task_status");
  const taskSort = sessionStorage.getItem("tm_task_sort");
  if (taskSearch !== null) document.getElementById("task-search").value = taskSearch;
  if (taskRegion !== null) document.getElementById("region-filter").value = taskRegion;
  if (taskTier !== null) document.getElementById("tier-filter").value = taskTier;
  if (taskStatus !== null) document.getElementById("status-filter").value = taskStatus;
  if (taskSort !== null) document.getElementById("sort-filter").value = taskSort;

  // Re-attach nav click handlers now the sections exist
  attachNavHandlers();

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

  sessionStorage.setItem("tm_task_search", searchTerm);
  sessionStorage.setItem("tm_task_region", regionFilter);
  sessionStorage.setItem("tm_task_tier", tierFilter);
  sessionStorage.setItem("tm_task_status", statusFilter);
  sessionStorage.setItem("tm_task_sort", sortOrder);

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

  sessionStorage.removeItem("tm_task_search");
  sessionStorage.removeItem("tm_task_region");
  sessionStorage.removeItem("tm_task_tier");
  sessionStorage.removeItem("tm_task_status");
  sessionStorage.removeItem("tm_task_sort");

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
  const mapEl = document.querySelector(`[data-catalogue-id="${data.unlockId}"]`);
  if (mapEl) mapEl.classList.add("unlocked");

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

  const controlsBar = document.querySelector(".shop-controls-bar");
  if (controlsBar) {
    controlsBar.style.display = !globalShopSearchQuery && activeShopTab === "REGIONS" ? "none" : "";
  }

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

const REGION_MAP_SVG = `<svg id="region-map-svg" viewBox="0 120 2400 1610" xmlns="http://www.w3.org/2000/svg">
<rect id="map-border"
      x="20" y="140" width="2360" height="1440"
      fill="rgba(255,255,255,0.04)"
      stroke="#d4af37"
      stroke-width="8"
      pointer-events="none"/>
 
  <g id="ocean-layer">      
    <g class="map-ocean" id="map-ocean-sunset_ocean" style="--rc:#7d5a1e" data-region-id="sunset_ocean" data-catalogue-id="SUNSET_OCEAN" data-region-name="Sunset Ocean">
      <polygon class="map-ocean-shape" points="21,862 211,861 225,804 252,803 357,835 705,1207 706,1343 651,1342 636,1359 638,1577 22,1577 21,863"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-forgotten_ocean" style="--rc:#2e4057" data-region-id="forgotten_ocean" data-catalogue-id="FORGOTTEN_OCEAN" data-region-name="Forgotten Ocean">
      <polygon class="map-ocean-shape" points="21,859 190,859 222,715 226,611 246,536 247,482 296,453 620,304 617,139 21,141 21,860"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-western_ocean" style="--rc:#1a5276" data-region-id="western_ocean" data-catalogue-id="WESTERN_OCEAN" data-region-name="Western Ocean">
      <polygon class="map-ocean-shape" points="702,317 829,317 866,344 868,392 850,410 921,473 1040,478 1054,636 1029,707 998,904 919,950 712,954 635,1026 482,922 214,775 254,484 699,316"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-northern_ocean" style="--rc:#1f618d" data-region-id="northern_ocean" data-catalogue-id="NORTHERN_OCEAN" data-region-name="Northern Ocean">
      <polygon class="map-ocean-shape" points="622,139 631,318 699,314 828,314 867,341 871,392 854,410 922,471 1039,476 1056,634 1073,689 1108,700 1257,740 1318,643 1318,573 1295,536 1365,461 1510,456 1603,407 1624,355 1644,262 1640,140 623,139"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-shrouded_ocean" style="--rc:#154360" data-region-id="shrouded_ocean" data-catalogue-id="SHROUDED_OCEAN" data-region-name="Shrouded Ocean">
      <polygon class="map-ocean-shape" points="713,956 918,953 1007,914 1042,862 1118,846 1171,787 1204,808 1197,883 1253,1075 1263,1282 1218,1328 1214,1579 644,1576 638,1361 651,1345 708,1346 708,1206 661,1155 638,1030"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-ardent_ocean" style="--rc:#21618c" data-region-id="ardent_ocean" data-catalogue-id="ARDENT_OCEAN" data-region-name="Ardent Ocean">
      <polygon class="map-ocean-shape" points="1265,1281 1443,1285 1473,1259 1543,1255 1659,1197 1735,1194 1789,951 1845,820 1837,762 1786,709 1661,662 1522,660 1424,629 1312,715 1248,806 1226,949 1231,988 1256,1085 1266,1281"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-unquiet_ocean" style="--rc:#1a6b9a" data-region-id="unquiet_ocean" data-catalogue-id="UNQUIET_OCEAN" data-region-name="Unquiet Ocean">
      <polygon class="map-ocean-shape" points="1804,1205 1803,1252 1816,1276 1835,1280 1847,1295 1855,1323 1837,1331 1813,1329 1813,1336 1810,1361 1813,1405 1809,1441 1808,1471 1818,1509 1822,1552 1810,1580 1217,1579 1220,1329 1265,1283 1445,1287 1474,1261 1543,1258 1659,1199 1735,1196 1804,1206"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-eastern_ocean" style="--rc:#1c5980" data-region-id="eastern_ocean" data-catalogue-id="EASTERN_OCEAN" data-region-name="Eastern Ocean">
      <polygon class="map-ocean-shape" points="1818,487 2058,499 2282,502 2380,456 2379,1578 2045,1579 1813,1580 1826,1552 1822,1508 1811,1470 1812,1441 1817,1405 1813,1361 1816,1336 1816,1332 1836,1333 1859,1325 1850,1293 1837,1277 1818,1273 1805,1251 1806,1206 1931,1018 1897,887 1874,833 1818,486"/>
    </g>
  
    <g class="map-ocean" id="map-ocean-untamed_ocean" style="--rc:#1b4f72" data-region-id="untamed_ocean" data-catalogue-id="UNTAMED_OCEAN" data-region-name="Untamed Ocean">
      <polygon class="map-ocean-shape" points="1819,482 2055,495 2281,498 2380,452 2380,139 2177,141 1951,140 1737,140 1642,140 1648,257 1817,482"/>
    </g>
    
    <g class="map-region" id="map-region-varlamore" style="--rc:#8e44ad" data-region-id="varlamore" data-catalogue-id="VARLAMORE" data-region-name="Varlamore">
      <polygon class="map-region-shape" points="125,720 133,708 144,706 158,720 174,709 187,719 212,720 230,716 242,730 283,731 299,727 307,713 318,710 325,722 338,719 347,737 358,743 374,753 382,758 385,740 389,742 397,762 409,767 420,783 420,805 425,808 430,800 436,788 445,798 457,817 476,816 488,819 506,836 511,846 511,857 521,853 542,852 553,859 563,848 571,840 584,845 596,840 608,843 617,854 629,865 630,884 622,902 618,911 608,922 594,923 579,921 565,925 553,942 562,947 570,935 581,928 595,933 611,930 622,919 628,911 634,921 633,937 632,954 631,968 623,976 626,987 636,992 647,988 655,977 650,965 649,947 650,922 659,916 670,922 676,936 680,945 718,946 723,956 722,976 725,1004 724,1025 712,1039 696,1044 678,1044 660,1059 677,1079 678,1104 677,1116 663,1128 674,1143 674,1166 672,1178 659,1185 641,1186 631,1199 617,1204 601,1202 589,1193 564,1194 551,1186 550,1171 555,1155 544,1150 540,1123 530,1113 515,1099 511,1114 502,1123 489,1119 463,1093 461,1080 453,1081 452,1091 447,1100 440,1090 436,1073 426,1083 412,1072 399,1062 397,1050 398,1030 396,1015 384,1002 370,999 373,1006 382,1021 381,1046 380,1062 368,1075 358,1081 348,1072 338,1072 329,1081 319,1090 305,1088 295,1090 286,1100 272,1103 256,1104 246,1097 230,1084 222,1071 216,1049 213,1033 218,1018 212,1012 200,1000 199,973 197,961 207,948 211,937 210,917 212,902 224,902 227,908 235,907 245,909 245,925 246,935 254,926 261,921 257,907 258,893 259,883 254,877 249,889 247,901 238,895 234,881 238,871 248,866 246,857 243,844 234,845 228,855 219,865 208,876 195,876 183,865 177,837 164,846 154,855 147,847 147,822 137,829 126,822 123,805 126,787 129,773 129,773 126,743 124,722"/>
      <polygon class="map-region-shape" points="375,1091 386,1098 395,1108 412,1108 426,1108 426,1120 427,1129 439,1126 450,1133 455,1146 452,1163 450,1178 445,1193 439,1195 437,1207 438,1221 436,1232 427,1231 416,1219 404,1219 396,1231 384,1236 357,1234 348,1225 347,1208 337,1194 322,1193 306,1182 300,1165 302,1145 311,1134 323,1130 336,1119 347,1105 358,1098 374,1092"/>
    </g>
  </g>

  <g class="map-region" id="map-region-kourend" style="--rc:#c0395a" data-region-id="kourend" data-catalogue-id="GREAT_KOUREND" data-region-name="Great Kourend">
    <polygon class="map-region-shape" points="214,719 219,709 215,702 209,694 201,691 194,702 183,702 174,694 166,679 175,671 187,664 195,653 196,640 183,629 178,619 186,609 197,610 209,616 215,609 207,602 196,601 184,593 174,579 169,563 179,556 191,558 202,564 212,553 221,545 235,545 239,529 226,527 213,517 215,507 226,497 218,492 209,484 211,473 216,463 208,457 208,447 218,438 227,434 239,442 249,451 260,454 273,454 279,448 269,444 256,441 248,438 246,425 247,413 254,406 263,394 276,393 285,382 292,377 304,378 317,385 324,393 330,401 332,414 328,424 320,427 323,438 331,441 344,439 352,438 347,427 341,419 339,407 343,397 350,389 360,398 366,406 365,416 356,420 359,430 368,430 377,424 381,411 378,396 370,387 366,373 366,361 370,347 380,341 386,333 397,333 407,334 418,330 427,322 437,322 444,318 440,306 434,300 438,289 447,283 457,276 466,283 474,287 488,271 489,261 489,250 502,235 511,228 529,226 547,225 566,228 583,226 599,238 608,249 613,263 606,273 605,285 614,296 629,287 638,272 655,264 663,272 669,284 678,294 696,293 711,295 717,306 717,323 727,331 737,344 746,356 758,355 768,365 775,377 769,393 755,398 735,397 721,397 703,416 687,419 668,417 650,418 636,424 625,439 634,448 640,435 653,426 670,427 685,428 705,427 717,429 728,443 718,455 728,465 727,484 720,494 720,505 697,507 696,519 731,518 738,527 713,529 705,540 697,533 690,538 683,538 680,531 675,529 673,537 679,548 690,554 694,566 693,581 694,592 703,595 704,581 705,565 708,553 717,557 714,573 714,585 719,595 725,604 732,613 742,614 753,627 744,636 732,645 742,654 751,666 746,677 749,688 749,697 737,707 729,713 722,708 712,720 703,722 688,723 678,720 672,712 659,710 650,703 635,702 621,715 604,719 587,715 581,704 588,692 602,685 617,678 625,668 629,653 630,639 627,624 618,615 609,602 616,592 605,587 590,589 577,590 572,601 566,615 553,616 545,606 542,590 528,588 516,595 509,603 511,616 513,631 520,642 530,647 542,644 552,632 566,631 575,624 582,614 584,601 596,605 605,618 616,629 618,644 616,657 604,666 590,673 577,682 566,692 559,703 560,717 551,729 536,736 532,750 520,757 501,756 490,741 482,735 477,745 467,752 464,764 453,770 449,762 449,746 435,742 429,724 439,718 433,704 422,697 411,683 393,681 383,691 373,702 361,703 358,689 368,680 380,663 374,658 356,656 343,650 334,651 327,656 314,656 312,665 323,669 339,664 351,671 342,692 337,705 328,711 316,708 304,711 300,715 288,715 273,716 257,715 248,711 243,706 229,708 221,708"/>
    <polygon class="map-region-shape" points="375,302 393,298 396,291 402,286 406,290 413,299 417,310 412,317 403,321 389,325 378,321 372,309"/>
    <polygon class="map-region-shape" points="627,250 628,248 632,244 639,242 646,245 646,254 643,262 634,263 627,262 625,256"/>
    <polygon class="map-region-shape" points="630,741 641,724 649,720 659,723 665,730 672,737 680,741 687,750 678,758 667,761 664,772 651,772 640,767 629,750"/>
  </g>

  <g class="map-region" id="map-region-fremennik" style="--rc:#2980b9" data-region-id="fremennik" data-catalogue-id="FREMENNIK_PROVINCE" data-region-name="Fremennik Province">
    <polygon class="map-region-shape" points="1295,568 1294,558 1288,553 1280,562 1270,566 1256,563 1243,547 1232,534 1220,520 1212,515 1203,506 1187,507 1175,505 1173,496 1179,487 1189,486 1199,490 1211,491 1214,475 1216,451 1214,433 1207,427 1193,429 1181,440 1168,445 1154,443 1141,434 1136,425 1140,418 1148,423 1158,421 1159,403 1156,393 1147,395 1137,395 1135,389 1148,382 1155,376 1172,376 1186,380 1196,389 1221,389 1240,392 1240,406 1257,412 1277,410 1288,404 1303,389 1317,376 1330,360 1340,360 1350,364 1355,380 1354,394 1362,405 1374,419 1391,418 1419,421 1434,431 1439,447 1440,484 1440,513 1436,540 1421,553 1405,558 1394,553 1381,536 1344,536 1312,538 1316,550 1298,571"/>
    <polygon class="map-region-shape" points="1428,318 1429,339 1440,353 1484,353 1498,371 1563,370 1577,388 1598,371 1595,328 1627,294 1627,259 1608,240 1562,241 1562,225 1557,218 1552,218 1550,224 1550,245 1529,263 1509,266 1496,287 1457,285 1429,316"/>
    <polygon class="map-region-shape" points="1188,313 1197,307 1207,308 1211,321 1199,332 1191,328 1187,321"/>
    <polygon class="map-region-shape" points="1209,303 1203,293 1191,294 1177,294 1171,286 1163,282 1155,287 1150,297 1133,284 1129,270 1140,250 1156,243 1174,239 1185,246 1196,254 1207,261 1223,259 1230,248 1248,246 1259,241 1270,253 1269,272 1261,288 1242,292 1234,281 1222,277 1207,275 1223,288 1225,303 1214,308"/>
    <polygon class="map-region-shape" points="1198,228 1203,220 1212,218 1217,228 1219,235 1212,240 1203,239 1200,235"/>
    <polygon class="map-region-shape" points="1045,398 1045,381 1064,381 1082,362 1088,350 1083,340 1075,333 1072,324 1071,309 1080,299 1089,295 1079,283 1066,281 1060,273 1048,272 1038,279 1034,288 1044,297 1053,307 1060,317 1057,328 1046,336 1041,344 1040,354 1032,355 1022,357 1016,364 1024,373 1032,379 1031,393 1035,401"/>
    <polygon class="map-region-shape" points="1014,350 996,331 984,328 977,333 969,335 970,319 981,317 998,319 1005,328 1015,331 1026,328 1032,316 1030,304 1024,298 1014,299 1015,281 1026,277 1035,269 1030,262 1017,262 1004,262 991,268 977,267 967,268 956,265 948,273 949,281 956,286 964,288 974,283 983,278 996,281 998,288 997,296 981,298 965,299 940,311 957,324 955,336 947,344 947,369 961,383 961,399 965,404 973,401 974,381 989,365 1009,365 1015,352"/>
    <polygon class="map-region-shape" points="958,233 969,229 979,227 985,230 994,235 1003,237 1015,235 1024,229 1037,232 1054,234 1059,241 1069,239 1078,239 1085,246 1080,252 1069,260 1058,258 1051,252 1038,249 1028,251 1019,251 1011,246 1000,242 989,251 972,250 952,249 950,238 958,231"/>
    <polygon class="map-region-shape" points="790,298 789,291 791,283 794,273 800,266 805,256 816,251 827,243 839,238 853,236 866,239 872,242 885,251 890,259 884,263 880,258 871,255 860,259 853,265 845,270 843,277 842,287 845,290 855,289 863,288 868,294 867,301 860,302 850,302 843,302 843,312 848,318 854,327 864,331 872,332 882,332 889,331 898,330 888,341 883,344 871,349 864,350 851,351 840,351 830,350 822,348 811,342 807,338 799,327 796,313 791,301"/>
  </g>

  <g class="map-region" id="map-region-tirannwn" style="--rc:#148f77" data-region-id="tirannwn" data-catalogue-id="TIRANNWN" data-region-name="Tirannwn">
    <polygon class="map-region-shape" points="890,936 890,909 866,908 865,896 871,890 889,893 892,874 904,864 906,846 897,835 892,826 899,814 913,811 925,810 928,800 916,796 911,787 904,777 898,765 897,740 902,723 912,722 922,719 919,707 907,698 897,697 888,685 890,672 898,669 908,658 922,660 936,664 942,676 952,674 962,663 972,654 972,640 979,628 992,627 1006,631 1013,639 1017,655 1016,669 1026,682 1039,689 1046,698 1045,713 1044,737 1064,759 1085,761 1092,771 1093,783 1088,794 1076,805 1077,827 1078,857 1062,871 1037,899 1034,905 1032,919 1024,929 1017,933 1016,945 1010,954 999,962 986,966 979,976 969,979 957,976 939,957 928,964 913,962 903,952 891,937"/>
  </g>

  <g class="map-region" id="map-region-kandarin" style="--rc:#cb4335" data-region-id="kandarin" data-catalogue-id="KANDARIN" data-region-name="Kandarin">
    <polygon class="map-region-shape" points="1077,746 1063,733 1065,696 1037,668 1035,635 1015,614 995,609 994,579 981,568 979,526 1000,505 1016,501 1027,494 1026,481 1017,474 1015,460 1021,449 1031,443 1047,443 1059,446 1072,455 1069,468 1061,474 1058,485 1061,497 1070,502 1084,507 1093,518 1098,528 1095,540 1083,552 1074,563 1072,579 1070,589 1070,605 1070,619 1070,669 1080,677 1086,685 1102,685 1104,671 1095,660 1088,648 1088,634 1088,619 1079,611 1081,583 1090,575 1104,571 1126,571 1147,573 1154,583 1167,580 1175,561 1188,547 1206,547 1219,558 1215,576 1203,584 1199,592 1204,605 1215,616 1226,612 1237,604 1248,610 1243,622 1240,634 1240,648 1239,665 1249,677 1260,681 1277,672 1283,659 1283,641 1272,630 1261,618 1260,604 1269,594 1285,588 1299,592 1306,583 1303,576 1297,570 1319,550 1337,557 1352,554 1367,563 1371,582 1379,593 1402,600 1428,601 1459,601 1467,610 1460,619 1454,628 1452,639 1452,658 1438,657 1430,647 1414,645 1412,660 1403,668 1399,657 1399,646 1388,656 1385,674 1381,690 1368,704 1365,727 1328,768 1304,773 1287,786 1287,803 1278,820 1297,828 1299,837 1286,840 1275,839 1278,854 1294,868 1297,913 1256,958 1235,965 1237,985 1280,987 1292,997 1289,1033 1273,1050 1271,1063 1263,1073 1270,1077 1281,1074 1297,1077 1296,1088 1277,1088 1272,1101 1263,1099 1262,1088 1209,1087 1198,1097 1182,1097 1169,1090 1152,1089 1147,1098 1123,1099 1114,1089 1115,1073 1128,1070 1143,1074 1162,1077 1154,1068 1161,1057 1166,1042 1162,999 1144,1001 1125,995 1117,986 1114,970 1098,961 1066,961 1039,959 1040,945 1053,941 1071,941 1084,934 1107,934 1154,890 1157,854 1182,828 1179,812 1140,842 1138,877 1109,912 1079,912 1069,925 1050,912 1066,892 1088,871 1096,826 1096,805 1112,792 1107,757 1099,746 1077,748"/>
    <polygon class="map-region-shape" points="1358,1147 1424,1144 1439,1162 1440,1180 1422,1195 1410,1201 1410,1217 1428,1219 1438,1223 1434,1236 1423,1246 1359,1244 1338,1227 1339,1162 1358,1147"/>
    <polygon class="map-region-shape" points="1495,1212 1512,1203 1537,1207 1539,1229 1517,1240 1495,1231"/>
    <polygon class="map-region-shape" points="1482,1171 1496,1146 1513,1141 1525,1160 1512,1180 1489,1179"/>
  </g>

  <g class="map-region" id="map-region-karamja" style="--rc:#1e8449" data-region-id="karamja" data-catalogue-id="KARAMJA" data-region-name="Karamja">
    <polygon class="map-region-shape" points="1343,847 1371,816 1375,818 1374,841 1377,854 1392,846 1393,833 1398,824 1403,835 1406,846 1421,846 1429,854 1455,856 1473,871 1514,876 1524,886 1544,887 1547,897 1530,899 1512,905 1471,905 1452,893 1416,892 1403,880 1397,882 1396,891 1406,905 1418,913 1439,917 1454,921 1527,922 1537,947 1540,965 1528,975 1530,984 1543,983 1551,974 1557,985 1552,996 1543,1003 1543,1014 1548,1025 1543,1038 1530,1046 1514,1044 1498,1029 1497,1012 1487,1007 1484,1019 1484,1029 1492,1039 1502,1047 1506,1060 1517,1063 1529,1060 1542,1072 1541,1089 1523,1100 1512,1086 1500,1091 1479,1092 1465,1103 1447,1104 1438,1101 1403,1102 1396,1089 1389,1073 1395,1057 1407,1047 1417,1033 1406,1032 1395,1025 1377,1002 1378,992 1391,986 1400,981 1391,970 1377,964 1377,943 1376,928 1391,912 1378,891 1359,899 1346,888 1350,878 1359,878 1357,863 1344,847"/>
    <polygon class="map-region-shape" points="1423,803 1417,792 1406,781 1417,767 1430,758 1444,751 1459,754 1465,769 1462,781 1462,797 1450,811 1429,811"/>
    <polygon class="map-region-shape" points="1371,1035 1381,1022 1386,1025 1392,1034 1389,1050 1374,1047"/>
  </g>

  <g class="map-region" id="map-region-asgarnia" style="--rc:#2471a3" data-region-id="asgarnia" data-catalogue-id="ASGARNIA" data-region-name="Asgarnia">
    <polygon class="map-region-shape" points="1415,568 1451,531 1455,430 1428,403 1388,404 1376,396 1379,367 1365,352 1364,316 1369,310 1403,311 1414,316 1414,340 1441,369 1476,370 1488,381 1554,382 1572,402 1575,423 1563,437 1564,491 1578,507 1580,526 1600,550 1600,569 1589,578 1590,595 1600,610 1599,636 1583,657 1586,680 1594,688 1602,697 1600,707 1602,715 1610,721 1613,735 1611,761 1602,778 1600,793 1596,806 1590,817 1579,818 1578,802 1573,794 1568,801 1568,814 1569,828 1578,837 1589,849 1594,857 1585,869 1577,874 1582,885 1571,897 1558,908 1552,894 1554,881 1562,871 1556,857 1541,844 1528,838 1507,815 1488,813 1486,805 1504,802 1507,763 1485,737 1483,686 1472,673 1456,670 1456,657 1467,649 1468,628 1486,612 1467,588 1428,585 1417,579 1417,569"/>
    <polygon class="map-region-shape" points="1410,707 1418,691 1456,688 1467,697 1461,700 1463,714 1458,725 1448,733 1422,728 1407,711"/>
  </g>

  <g class="map-region" id="map-region-misthalin" style="--rc:#717d7e" data-region-id="misthalin" data-catalogue-id="MISTHALIN" data-region-name="Misthalin">
    <polygon class="map-region-shape" points="1598,670 1599,655 1608,645 1616,640 1616,606 1602,590 1602,580 1613,568 1626,558 1639,566 1649,577 1654,586 1664,582 1680,580 1694,581 1711,559 1727,560 1746,579 1785,579 1804,561 1812,564 1832,587 1892,587 1905,595 1917,597 1917,607 1903,609 1872,637 1871,679 1866,689 1851,700 1847,707 1854,721 1859,727 1852,733 1816,730 1801,746 1796,765 1790,773 1789,788 1798,803 1799,817 1785,831 1785,849 1774,855 1772,825 1760,824 1760,853 1737,878 1699,881 1679,864 1676,830 1658,814 1656,837 1668,848 1668,863 1654,869 1637,869 1627,858 1632,842 1643,838 1642,813 1626,803 1613,797 1612,782 1624,766 1623,726 1612,714 1614,687 1600,675"/>
    <polygon class="map-region-shape" points="1623,889 1665,888 1683,909 1687,923 1667,941 1628,942 1609,925 1608,903 1622,888"/>
    <polygon class="map-region-shape" points="2089,458 2113,432 2113,416 2104,406 2104,396 2113,389 2126,388 2138,398 2140,417 2133,425 2133,443 2150,459 2169,460 2185,445 2186,432 2204,415 2204,397 2191,381 2170,380 2163,372 2168,355 2183,334 2174,323 2159,318 2145,323 2138,332 2142,345 2153,358 2150,375 2135,379 2124,373 2109,357 2108,330 2120,317 2109,303 2088,303 2070,302 2056,316 2057,336 2072,345 2074,385 2048,414 2047,442 2062,462 2082,465"/>
    <polygon class="map-region-shape" points="876,1036 900,1034 909,1019 925,1019 937,1005 955,1002 966,1018 981,1026 997,1026 1003,1031 1023,1034 1037,1036 1044,1051 1044,1062 1057,1076 1056,1097 1038,1122 1017,1125 1003,1139 1007,1154 1021,1164 1012,1183 991,1182 979,1193 928,1196 904,1175 901,1155 888,1145 875,1145 849,1119 853,1086 856,1082 864,1046"/>
    <polygon class="map-region-shape" points="879,1009 893,1000 907,1013 900,1023 890,1028 879,1020"/>
  </g>

  <g class="map-region" id="map-region-desert" style="--rc:#d4a017" data-region-id="desert" data-catalogue-id="KHARIDIAN_DESERT" data-region-name="Kharidian Desert">
    <polygon class="map-region-shape" points="1827,745 1875,748 1896,763 1899,854 1925,889 1941,890 1966,915 1968,993 1985,1006 1993,1021 1982,1032 1963,1035 1952,1048 1949,1089 1932,1109 1914,1113 1905,1121 1904,1137 1886,1155 1875,1156 1867,1168 1865,1179 1848,1196 1837,1206 1816,1208 1804,1218 1789,1212 1783,1201 1782,1157 1772,1146 1772,1132 1764,1125 1757,1130 1758,1147 1760,1159 1773,1163 1775,1179 1770,1200 1754,1212 1748,1225 1739,1236 1736,1214 1727,1210 1702,1183 1693,1176 1693,1163 1672,1159 1671,1150 1679,1141 1696,1142 1698,1129 1681,1119 1683,1059 1690,1046 1691,1016 1682,1007 1682,992 1693,986 1696,975 1695,961 1706,950 1719,949 1726,944 1728,922 1733,908 1744,899 1779,894 1787,886 1785,878 1802,863 1802,846 1819,830 1817,811 1805,797 1800,784 1809,774 1813,759 1825,746"/>
  </g>

  <g class="map-region" id="map-region-wilderness" style="--rc:#229954" data-region-id="wilderness" data-catalogue-id="WILDERNESS" data-region-name="Wilderness">
    <polygon class="map-region-shape" points="1609,395 1607,350 1638,320 1638,260 1644,251 1679,250 1687,244 1726,243 1733,256 1744,261 1756,256 1763,244 1799,243 1817,259 1819,271 1829,281 1833,296 1845,284 1837,275 1835,247 1855,225 1888,227 1902,243 1905,268 1886,292 1860,294 1842,311 1841,321 1850,330 1850,342 1840,357 1857,379 1868,393 1868,444 1855,457 1855,466 1866,477 1869,493 1858,508 1844,519 1853,537 1865,547 1895,548 1899,560 1894,571 1861,574 1839,574 1824,559 1812,550 1799,552 1791,560 1774,566 1753,566 1733,546 1709,546 1692,559 1671,566 1660,563 1642,546 1621,543 1609,539 1594,521 1594,501 1580,490 1578,441 1591,431 1591,414 1606,398"/>
  </g>

  <g class="map-region" id="map-region-morytania" style="--rc:#6c3483" data-region-id="morytania" data-catalogue-id="MORYTANIA" data-region-name="Morytania">
    <polygon class="map-region-shape" points="1918,614 1919,564 1908,559 1909,522 1945,523 1952,531 1953,545 1972,565 1985,557 2001,553 2010,554 2021,565 2030,574 2059,575 2067,570 2073,561 2071,551 2080,547 2086,557 2087,568 2096,574 2108,585 2116,596 2115,576 2114,567 2123,561 2128,573 2137,575 2127,583 2128,592 2136,594 2147,597 2145,605 2130,611 2116,607 2117,615 2130,630 2131,649 2110,672 2099,671 2092,665 2082,665 2074,667 2071,674 2075,687 2095,689 2114,685 2126,678 2136,682 2151,698 2152,733 2138,748 2121,750 2113,753 2113,767 2127,775 2133,782 2134,802 2100,837 1998,839 1995,853 1987,855 1983,846 1983,833 1971,827 1959,812 1924,816 1907,798 1907,705 1891,689 1892,631 1915,614"/>
    <polygon class="map-region-shape" points="2245,586 2222,588 2216,573 2217,553 2227,549 2239,554 2247,560 2261,559 2271,555 2276,542 2286,545 2296,555 2291,565 2281,571 2280,584 2269,590 2257,589 2257,597 2268,598 2273,607 2270,614 2253,619 2238,619 2229,613 2228,602 2235,594 2247,593"/>
    <polygon class="map-region-shape" points="2086,1042 2085,1007 2077,1007 2064,994 2061,942 2083,919 2146,917 2157,929 2164,931 2172,922 2188,918 2205,933 2208,951 2190,968 2161,968 2149,976 2155,985 2182,989 2188,981 2200,982 2194,995 2177,1005 2134,1008 2129,1007 2125,1000 2123,994 2125,963 2114,968 2114,996 2105,1006 2097,1009 2097,1018 2108,1021 2119,1025 2119,1033 2111,1033 2100,1033 2095,1044 2087,1047"/>
    <polygon class="map-region-shape" points="2152,1120 2158,1114 2165,1108 2169,1101 2171,1092 2167,1083 2163,1077 2160,1072 2160,1066 2162,1061 2166,1058 2176,1053 2182,1052 2192,1059 2195,1065 2203,1069 2210,1070 2219,1063 2222,1058 2230,1054 2235,1056 2240,1062 2245,1068 2248,1071 2247,1081 2244,1083 2238,1090 2235,1096 2242,1104 2245,1107 2248,1119 2246,1130 2241,1138 2235,1145 2225,1147 2216,1141 2211,1142 2204,1142 2201,1143 2194,1148 2186,1150 2179,1151 2174,1149 2170,1140 2164,1132 2159,1128 2150,1124"/>
  </g>

  <g id="banner-layer" pointer-events="none">
  <!-- Varlamore centroid: 421,944 -->
  <image href="assets/banners/Varlamore_Banner.png"
         x="371" y="884" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Great Kourend centroid: 486,510 -->
  <image href="assets/banners/Great_Kourend_Banner.png"
         x="446" y="460" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Fremennik Province centroid: 1306,467 -->
  <image href="assets/banners/Fremennik_Province_Banner.png"
         x="1266" y="417" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Tirannwn centroid: 978,809 -->
  <image href="assets/banners/Tirannwn_Banner.png"
         x="938" y="759" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Kandarin centroid: 1196,761 -->
  <image href="assets/banners/Kandarin_Banner.png"
         x="1166" y="711" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Karamja centroid: 1453,974 -->
  <image href="assets/banners/Karamja_Banner.png"
         x="1413" y="924" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Asgarnia centroid: 1516,584 -->
  <image href="assets/banners/Asgarnia_Banner.png"
         x="1496" y="534" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Misthalin centroid: 1730,700 -->
  <image href="assets/banners/Misthalin_Banner.png"
         x="1690" y="650" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Kharidian Desert centroid: 1826,1007 -->
  <image href="assets/banners/Kharidian_Desert_Banner.png"
         x="1786" y="957" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Wilderness centroid: 1739,407 -->
  <image href="assets/banners/Wilderness_Banner.png"
         x="1699" y="357" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Morytania centroid: 2016,694 -->
  <image href="assets/banners/Morytania_Banner.png"
         x="1976" y="644" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Sunset Ocean centroid: 320,1236 -->
  <image href="assets/banners/Sunset_Ocean_icon_detail.png"
         x="250" y="1300" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Forgotten Ocean centroid: 235,404 -->
  <image href="assets/banners/Forgotten_Ocean_icon_detail.png"
         x="150" y="200" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Western Ocean centroid: 651,660 -->
  <image href="assets/banners/Western_Ocean_icon_detail.png"
         x="790" y="610" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Northern Ocean centroid: 1172,342 -->
  <image href="assets/banners/Northern_Ocean_icon_detail.png"
         x="1300" y="200" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Shrouded Ocean centroid: 961,1242 -->
  <image href="assets/banners/Shrouded_Ocean_icon_detail.png"
         x="921" y="1300" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Ardent Ocean centroid: 1514,953 -->
  <image href="assets/banners/Ardent_Ocean_icon_detail.png"
         x="1580" y="970" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Unquiet Ocean centroid: 1537,1412 -->
  <image href="assets/banners/Unquiet_Ocean_icon_detail.png"
         x="1497" y="1362" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Eastern Ocean centroid: 2114,1043 -->
  <image href="assets/banners/Eastern_Ocean_icon_detail.png"
         x="2074" y="1300" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Untamed Ocean centroid: 2039,306 -->
  <image href="assets/banners/Untamed_Ocean_icon_detail.png"
         x="1930" y="300" width="80" height="100"
         preserveAspectRatio="xMidYMid meet"/>
</g>
</svg>`;

function renderRegionsTab(container) {
  container.innerHTML = `
    <div class="region-map-layout">
      <div class="region-map-svg-container">
        ${REGION_MAP_SVG}
        <div class="region-hover-label">
          <span class="region-hover-label-text" id="region-hover-label-text"></span>
        </div>
      </div>
      <div class="region-info-panel" id="region-info-panel">
        <div class="region-info-empty" id="region-info-empty">
          Click a region to view details
        </div>
        <div id="region-info-content" style="display:none">
          <div class="region-info-accent" id="region-info-accent"></div>
          <h3 class="region-info-name" id="region-info-name"></h3>
          <div class="region-info-pills" id="region-info-pills"></div>
          <div class="region-info-cost-row">
            <div>
              <div class="region-info-stat-label">Unlock cost</div>
              <div class="region-info-cost-value" id="region-info-cost">—</div>
            </div>
            <div style="text-align:right">
              <div class="region-info-stat-label">Available</div>
              <div class="region-info-stat-value" id="region-info-points">—</div>
            </div>
          </div>
          <button class="region-info-btn" id="region-info-btn">Unlock Region</button>
          <div class="region-info-tabs">
            <div class="region-info-tab active" onclick="switchRegionTab(this,'overview')">Overview</div>
            <div class="region-info-tab" onclick="switchRegionTab(this,'content')">Content</div>
            <div class="region-info-tab" onclick="switchRegionTab(this,'unlocks')">Unlocks</div>
          </div>
          <div class="region-info-tab-body" id="region-tab-overview"></div>
          <div class="region-info-tab-body" id="region-tab-content" style="display:none"></div>
          <div class="region-info-tab-body" id="region-tab-unlocks" style="display:none"></div>
        </div>
      </div>
    </div>
  `;
  initRegionMap();
}

// Attaches hover/click handlers and sets initial unlocked state for all
// map regions after the SVG is injected into the DOM.
function initRegionMap() {
  buildWaterMask();
  // Land regions
  document.querySelectorAll(".map-region").forEach((el) => {
    const catalogueId = el.dataset.catalogueId;
    if (globalOwnedRegionIds.has(catalogueId)) {
      el.classList.add("unlocked");
    }
    el.addEventListener("click", () => showRegionInfo(el));
  });

  // Ocean regions — same logic, different class
  document.querySelectorAll(".map-ocean").forEach((el) => {
    const catalogueId = el.dataset.catalogueId;
    if (globalOwnedRegionIds.has(catalogueId)) {
      el.classList.add("unlocked");
    }
    el.addEventListener("click", () => showRegionInfo(el));
  });

  document.querySelectorAll(".map-region, .map-ocean").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      const label = document.getElementById("region-hover-label-text");
      if (label) {
        label.textContent = el.dataset.regionName;
        label.classList.add("visible");
      }
    });

    el.addEventListener("mouseleave", () => {
      const label = document.getElementById("region-hover-label-text");
      if (label) label.classList.remove("visible");
    });
  });
}

// Updates unlocked state on all currently rendered map regions,
// called after a purchase arrives without needing a full re-render.
function updateRegionMapState() {
  document.querySelectorAll(".map-region, .map-ocean").forEach((el) => {
    const catalogueId = el.dataset.catalogueId;
    el.classList.toggle("unlocked", globalOwnedRegionIds.has(catalogueId));
  });
}

function showRegionInfo(el) {
  const catalogueId = el.dataset.catalogueId;
  const name = el.dataset.regionName;
  const unlocked = el.classList.contains("unlocked");
  const rc = el.style.getPropertyValue("--rc").trim();

  const entry = globalUnlockCatalogue.find((u) => u.id === catalogueId);
  const cost = entry ? entry.cost : 0;
  const canAfford = globalAvailablePoints >= cost;
  const info = globalRegionInfo[catalogueId] || {};

  const taskDist = getRegionTaskDistribution(catalogueId);
  const hasTasks = Object.keys(taskDist).length > 0;

  document.getElementById("region-info-empty").style.display = "none";
  const content = document.getElementById("region-info-content");
  content.style.display = "block";
  content.style.setProperty("--rc", rc); // drives active tab colour

  document.getElementById("region-info-accent").style.background = rc;
  document.getElementById("region-info-name").textContent = name;
  document.getElementById("region-info-cost").textContent =
    cost > 0 ? cost.toLocaleString() + " pts" : "Starting region";
  document.getElementById("region-info-points").textContent = globalAvailablePoints.toLocaleString() + " pts";

  // Quick stat pills
  const pills = [];
  if (hasTasks) {
    const totalTasks = Object.values(taskDist).reduce((s, t) => s + t.count, 0);
    const totalPts = Object.values(taskDist).reduce((s, t) => s + t.points, 0);
    pills.push(`${totalTasks} tasks`);
    pills.push(`${Math.round(totalPts / 1000)}k pts`);
  }
  if (sectionCount(info.quests)) pills.push(`${sectionCount(info.quests)} quests`);
  if (sectionCount(info.bosses)) pills.push(`${sectionCount(info.bosses)} bosses`);
  document.getElementById("region-info-pills").innerHTML = pills
    .map((p) => `<span class="region-info-pill">${p}</span>`)
    .join("");

  // Unlock button
  const btn = document.getElementById("region-info-btn");
  btn.style.cssText = "";
  btn.className = "region-info-btn";
  btn.onclick = null;
  if (unlocked) {
    btn.textContent = "✓ Already Unlocked";
    btn.disabled = true;
    btn.classList.add("is-unlocked");
    btn.style.setProperty("--rc", rc);
  } else if (!canAfford) {
    btn.textContent = "Cannot afford — " + cost.toLocaleString() + " pts needed";
    btn.disabled = true;
    btn.classList.add("is-unaffordable");
  } else {
    btn.textContent = "Unlock " + name;
    btn.disabled = false;
    btn.style.background = rc;
    btn.style.color = "#fff";
    btn.onclick = () => sendPurchaseUnlock(catalogueId);
  }

  // Reset to overview tab
  const firstTab = document.querySelector(".region-info-tab");
  if (firstTab) switchRegionTab(firstTab, "overview");

  // Overview tab
  const ov = [];
  if (hasTasks) ov.push(buildDistributionBar(taskDist));
  if (sectionCount(info.settlements)) ov.push(buildTagSection("Settlements", info.settlements));
  if (sectionCount(info.quests)) ov.push(buildTagSection("Completable quests", info.quests, "quest"));
  if (sectionCount(info.npcs)) ov.push(buildTagSection("Notable NPCs", info.npcs));
  if (!ov.length) ov.push('<p class="region-info-placeholder">No overview data available yet.</p>');
  document.getElementById("region-tab-overview").innerHTML = ov.join("");

  // Content tab
  const ct = [];
  if (sectionCount(info.bosses)) ct.push(buildTagSection("Bosses", info.bosses, "boss"));
  if (sectionCount(info.skilling)) ct.push(buildTagSection("Skilling activities", info.skilling, "skill"));
  if (sectionCount(info.drops)) ct.push(buildTagSection("Notable drops", info.drops));
  if (!ct.length) ct.push('<p class="region-info-placeholder">No content data available yet.</p>');
  document.getElementById("region-tab-content").innerHTML = ct.join("");

  // Unlocks tab
  const ul = [];
  if (sectionCount(info.shops)) ul.push(buildTagSection("Shops & guilds", info.shops));
  if (sectionCount(info.unlocks)) ul.push(buildTagSection("Notable unlocks", info.unlocks));
  if (!ul.length) ul.push('<p class="region-info-placeholder">No unlock data available yet.</p>');
  document.getElementById("region-tab-unlocks").innerHTML = ul.join("");
}

function switchRegionTab(el, tabId) {
  document.querySelectorAll(".region-info-tab").forEach((t) => t.classList.remove("active"));
  if (el) el.classList.add("active");
  ["overview", "content", "unlocks"].forEach((id) => {
    const body = document.getElementById("region-tab-" + id);
    if (body) body.style.display = id === tabId ? "block" : "none";
  });
}

function buildWikiUrl(name) {
  return "https://oldschool.runescape.wiki/w/" + name.trim().replace(/ /g, "_");
}

function sectionCount(section) {
  if (!section) return 0;
  if (Array.isArray(section)) return section.length;
  return section.items ? section.items.length : 0;
}

function buildTagSection(title, sectionData, tagClass) {
  // Support both legacy plain arrays and new { wikiLinks, items } format
  let items, wikiLinks;
  if (Array.isArray(sectionData)) {
    items = sectionData;
    wikiLinks = false;
  } else {
    items = sectionData.items || [];
    wikiLinks = sectionData.wikiLinks !== false;
  }

  if (!items.length) return "";

  const cls = tagClass ? ` ${tagClass}` : "";

  const tags = items
    .map((item) => {
      const name = typeof item === "string" ? item : item.name;
      const hasUrlOverride = typeof item === "object" && item.hasOwnProperty("url");
      const url = hasUrlOverride ? item.url : wikiLinks ? buildWikiUrl(name) : null;

      if (url) {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer"
                 class="region-tag${cls} wiki-link">${name}</a>`;
      }
      return `<span class="region-tag${cls}">${name}</span>`;
    })
    .join("");

  return `<div class="region-info-section">
    <div class="region-info-section-label">${title}</div>
    <div class="region-tag-list">${tags}</div>
  </div>`;
}

function getRegionTaskDistribution(catalogueId) {
  const tierOrder = ["EASY", "MEDIUM", "HARD", "ELITE", "MASTER"];
  const result = {};
  tierOrder.forEach((tier) => {
    const count = globalTaskList.filter((t) => t.region === catalogueId && t.tier === tier).length;
    if (count > 0) {
      const key = tier.charAt(0) + tier.slice(1).toLowerCase();
      result[key] = { count, points: count * TIER_POINTS[tier] };
    }
  });
  return result;
}

function buildDistributionBar(tasks) {
  const tiers = [
    { key: "Easy", color: "#1e8449" },
    { key: "Medium", color: "#2471a3" },
    { key: "Hard", color: "#d4a017" },
    { key: "Elite", color: "#c0395a" },
    { key: "Master", color: "#6c3483" },
  ];
  const total = Object.values(tasks).reduce((s, t) => s + t.count, 0);
  if (!total) return "";

  const segs = tiers
    .filter((t) => tasks[t.key])
    .map((t) => {
      const pct = (tasks[t.key].count / total) * 100;
      const label = pct > 12 ? Math.round(pct) + "%" : "";
      const tip = `${t.key}: ${tasks[t.key].count} tasks · ${tasks[t.key].points.toLocaleString()} pts · ${pct.toFixed(1)}%`;
      return `<div class="region-dist-seg" style="width:${pct}%;background:${t.color}" title="${tip}">${label}</div>`;
    })
    .join("");

  const legend = tiers
    .filter((t) => tasks[t.key])
    .map(
      (t) =>
        `<div class="region-dist-leg-item">
          <span class="region-dist-dot" style="background:${t.color}"></span>
          ${t.key} <strong>${tasks[t.key].count}</strong>
        </div>`,
    )
    .join("");

  return `<div class="region-info-section">
    <div class="region-info-section-label">Task distribution</div>
    <div class="region-dist-bar">${segs}</div>
    <div class="region-dist-legend">${legend}</div>
  </div>`;
}

function closeRegionModal() {
  document.getElementById("region-modal").classList.remove("open");
}

document.addEventListener("DOMContentLoaded", () => {
  // Close region modal on backdrop click
  const regionModal = document.getElementById("region-modal");
  if (regionModal) {
    regionModal.addEventListener("click", (e) => {
      if (e.target === regionModal) closeRegionModal();
    });
  }

  // Close region modal on X button
  const closeBtn = document.getElementById("region-modal-close");
  if (closeBtn) closeBtn.addEventListener("click", closeRegionModal);
});

function buildWaterMask() {
  const svg = document.getElementById("region-map-svg");
  if (!svg) return;
  const ns = "http://www.w3.org/2000/svg";

  // Create <defs> if not already present
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  // Remove any previously built mask so we can rebuild cleanly
  const existing = defs.querySelector("#water-only");
  if (existing) existing.remove();

  const mask = document.createElementNS(ns, "mask");
  mask.setAttribute("id", "water-only");

  // White background — everything starts visible
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", "2400");
  bg.setAttribute("height", "1610");
  bg.setAttribute("fill", "white");
  mask.appendChild(bg);

  // Black land shapes — cut out all land region areas
  document.querySelectorAll(".map-region .map-region-shape").forEach((shape) => {
    const clone = shape.cloneNode(false);
    clone.setAttribute("fill", "black");
    clone.setAttribute("stroke", "none");
    clone.removeAttribute("class");
    mask.appendChild(clone);
  });

  defs.appendChild(mask);

  // Apply mask to the ocean layer group
  const oceanLayer = document.getElementById("ocean-layer");
  if (oceanLayer) oceanLayer.setAttribute("mask", "url(#water-only)");
}
