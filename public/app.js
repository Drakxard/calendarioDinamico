const state = {
  offset: 0,
  isLoading: false,
  weekData: null
};

const headerDays = document.getElementById("header-days");
const rangeTitle = document.getElementById("range-title");
const timezoneLabel = document.getElementById("timezone-label");
const allDayGrid = document.getElementById("all-day-grid");
const calendarGrid = document.getElementById("calendar-grid");
const previousWeekButton = document.getElementById("previous-week");
const nextWeekButton = document.getElementById("next-week");
const hourLabelTemplate = document.getElementById("hour-label-template");
const gridColumnTemplate = document.getElementById("grid-column-template");

previousWeekButton.addEventListener("click", () => changeWeek(-1));
nextWeekButton.addEventListener("click", () => changeWeek(1));

loadWeek();

async function changeWeek(direction) {
  if (state.isLoading) {
    return;
  }

  state.offset += direction;
  await loadWeek();
}

async function loadWeek() {
  state.isLoading = true;
  updateButtons();
  calendarGrid.innerHTML = `<div class="loading-state">Cargando semana...</div>`;

  try {
    const response = await fetch(`/api/week-events?offset=${state.offset}`);
    const payload = await response.json();

    if (!response.ok) {
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
  }
}

function updateButtons() {
  previousWeekButton.disabled = state.isLoading;
  nextWeekButton.disabled = state.isLoading;
}

function renderWeek(data) {
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
