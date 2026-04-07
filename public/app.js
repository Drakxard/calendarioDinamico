const DAY_EXPORT_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Mi\u00E9rcoles",
  "Jueves",
  "Viernes",
  "S\u00E1bado"
];
const FALLBACK_COLORS = [
  { background: "#1f97d4", accent: "#1294d8" },
  { background: "#e57b72", accent: "#d55a52" },
  { background: "#7885cb", accent: "#6270c7" },
  { background: "#ff5b1e", accent: "#f24d11" },
  { background: "#6d6d6d", accent: "#5d5d5d" }
];
const GOOGLE_COLORS = {
  "1": { background: "#7986cb", accent: "#5c6bc0" },
  "2": { background: "#33b679", accent: "#0f9d58" },
  "3": { background: "#8e24aa", accent: "#7b1fa2" },
  "4": { background: "#e67c73", accent: "#d93025" },
  "5": { background: "#f6bf26", accent: "#f9ab00" },
  "6": { background: "#f4511e", accent: "#ff5a1f" },
  "7": { background: "#039be5", accent: "#039be5" },
  "8": { background: "#616161", accent: "#5f6368" },
  "9": { background: "#3f51b5", accent: "#3949ab" },
  "10": { background: "#0b8043", accent: "#188038" },
  "11": { background: "#d50000", accent: "#c5221f" }
};

const state = {
  offset: 0,
  isLoading: false,
  weekData: null,
  isAuthenticated: false,
  isConfigured: true,
  previewWeekData: null,
  previewTemplate: null,
  isApplyingTemplate: false,
  isClearingTemplate: false
};
let currentTimeIndicatorInterval = null;
let previewPasteShortcutArmed = false;
let previewPasteShortcutTimer = null;

const headerDays = document.getElementById("header-days");
const rangeTitle = document.getElementById("range-title");
const timezoneLabel = document.getElementById("timezone-label");
const allDayGrid = document.getElementById("all-day-grid");
const allDayBand = document.getElementById("all-day-band");
const calendarGrid = document.getElementById("calendar-grid");
const summaryBoard = document.getElementById("summary-board");
const summaryGrid = document.getElementById("summary-grid");
const previousWeekButton = document.getElementById("previous-week");
const nextWeekButton = document.getElementById("next-week");
const connectGoogleLink = document.getElementById("connect-google");
const clearTemplateButton = document.getElementById("clear-template");
const logoutButton = document.getElementById("logout-button");
const copyJsonButton = document.getElementById("copy-json");
const authGroup = document.getElementById("auth-group");
const statusBanner = document.getElementById("status-banner");
const previewModal = document.getElementById("preview-modal");
const previewMessage = document.getElementById("preview-message");
const previewHeaderDays = document.getElementById("preview-header-days");
const previewTimezoneLabel = document.getElementById("preview-timezone-label");
const previewCalendarGrid = document.getElementById("preview-calendar-grid");
const previewSummaryBoard = document.getElementById("preview-summary-board");
const previewSummaryGrid = document.getElementById("preview-summary-grid");
const previewCloseButton = document.getElementById("preview-close");
const previewCancelButton = document.getElementById("preview-cancel");
const previewConfirmButton = document.getElementById("preview-confirm");
const hourLabelTemplate = document.getElementById("hour-label-template");
const gridColumnTemplate = document.getElementById("grid-column-template");

const mainView = {
  headerDays,
  rangeTitle,
  timezoneLabel,
  allDayBand,
  allDayGrid,
  calendarGrid,
  summaryBoard,
  summaryGrid
};
const previewView = {
  headerDays: previewHeaderDays,
  rangeTitle: document.getElementById("preview-title"),
  timezoneLabel: previewTimezoneLabel,
  allDayBand: null,
  allDayGrid: null,
  calendarGrid: previewCalendarGrid,
  summaryBoard: previewSummaryBoard,
  summaryGrid: previewSummaryGrid
};

