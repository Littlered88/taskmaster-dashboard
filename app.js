// --- WebSocket Setup ---
const socket = new WebSocket('ws://localhost:7071');

// Global state cache to support filtering
let globalTaskList = [];
let globalCompletedIds = [];
let globalProgress = {};
let globalPinnedIds = [];

socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateDashboard(data);
};

// --- Navigation Logic ---
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        // 1. Remove active class from all nav items and views
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
        document.querySelectorAll('.view-section').forEach(view => view.classList.remove('active'));

        // 2. Add active class to clicked nav item
        const clickedItem = e.currentTarget;
        clickedItem.classList.add('active');

        // 3. Show the corresponding section
        const targetId = clickedItem.getAttribute('data-target');
        document.getElementById(targetId).classList.add('active');
    });
});

// --- Data Management & Rendering ---
function updateDashboard(data) {
    // 1. Cache the global state
    globalTaskList = data.availableTasks || [];
    globalCompletedIds = data.completedTaskIds || [];
    globalProgress = data.currentTaskProgress || {};

    // 2. Update Global Stats
    const availablePoints = data.totalPointsEarned - data.totalPointsSpent;
    document.getElementById('points-earned').innerText = availablePoints.toLocaleString();

    // 3. Update Header Progress Bar
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    progressBar.style.width = data.completionPercentage + '%';
    progressText.innerText = data.completionPercentage.toFixed(1) + '% Complete';

    // 4. Render Tasks
    filterTasks();
}

