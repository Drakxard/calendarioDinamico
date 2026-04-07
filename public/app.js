const state = {
  offset: 0,
  isLoading: false,
  weekData: null,
  isAuthenticated: false,
  isConfigured: true
};

const headerDays = document.getElementById("header-days");
const rangeTitle = document.getElementById("range-title");
const timezoneLabel = document.getElementById("timezone-label");
const allDayGrid = document.getElementById("all-day-grid");
const calendarGrid = document.getElementById("calendar-grid");
const previousWeekButton = document.getElementById("previous-week");
const nextWeekButton = document.getElementById("next-week");
const connectGoogleLink = document.getElementById("connect-google");
const logoutButton = document.getElementById("logout-button");
const authGroup = document.getElementById("auth-group");
const statusBanner = document.getElementById("status-banner");
const hourLabelTemplate = document.getElementById("hour-label-template");
const gridColumnTemplate = document.getElementById("grid-column-template");

previousWeekButton.addEventListener("click", () => changeWeek(-1));
nextWeekButton.addEventListener("click", () => changeWeek(1));
logoutButton.addEventListener("click", logout);

boot();

async function boot() {
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
      renderError(payload.error || "La configuración OAuth no es válida.");
    }
  } catch (_error) {
    state.isAuthenticated = false;
    state.isConfigured = false;
    updateButtons();
    updateAuthControls();
    renderError("No se pudo comprobar el estado de autenticación.");
  }
}

async function loadWeek() {
  state.isLoading = true;
  updateButtons();
  updateAuthControls();
  calendarGrid.innerHTML = `<div class="loading-state">Cargando semana...</div>`;

  try {
    const response = await fetch(`/api/week-events?offset=${state.offset}`);
    const payload = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        state.isAuthenticated = false;
        state.weekData = null;
        updateButtons();
        updateAuthControls();
        renderUnauthenticatedState(
          payload.error || "Necesitás volver a conectar Google Calendar."
        );
        return;
      }

      throw new Error(payload.error || "No se pudieron cargar los eventos.");
    }

    state.weekData = payload;
    renderWeek(payload);
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

    state.isAuthenticated = false;
    state.weekData = null;
    state.offset = 0;
    setBanner("Sesión desconectada.", "info");
    renderUnauthenticatedState();
  } catch (_error) {
    setBanner("No se pudo cerrar la sesión.", "error");
  } finally {
    updateButtons();
    updateAuthControls();
  }
}

function updateButtons() {
  previousWeekButton.disabled = state.isLoading || !state.isAuthenticated;
  nextWeekButton.disabled = state.isLoading || !state.isAuthenticated;
}

function updateAuthControls() {
  authGroup.hidden = !state.isConfigured;
  connectGoogleLink.hidden = state.isAuthenticated;
  logoutButton.hidden = !state.isAuthenticated;
  logoutButton.disabled = state.isLoading;
}

function renderWeek(data) {
  clearTransientBanner();
  renderHeader(data);
  renderAllDayBand(data);
  renderTimeGrid(data);
}

function renderHeader(data) {
  const start = new Date(`${data.weekStart}T00:00:00`);
  const end = new Date(`${data.weekEnd}T00:00:00`);
  rangeTitle.textContent = `${formatMonthLabel(start)} ${start.getDate()} - ${formatMonthLabel(end)} ${end.getDate()}`;
  timezoneLabel.textContent = formatTimezoneLabel(data.timezone);

  headerDays.innerHTML = "";
  for (const day of data.days) {
    const cell = document.createElement("div");
    cell.className = "header-day";
    if (day.isoDate === data.todayIso) {
      cell.classList.add("is-today");
    }

    cell.innerHTML = `
      <div class="header-day-label">${day.weekdayLabel}</div>
      <div class="header-day-number">${day.dayNumber}</div>
    `;
    headerDays.appendChild(cell);
  }
}

function renderAllDayBand(data) {
  const rowCount = Math.max(
    data.allDayEvents.length ? Math.max(...data.allDayEvents.map((event) => event.row + 1)) : 0,
    1
  );

  allDayGrid.style.height = `${14 + rowCount * 36}px`;
  allDayGrid.innerHTML = "";

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
    allDayGrid.appendChild(element);
  }
}

function renderTimeGrid(data) {
  const totalHours = data.grid.endHour - data.grid.startHour;
  const totalMinutes = totalHours * 60;
  const pixelsPerMinute = 72 / 60;
  const gridHeight = totalMinutes * pixelsPerMinute;

  calendarGrid.innerHTML = "";
  calendarGrid.style.minHeight = `${gridHeight}px`;

  const hoursColumn = document.createElement("div");
  hoursColumn.className = "hours-column";
  for (let hour = data.grid.startHour; hour <= data.grid.endHour; hour += 1) {
    const label = hourLabelTemplate.content.firstElementChild.cloneNode(true);
    label.textContent = `${String(hour).padStart(2, "0")}:00`;
    label.style.top = `${(hour - data.grid.startHour) * 72}px`;
    hoursColumn.appendChild(label);
  }
  calendarGrid.appendChild(hoursColumn);

  const eventsByDay = groupByDay(data.timedEvents);
  for (const day of data.days) {
    const dayColumn = gridColumnTemplate.content.firstElementChild.cloneNode(true);
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
        <span class="event-time">${event.displayTime}</span>
      `;
      eventsLayer.appendChild(card);
    }

    calendarGrid.appendChild(dayColumn);
  }

  if (data.timedEvents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No hay eventos con horario en esta semana.";
    calendarGrid.appendChild(empty);
  }
}

function renderError(message) {
  headerDays.innerHTML = "";
  allDayGrid.innerHTML = "";
  allDayGrid.style.height = "50px";
  rangeTitle.textContent = "Calendario semanal";
  calendarGrid.innerHTML = `<div class="error-state">${escapeHtml(message)}</div>`;
}

function renderUnauthenticatedState(message) {
  headerDays.innerHTML = "";
  allDayGrid.innerHTML = "";
  allDayGrid.style.height = "50px";
  rangeTitle.textContent = "Calendario semanal";
  timezoneLabel.textContent = "GMT-03";
  calendarGrid.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-panel">
        <p>${escapeHtml(
          message ||
            "Conectá tu cuenta de Google para cargar los eventos de la semana desde tu calendario principal."
        )}</p>
        <a class="auth-button auth-button--primary" href="/auth/google">Conectar Google Calendar</a>
      </div>
    </div>
  `;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