previousWeekButton.addEventListener("click", () => changeWeek(-1));
nextWeekButton.addEventListener("click", () => changeWeek(1));
logoutButton.addEventListener("click", logout);
clearTemplateButton.addEventListener("click", clearManagedTemplate);
copyJsonButton.addEventListener("click", copyCurrentWeekJson);
previewCloseButton.addEventListener("click", () => closePreviewModal());
previewCancelButton.addEventListener("click", () => closePreviewModal());
previewConfirmButton.addEventListener("click", confirmPreviewTemplate);
document.addEventListener("paste", handlePaste);
document.addEventListener("keydown", handleKeydown);

boot();

async function boot() {
  ensureCurrentTimeIndicatorInterval();
  showBannerFromQuery();
  await loadAuthStatus();

  if (!state.isConfigured) {
    return;
  }

  if (state.isAuthenticated) {
    await loadWeek();
    return;
  }

  renderUnauthenticatedState();
}

async function changeWeek(direction) {
  if (state.isLoading || !state.isAuthenticated) {
    return;
  }

  state.offset += direction;
  await loadWeek();
}

async function loadAuthStatus() {
  try {
    const response = await fetch("/api/auth/status");
    const payload = await response.json();

    state.isAuthenticated = Boolean(payload.authenticated);
    state.isConfigured = payload.configured !== false;

    updateButtons();
    updateAuthControls();

    if (!response.ok) {
      renderError(payload.error || "La configuracion OAuth no es valida.");
    }
  } catch (_error) {
    state.isAuthenticated = false;
    state.isConfigured = false;
    updateButtons();
    updateAuthControls();
    renderError("No se pudo comprobar el estado de autenticacion.");
  }
}

async function loadWeek() {
  state.isLoading = true;
  updateButtons();
  updateAuthControls();
  renderGridLoading(mainView.calendarGrid, "Cargando semana...");
  hideSummary(mainView);

  try {
    const response = await fetch(`/api/week-events?offset=${state.offset}`);
    const payload = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        state.isAuthenticated = false;
        state.weekData = null;
        closePreviewModal(true);
        updateButtons();
        updateAuthControls();
        renderUnauthenticatedState(
          payload.error || "Necesitas volver a conectar Google Calendar."
        );
        return;
      }

      throw new Error(payload.error || "No se pudieron cargar los eventos.");
    }

    state.weekData = payload;
    renderMainWeek(payload);
  } catch (error) {
    state.weekData = null;
    renderError(error.message);
  } finally {
    state.isLoading = false;
    updateButtons();
    updateAuthControls();
  }
}

async function logout() {
  logoutButton.disabled = true;

  try {
    await fetch("/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });

    closePreviewModal(true);
    state.isAuthenticated = false;
    state.weekData = null;
    state.offset = 0;
    setBanner("Sesion desconectada.", "info");
    renderUnauthenticatedState();
  } catch (_error) {
    setBanner("No se pudo cerrar la sesion.", "error");
  } finally {
    updateButtons();
    updateAuthControls();
  }
}

async function copyCurrentWeekJson() {
  if (!state.weekData) {
    return;
  }

  try {
    const template = buildTemplateFromWeekData(state.weekData);
    await copyTextToClipboard(JSON.stringify(template, null, 2));
    setBanner("JSON semanal copiado al portapapeles.", "info");
  } catch (_error) {
    setBanner("No se pudo copiar el JSON.", "error");
  }
}

function handlePaste(event) {
  if (!state.isAuthenticated || !state.weekData || !previewPasteShortcutArmed) {
    return;
  }

  disarmPreviewPasteShortcut();

  const text = event.clipboardData?.getData("text");
  const result = parseWeeklyTemplateText(text);

  if (!result.matchedJson) {
    return;
  }

  event.preventDefault();

  if (!result.ok) {
    if (isPreviewModalOpen()) {
      setPreviewMessage(result.error, "error");
      return;
    }

    setBanner(result.error, "error");
    return;
  }

  openPreviewModal(result.template);
}

function handleKeydown(event) {
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
    armPreviewPasteShortcut();
  }

  if (event.key === "Escape" && isPreviewModalOpen() && !state.isApplyingTemplate) {
    closePreviewModal();
  }
}