function renderTasks(availableTasks, completedTaskIds, currentTaskProgress) {
    const list = document.getElementById('task-list');
    list.innerHTML = '';

    availableTasks.forEach(task => {
        try {
            const isCompleted = completedTaskIds.includes(task.id);

            // 1. Pre-calculate progress to determine the container's CSS class
            let progress = (currentTaskProgress && currentTaskProgress[task.id]) || 0;
            let target = task.tracker ? (task.tracker.target || 0) : 0;
            const isTrackable = task.tracker && ['KILL', 'PROCESSING', 'INVENTORY', 'VARBIT', 'EXPERIENCE', "CHAT"].includes(task.tracker.type.toUpperCase());

            const isInProgress = !isCompleted && isTrackable && progress > 0 && target > 1;

            // 2. Apply the correct status class
            const item = document.createElement('div');
            let statusClass = '';
            if (isCompleted) statusClass = 'completed';
            else if (isInProgress) statusClass = 'in-progress';

            item.className = `task-item ${statusClass}`;

            // 3. Format Strings
            const tierLower = task.tier ? task.tier.toLowerCase() : 'unknown';
            const tierFormatted = task.tier ? task.tier.charAt(0).toUpperCase() + task.tier.slice(1).toLowerCase() : 'Unknown';
            const tierClass = `tier-${tierLower}`;
            const rawRegion = task.region || 'GLOBAL';
            const region = rawRegion.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');

            // --- ICON RESOLUTION LOGIC ---
            let iconUrl = 'https://static.runelite.net/cache/item/icon/23814.png'; // 1. Default (Scroll)

            // 2. Explicit JSON Override (Highest Priority)
            if (task.icon) {
                if (typeof task.icon === 'string') {
                    // If it's a string (e.g., "AGILITY"), point to your local assets folder
                    iconUrl = `./assets/skills/${task.icon}.png`;
                } else if (typeof task.icon === 'number') {
                    // If it's a number (e.g., 13069), fetch the exact item from RuneLite
                    iconUrl = `https://static.runelite.net/cache/item/icon/${task.icon}.png`;
                }
            }
            // 3. Safe Fallback to tracker.ids (Only for Item-based tasks!)
            else if (task.tracker && task.tracker.ids && task.tracker.ids.length > 0) {
                // Whitelist ONLY the tracker types where the IDs explicitly represent Items
                const safeItemTrackers = ['EQUIPMENT', 'INVENTORY', 'PROCESSING'];

                if (safeItemTrackers.includes(task.tracker.type.toUpperCase())) {
                    iconUrl = `https://static.runelite.net/cache/item/icon/${task.tracker.ids[0]}.png`;
                }
            }

            let progressBarHTML = '';

            if (task.tracker && ['KILL', 'PROCESSING', 'INVENTORY', 'VARBIT', 'EXPERIENCE', "CHAT"].includes(task.tracker.type.toUpperCase())) {
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

            const isPinned = globalPinnedIds.includes(task.id);
            const pinClass = isPinned ? 'pinned' : '';
            const pinIcon = isPinned ? '🔒' : '🔓'; // Dynamically swap the padlock

            // Attach click event to open the modal
            item.onclick = () => openTaskDetails(task.id);

            item.innerHTML = `
                <div>
                    <div class="task-header">
                        <div class="task-title-group">
                            <img src="${iconUrl}" alt="Task Icon" class="task-icon" onerror="this.src='https://static.runelite.net/cache/item/icon/23814.png'" />
                            <h4>${task.name}</h4>
                        </div>
                        <button class="btn-pin ${pinClass}" onclick="event.stopPropagation(); togglePin(${task.id})" title="${isPinned ? 'Unpin Task' : 'Pin Task'}">${pinIcon}</button>
                    </div>
                    <div class="task-meta">
                        <span class="meta-tag">${region}</span>
                        <span class="meta-tag ${tierClass}">${tierFormatted}</span> </div>
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
    const searchTerm = document.getElementById('task-search').value.toLowerCase();
    const regionFilter = document.getElementById('region-filter').value;
    const tierFilter = document.getElementById('tier-filter').value;
    const statusFilter = document.getElementById('status-filter').value;
    const sortOrder = document.getElementById('sort-filter').value;

    // 1. Filter the cached global list
    let filtered = globalTaskList.filter(task => {
        // ALWAYS return pinned tasks, bypassing all filters
        if (globalPinnedIds.includes(task.id)) return true;

        const matchesSearch = task.name.toLowerCase().includes(searchTerm) || (task.description && task.description.toLowerCase().includes(searchTerm));
        const taskRegion = (task.region || 'GLOBAL').toUpperCase();
        const matchesRegion = regionFilter === 'ALL' || taskRegion === regionFilter;
        const taskTier = (task.tier || 'UNKNOWN').toUpperCase();
        const matchesTier = tierFilter === 'ALL' || taskTier === tierFilter;

        const isCompleted = globalCompletedIds.includes(task.id);
        let matchesStatus = true;

        if (statusFilter === 'COMPLETED') {
            matchesStatus = isCompleted;
        } else if (statusFilter === 'INCOMPLETE') {
            matchesStatus = !isCompleted;
        } else if (statusFilter === 'IN-PROGRESS') {
            let progress = (globalProgress && globalProgress[task.id]) || 0;
            let target = task.tracker ? (task.tracker.target || 0) : 0;
            const isTrackable = task.tracker && ['KILL', 'PROCESSING', 'INVENTORY', 'VARBIT', 'EXPERIENCE', "CHAT"].includes(task.tracker.type.toUpperCase());
            matchesStatus = !isCompleted && isTrackable && progress > 0 && target > 1;
        }

        return matchesSearch && matchesRegion && matchesTier && matchesStatus;
    });

    // 2. Sort the remaining filtered list
    const tierWeights = { "EASY": 1, "MEDIUM": 2, "HARD": 3, "ELITE": 4, "MASTER": 5, "UNKNOWN": 0 };

    filtered.sort((a, b) => {
        // Force pinned tasks to the very top
        const aPinned = globalPinnedIds.includes(a.id);
        const bPinned = globalPinnedIds.includes(b.id);
        if (aPinned && !bPinned) return -1;
        if (!aPinned && bPinned) return 1;

        if (sortOrder === 'TIER_ASC') {
            return (tierWeights[(a.tier || 'UNKNOWN').toUpperCase()] || 0) - (tierWeights[(b.tier || 'UNKNOWN').toUpperCase()] || 0);
        } else if (sortOrder === 'TIER_DESC') {
            return (tierWeights[(b.tier || 'UNKNOWN').toUpperCase()] || 0) - (tierWeights[(a.tier || 'UNKNOWN').toUpperCase()] || 0);
        } else if (sortOrder === 'AZ') {
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
    document.getElementById('task-search').value = '';
    document.getElementById('region-filter').value = 'ALL';
    document.getElementById('tier-filter').value = 'ALL';
    document.getElementById('status-filter').value = 'ALL';
    document.getElementById('sort-filter').value = 'DEFAULT';

    // Re-run the filter logic to update the dashboard
    filterTasks();
}

// --- Send data back to the Plugin ---
function sendCompleteTask(taskId) {
    const payload = {
        action: "COMPLETE_TASK",
        taskId: taskId
    };

    if(socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

// --- Pinning Logic ---
function togglePin(taskId) {
    if (globalPinnedIds.includes(taskId)) {
        globalPinnedIds = globalPinnedIds.filter(id => id !== taskId);
    } else {
        globalPinnedIds.push(taskId);
    }
    filterTasks(); // Instantly refresh the UI
}

// --- Modal Logic ---
function openTaskDetails(taskId) {
    // Find the specific task data
    const task = globalTaskList.find(t => t.id === taskId);
    if (!task) return;

    const isCompleted = globalCompletedIds.includes(task.id);
    const tier = task.tier ? task.tier.charAt(0).toUpperCase() + task.tier.slice(1).toLowerCase() : 'Unknown';
    const rawRegion = task.region || 'GLOBAL';
    const region = rawRegion.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');

    // Set Text
    document.getElementById('modal-title').innerText = task.name;
    document.getElementById('modal-desc').innerText = task.description;
    document.getElementById('modal-region').innerText = region;
    document.getElementById('modal-tier').innerText = tier;

    // Resolve Icon (re-using your existing logic pattern)
    let iconUrl = 'https://static.runelite.net/cache/item/icon/23814.png';
    if (task.icon) {
        if (typeof task.icon === 'string') iconUrl = `./assets/skills/${task.icon}.png`;
        else if (typeof task.icon === 'number') iconUrl = `https://static.runelite.net/cache/item/icon/${task.icon}.png`;
    } else if (task.tracker && task.tracker.ids && task.tracker.ids.length > 0) {
        const safeItemTrackers = ['EQUIPMENT', 'INVENTORY', 'PROCESSING'];
        if (safeItemTrackers.includes(task.tracker.type.toUpperCase())) iconUrl = `https://static.runelite.net/cache/item/icon/${task.tracker.ids[0]}.png`;
    }
    const modalIcon = document.getElementById('modal-icon');
    modalIcon.src = iconUrl;
    modalIcon.onerror = () => modalIcon.src = 'https://static.runelite.net/cache/item/icon/23814.png';

    // Set Button (Only show if incomplete)
    const footer = document.getElementById('modal-footer');
    if (isCompleted) {
        footer.innerHTML = `<button class="btn-action" style="background: transparent; border: 1px solid var(--accent-green); color: var(--accent-green); cursor: default;">✓ Completed</button>`;
    } else {
        footer.innerHTML = `<button class="btn-action" onclick="sendCompleteTask(${task.id}); closeTaskDetails()">Mark Complete</button>`;
    }

    // Show Modal
    document.getElementById('task-modal').classList.add('active');
}

function closeTaskDetails(event) {
    // If an event is passed, ensure we only close if the dark overlay background was clicked, not the inner modal
    if (event && event.target.id !== 'task-modal') return;
    document.getElementById('task-modal').classList.remove('active');
}