function armPreviewPasteShortcut() {
  previewPasteShortcutArmed = true;

  if (previewPasteShortcutTimer) {
    window.clearTimeout(previewPasteShortcutTimer);
  }

  previewPasteShortcutTimer = window.setTimeout(() => {
    disarmPreviewPasteShortcut();
  }, 1500);
}

function disarmPreviewPasteShortcut() {
  previewPasteShortcutArmed = false;

  if (previewPasteShortcutTimer) {
    window.clearTimeout(previewPasteShortcutTimer);
    previewPasteShortcutTimer = null;
  }
}

async function confirmPreviewTemplate() {
  if (!state.previewTemplate || !state.weekData || state.isApplyingTemplate) {
    return;
  }

  state.isApplyingTemplate = true;
  updateButtons();
  updatePreviewControls();
  clearPreviewMessage();

  try {
    const response = await fetch(
      `/api/week-template/apply?weekStart=${encodeURIComponent(state.weekData.weekStart)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(state.previewTemplate)
      }
    );
    const payload = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        state.isAuthenticated = false;
        state.weekData = null;
        closePreviewModal();
        updateButtons();
        updateAuthControls();
        renderUnauthenticatedState(
          payload.error || "La autorizacion de Google ya no es valida."
        );
        return;
      }

      throw new Error(payload.error || "No se pudo aplicar la semana recurrente.");
    }

    closePreviewModal(true);
    await loadWeek();
    setBanner(
      `Semana recurrente actualizada. Series recreadas: ${payload.createdCount ?? 0}.`,
      "info"
    );
  } catch (error) {
    setPreviewMessage(error.message, "error");
  } finally {
    state.isApplyingTemplate = false;
    updateButtons();
    updateAuthControls();
    updatePreviewControls();
  }
}

async function clearManagedTemplate() {
  if (!state.isAuthenticated || state.isLoading || state.isApplyingTemplate || state.isClearingTemplate) {
    return;
  }

  state.isClearingTemplate = true;
  updateButtons();
  updateAuthControls();

  try {
    const response = await fetch("/api/week-template/clear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const payload = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        state.isAuthenticated = false;
        state.weekData = null;
        closePreviewModal(true);
        updateButtons();
        updateAuthControls();
        renderUnauthenticatedState(
          payload.error || "La autorizacion de Google ya no es valida."
        );
        return;
      }

      throw new Error(payload.error || "No se pudo borrar la carga creada por la app.");
    }

    closePreviewModal(true);
    await loadWeek();
    setBanner(`Series borradas: ${payload.deletedCount ?? 0}.`, "info");
  } catch (error) {
    setBanner(error.message, "error");
  } finally {
    state.isClearingTemplate = false;
    updateButtons();
    updateAuthControls();
    updatePreviewControls();
  }
}

function updateButtons() {
  previousWeekButton.disabled =
    state.isLoading || !state.isAuthenticated || state.isApplyingTemplate || state.isClearingTemplate;
  nextWeekButton.disabled =
    state.isLoading || !state.isAuthenticated || state.isApplyingTemplate || state.isClearingTemplate;
  copyJsonButton.hidden = !state.isAuthenticated;
  copyJsonButton.disabled =
    state.isLoading ||
    state.isApplyingTemplate ||
    state.isClearingTemplate ||
    !state.isAuthenticated ||
    !state.weekData;
  clearTemplateButton.disabled =
    state.isLoading || state.isApplyingTemplate || state.isClearingTemplate || !state.isAuthenticated;
  logoutButton.disabled = state.isLoading || state.isApplyingTemplate || state.isClearingTemplate;
}

function updateAuthControls() {
  authGroup.hidden = !state.isConfigured;
  connectGoogleLink.hidden = state.isAuthenticated;
  clearTemplateButton.hidden = !state.isAuthenticated;
  logoutButton.hidden = !state.isAuthenticated;
}

function updatePreviewControls() {
  previewCancelButton.disabled = state.isApplyingTemplate || state.isClearingTemplate;
  previewCloseButton.disabled = state.isApplyingTemplate || state.isClearingTemplate;
  previewConfirmButton.disabled =
    state.isApplyingTemplate ||
    state.isClearingTemplate ||
    !state.previewTemplate ||
    !state.isAuthenticated;
}

function renderMainWeek(data) {
  clearTransientBanner();
  renderWeekView(mainView, data);
}

function renderWeekView(view, data) {
  renderHeader(view, data);
  renderAllDayBand(view, data);
  renderTimeGrid(view, data);
  renderSummary(view, data);
  renderCurrentTimeIndicatorForView(view, data);
}

function renderHeader(view, data) {
  const start = new Date(`${data.weekStart}T00:00:00`);
  const end = new Date(`${data.weekEnd}T00:00:00`);
  view.rangeTitle.textContent = `${formatMonthLabel(start)} ${start.getDate()} - ${formatMonthLabel(end)} ${end.getDate()}`;
  view.timezoneLabel.textContent = formatTimezoneLabel(data.timezone);

  view.headerDays.innerHTML = "";
  for (const day of data.days) {
    const cell = document.createElement("div");
    cell.className = "header-day";
    if (day.isoDate === data.todayIso) {
      cell.classList.add("is-today");
    }

    cell.innerHTML = `
      <div class="header-day-label">${escapeHtml(day.weekdayLabel)}</div>
      <div class="header-day-number">${day.dayNumber}</div>
    `;
    view.headerDays.appendChild(cell);
  }
}

function renderAllDayBand(view, data) {
  if (!view.allDayGrid || !view.allDayBand) {
    return;
  }

  const rowCount = Math.max(
    data.allDayEvents.length ? Math.max(...data.allDayEvents.map((event) => event.row + 1)) : 0,
    1
  );

  view.allDayBand.hidden = false;
  view.allDayGrid.style.height = `${14 + rowCount * 36}px`;
  view.allDayGrid.innerHTML = "";

  for (const event of data.allDayEvents) {
    const element = document.createElement("div");
    const dayWidth = 100 / data.days.length;
    element.className = "all-day-event";
    element.textContent = event.title;
    element.style.left = `${event.startDayIndex * dayWidth}%`;
    element.style.top = `${7 + event.row * 36}px`;
    element.style.width = `calc(${event.span * dayWidth}% - 6px)`;
    element.style.height = "26px";
    element.style.background = event.color.background;
    view.allDayGrid.appendChild(element);
  }
}

function renderTimeGrid(view, data) {
  const totalHours = data.grid.endHour - data.grid.startHour;
  const totalMinutes = totalHours * 60;
  const pixelsPerMinute = 72 / 60;
  const gridHeight = totalMinutes * pixelsPerMinute;

  view.calendarGrid.innerHTML = "";
  view.calendarGrid.style.minHeight = `${gridHeight}px`;

  const hoursColumn = document.createElement("div");
  hoursColumn.className = "hours-column";
  for (let hour = data.grid.startHour; hour <= data.grid.endHour; hour += 1) {
    const label = hourLabelTemplate.content.firstElementChild.cloneNode(true);
    label.textContent = `${String(hour).padStart(2, "0")}:00`;
    label.style.top = `${(hour - data.grid.startHour) * 72}px`;
    hoursColumn.appendChild(label);
  }
  view.calendarGrid.appendChild(hoursColumn);

  const eventsByDay = groupByDay(data.timedEvents);
  for (const day of data.days) {
    const dayColumn = gridColumnTemplate.content.firstElementChild.cloneNode(true);
    dayColumn.dataset.isoDate = day.isoDate;
    const eventsLayer = dayColumn.querySelector(".events-layer");
    const events = eventsByDay.get(day.index) || [];

    for (const event of events) {
      const card = document.createElement("article");
      const top = (event.startMinutes - data.grid.startHour * 60) * pixelsPerMinute;
      const height = Math.max(event.durationMinutes * pixelsPerMinute, 30);
      const width = 100 / event.columns;
      const left = event.column * width;

      card.className = "event-card";
      card.style.top = `${top}px`;
      card.style.left = `calc(${left}% + 2px)`;
      card.style.width = `calc(${width}% - 4px)`;
      card.style.height = `${height}px`;
      card.style.background = event.color.background;
      card.style.setProperty("--event-accent", event.color.accent);
      card.innerHTML = `
        <span class="event-title">${escapeHtml(event.title)}</span>
        <span class="event-time">${escapeHtml(event.displayTime)}</span>
      `;
      eventsLayer.appendChild(card);
    }

    view.calendarGrid.appendChild(dayColumn);
  }

  if (data.timedEvents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No hay eventos con horario en esta semana.";
    view.calendarGrid.appendChild(empty);
  }
}

function renderSummary(view, data) {
  if (!view.summaryBoard || !view.summaryGrid) {
    return;
  }

  const summaries = buildDailySummaries(data);
  view.summaryBoard.hidden = false;
  view.summaryGrid.innerHTML = "";

  for (const day of data.days) {
    const card = document.createElement("section");
    card.className = "summary-day";
    if (day.isoDate === data.todayIso) {
      card.classList.add("is-today");
    }

    const items = summaries.get(day.index) || [];
    card.innerHTML = `
      <div class="summary-day-header">
        <p class="summary-day-name">${escapeHtml(DAY_EXPORT_NAMES[day.index])}</p>
        <span class="summary-day-date">${day.dayNumber}</span>
      </div>
      <div class="summary-items">
        ${
          items.length > 0
            ? items
                .map(
                  (item) => `
                    <div class="summary-item">
                      <div class="summary-item-title"><span>${escapeHtml(item.title)}</span></div>
                      <span class="summary-item-duration">${formatDuration(item.minutes)}</span>
                    </div>
                  `
                )
                .join("")
            : '<span class="summary-empty">Sin clases</span>'
        }
      </div>
    `;
    view.summaryGrid.appendChild(card);
  }
}

function buildDailySummaries(data) {
  const summaries = new Map();

  for (const event of data.timedEvents) {
    if (!summaries.has(event.dayIndex)) {
      summaries.set(event.dayIndex, new Map());
    }

    const dayMap = summaries.get(event.dayIndex);
    if (!dayMap.has(event.title)) {
      dayMap.set(event.title, { title: event.title, minutes: 0 });
    }

    dayMap.get(event.title).minutes += event.durationMinutes;
  }

  return new Map(
    Array.from(summaries.entries()).map(([dayIndex, subjects]) => [
      dayIndex,
      Array.from(subjects.values()).sort((left, right) => right.minutes - left.minutes)
    ])
  );
}

function ensureCurrentTimeIndicatorInterval() {
  if (currentTimeIndicatorInterval !== null) {
    return;
  }

  currentTimeIndicatorInterval = window.setInterval(() => {
    refreshCurrentTimeIndicators();
  }, 30000);
}

function refreshCurrentTimeIndicators() {
  renderCurrentTimeIndicatorForView(mainView, state.weekData);
  renderCurrentTimeIndicatorForView(previewView, state.previewWeekData);
}

function renderCurrentTimeIndicatorForView(view, data) {
  if (!view.calendarGrid) {
    return;
  }

  view.calendarGrid.querySelectorAll(".current-time-indicator").forEach((node) => node.remove());

  if (!data) {
    return;
  }

  const now = getCurrentTimeParts(data.timezone);
  const currentDayColumn = view.calendarGrid.querySelector(`[data-iso-date="${now.isoDate}"]`);

  if (!currentDayColumn) {
    return;
  }

  const minutesFromStart = now.minutes - data.grid.startHour * 60;
  const gridMinutes = (data.grid.endHour - data.grid.startHour) * 60;

  if (minutesFromStart < 0 || minutesFromStart > gridMinutes) {
    return;
  }

  const indicator = document.createElement("div");
  indicator.className = "current-time-indicator";
  indicator.style.top = `${minutesFromStart * (72 / 60)}px`;
  currentDayColumn.appendChild(indicator);
}

function openPreviewModal(template) {
  if (!state.weekData) {
    return;
  }

  state.previewTemplate = template;
  state.previewWeekData = buildWeekDataFromTemplate(template, state.weekData);
  previewModal.hidden = false;
  document.body.classList.add("modal-open");
  clearPreviewMessage();
  renderWeekView(previewView, state.previewWeekData);
  updatePreviewControls();
}

function closePreviewModal(force = false) {
  if (state.isApplyingTemplate && !force) {
    return;
  }

  state.previewTemplate = null;
  state.previewWeekData = null;
  previewModal.hidden = true;
  document.body.classList.remove("modal-open");
  clearPreviewMessage();
  previewCalendarGrid.innerHTML = "";
  previewSummaryGrid.innerHTML = "";
  previewHeaderDays.innerHTML = "";
  previewTimezoneLabel.textContent = "GMT-03";
}

function isPreviewModalOpen() {
  return !previewModal.hidden;
}

function buildWeekDataFromTemplate(template, baseWeekData) {
  const timedEvents = [];

  DAY_EXPORT_NAMES.forEach((dayName, dayIndex) => {
    const day = baseWeekData.days[dayIndex];
    const blocks = [...template[dayName]].sort(
      (left, right) =>
        timeToMinutes(left.inicio) - timeToMinutes(right.inicio) ||
        timeToMinutes(left.fin) - timeToMinutes(right.fin)
    );

    blocks.forEach((block, blockIndex) => {
      const startMinutes = timeToMinutes(block.inicio);
      const endMinutes = timeToMinutes(block.fin);
      timedEvents.push({
        id: `preview-${day.isoDate}-${blockIndex}`,
        sourceId: `preview-${day.isoDate}-${blockIndex}`,
        title: block.materia,
        colorId: block.colorId || null,
        start: `${day.isoDate}T${block.inicio}:00`,
        end: `${day.isoDate}T${block.fin}:00`,
        dayIndex,
        startMinutes,
        endMinutes,
        durationMinutes: endMinutes - startMinutes,
        displayTime: `${block.inicio} - ${block.fin}`,
        color: getEventColor(block)
      });
    });
  });

  return {
    timezone: baseWeekData.timezone,
    offset: baseWeekData.offset,
    todayIso: baseWeekData.todayIso,
    weekStart: baseWeekData.weekStart,
    weekEnd: baseWeekData.weekEnd,
    days: baseWeekData.days.map((day) => ({ ...day })),
    allDayEvents: [],
    timedEvents: layoutTimedEvents(timedEvents),
    grid: {
      ...baseWeekData.grid
    }
  };
}

function buildTemplateFromWeekData(data) {
  const template = Object.fromEntries(DAY_EXPORT_NAMES.map((day) => [day, []]));
  const grouped = groupByDay(data.timedEvents);

  DAY_EXPORT_NAMES.forEach((dayName, dayIndex) => {
    const events = [...(grouped.get(dayIndex) || [])].sort(
      (left, right) => left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes
    );

    template[dayName] = events.map((event) => ({
      materia: event.title,
      inicio: extractTimeLabelFromIso(event.start),
      fin: extractTimeLabelFromIso(event.end),
      ...(event.colorId ? { colorId: event.colorId } : {})
    }));
  });

  return template;
}

function parseWeeklyTemplateText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return { matchedJson: false, ok: false, error: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_error) {
    return {
      matchedJson: true,
      ok: false,
      error: "El texto pegado no es un JSON valido."
    };
  }

  try {
    return {
      matchedJson: true,
      ok: true,
      template: validateWeeklyTemplateShape(parsed)
    };
  } catch (error) {
    return {
      matchedJson: true,
      ok: false,
      error: error.message
    };
  }
}

function validateWeeklyTemplateShape(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("El JSON semanal debe ser un objeto con dias como claves.");
  }

  const keys = Object.keys(value);
  if (keys.length !== DAY_EXPORT_NAMES.length) {
    throw new Error("El JSON debe incluir exactamente Domingo a Sabado.");
  }

  for (const key of keys) {
    if (!DAY_EXPORT_NAMES.includes(key)) {
      throw new Error(`La clave "${key}" no es un dia valido.`);
    }
  }

  const normalized = {};
  DAY_EXPORT_NAMES.forEach((dayName) => {
    if (!Object.prototype.hasOwnProperty.call(value, dayName)) {
      throw new Error(`Falta la clave "${dayName}".`);
    }

    const blocks = value[dayName];
    if (!Array.isArray(blocks)) {
      throw new Error(`"${dayName}" debe ser un arreglo de bloques.`);
    }

    normalized[dayName] = blocks.map((block, blockIndex) =>
      normalizeTemplateBlock(block, dayName, blockIndex)
    );
  });

  return normalized;
}

function normalizeTemplateBlock(block, dayName, blockIndex) {
  if (!block || Array.isArray(block) || typeof block !== "object") {
    throw new Error(`El bloque ${blockIndex + 1} de ${dayName} no es valido.`);
  }

  const materia = String(block.materia || "").trim();
  const inicio = String(block.inicio || "").trim();
  const fin = String(block.fin || "").trim();
  const colorId =
    block.colorId === undefined || block.colorId === null || String(block.colorId).trim() === ""
      ? null
      : String(block.colorId).trim();

  if (!materia) {
    throw new Error(`El bloque ${blockIndex + 1} de ${dayName} necesita "materia".`);
  }

  if (!isValidTimeLabel(inicio) || !isValidTimeLabel(fin)) {
    throw new Error(`El bloque ${blockIndex + 1} de ${dayName} debe usar horario HH:mm.`);
  }

  if (timeToMinutes(fin) <= timeToMinutes(inicio)) {
    throw new Error(`El bloque ${blockIndex + 1} de ${dayName} debe terminar despues de empezar.`);
  }

  return {
    materia,
    inicio,
    fin,
    colorId
  };
}

function renderError(message) {
  resetMainView();
  rangeTitle.textContent = "Calendario semanal";
  timezoneLabel.textContent = "GMT-03";
  calendarGrid.innerHTML = `<div class="error-state">${escapeHtml(message)}</div>`;
  hideSummary(mainView);
}

function renderUnauthenticatedState(message) {
  resetMainView();
  rangeTitle.textContent = "Calendario semanal";
  timezoneLabel.textContent = "GMT-03";
  calendarGrid.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-panel">
        <p>${escapeHtml(
          message ||
            "Conecta tu cuenta de Google para cargar los eventos de la semana desde tu calendario principal."
        )}</p>
        <a class="auth-button auth-button--primary" href="/auth/google">Conectar Google Calendar</a>
      </div>
    </div>
  `;
  hideSummary(mainView);
}

function renderGridLoading(grid, message) {
  grid.innerHTML = `<div class="loading-state">${escapeHtml(message)}</div>`;
}

function resetMainView() {
  headerDays.innerHTML = "";
  allDayGrid.innerHTML = "";
  allDayGrid.style.height = "50px";
}

function hideSummary(view) {
  if (!view.summaryBoard || !view.summaryGrid) {
    return;
  }

  view.summaryBoard.hidden = true;
  view.summaryGrid.innerHTML = "";
}

function setPreviewMessage(message, tone) {
  previewMessage.hidden = false;
  previewMessage.textContent = message;

  if (tone === "error") {
    previewMessage.style.background = "rgba(180, 35, 24, 0.08)";
    previewMessage.style.borderColor = "rgba(180, 35, 24, 0.16)";
    previewMessage.style.color = "#8d1c13";
    return;
  }

  previewMessage.style.background = "rgba(26, 115, 232, 0.08)";
  previewMessage.style.borderColor = "rgba(26, 115, 232, 0.12)";
  previewMessage.style.color = "#184169";
}

function clearPreviewMessage() {
  previewMessage.hidden = true;
  previewMessage.textContent = "";
}

function groupByDay(events) {
  const map = new Map();

  for (const event of events) {
    if (!map.has(event.dayIndex)) {
      map.set(event.dayIndex, []);
    }
    map.get(event.dayIndex).push(event);
  }

  return map;
}

function layoutTimedEvents(events) {
  const grouped = new Map();

  for (const event of events) {
    if (!grouped.has(event.dayIndex)) {
      grouped.set(event.dayIndex, []);
    }
    grouped.get(event.dayIndex).push({ ...event });
  }

  const laidOut = [];

  for (const dayEvents of grouped.values()) {
    dayEvents.sort((left, right) => {
      if (left.startMinutes !== right.startMinutes) {
        return left.startMinutes - right.startMinutes;
      }

      return right.endMinutes - left.endMinutes;
    });

    for (const cluster of buildOverlapClusters(dayEvents)) {
      const columns = [];
      for (const event of cluster) {
        let columnIndex = columns.findIndex((endMinutes) => endMinutes <= event.startMinutes);
        if (columnIndex === -1) {
          columnIndex = columns.length;
          columns.push(event.endMinutes);
        } else {
          columns[columnIndex] = event.endMinutes;
        }
        event.column = columnIndex;
      }

      const totalColumns = Math.max(columns.length, 1);
      for (const event of cluster) {
        laidOut.push({
          ...event,
          columns: totalColumns
        });
      }
    }
  }

  return laidOut.sort((left, right) => {
    if (left.dayIndex !== right.dayIndex) {
      return left.dayIndex - right.dayIndex;
    }

    return left.startMinutes - right.startMinutes;
  });
}

function buildOverlapClusters(events) {
  const clusters = [];
  let cluster = [];
  let clusterEnd = -1;

  for (const event of events) {
    if (cluster.length === 0 || event.startMinutes < clusterEnd) {
      cluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMinutes);
      continue;
    }

    clusters.push(cluster);
    cluster = [event];
    clusterEnd = event.endMinutes;
  }

  if (cluster.length > 0) {
    clusters.push(cluster);
  }

  return clusters;
}

function formatMonthLabel(date) {
  return new Intl.DateTimeFormat("es-AR", { month: "long" }).format(date);
}

function formatTimezoneLabel(timezone) {
  const formatter = new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    timeZoneName: "shortOffset"
  });
  const parts = formatter.formatToParts(new Date());
  const offset = parts.find((part) => part.type === "timeZoneName")?.value || timezone;
  return offset.toUpperCase();
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;

  if (hours > 0 && restMinutes > 0) {
    return `${hours} h ${restMinutes} min`;
  }

  if (hours > 0) {
    return `${hours} h`;
  }

  return `${restMinutes} min`;
}

function getCurrentTimeParts(timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    isoDate: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute)
  };
}

function getColorForTitle(title) {
  const hash = Array.from(title || "evento").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

function getEventColor(event) {
  if (event?.colorId && GOOGLE_COLORS[event.colorId]) {
    return GOOGLE_COLORS[event.colorId];
  }

  return getColorForTitle(event?.materia || event?.title);
}

function extractTimeLabelFromIso(value) {
  const match = String(value).match(/T(\d{2}:\d{2})/);
  return match ? match[1] : "00:00";
}

function isValidTimeLabel(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function showBannerFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const authState = params.get("auth");

  if (authState === "connected") {
    setBanner("Google Calendar conectado correctamente.", "info");
  }

  if (!authState) {
    return;
  }

  params.delete("auth");
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
  window.history.replaceState({}, "", nextUrl);
}

function clearTransientBanner() {
  statusBanner.hidden = true;
  statusBanner.textContent = "";
}

function setBanner(message, tone) {
  statusBanner.hidden = false;
  statusBanner.textContent = message;

  if (tone === "error") {
    statusBanner.style.background = "rgba(180, 35, 24, 0.08)";
    statusBanner.style.borderColor = "rgba(180, 35, 24, 0.16)";
    statusBanner.style.color = "#8d1c13";
    return;
  }

  statusBanner.style.background = "rgba(26, 115, 232, 0.08)";
  statusBanner.style.borderColor = "rgba(26, 115, 232, 0.12)";
  statusBanner.style.color = "#184169";
}

async function copyTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "absolute";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
