const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { DateTime } = require("luxon");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const TIMEZONE = process.env.TIMEZONE || "America/Argentina/Buenos_Aires";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

const DAY_NAMES = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];
const GRID_START_HOUR = 8;
const GRID_END_HOUR = 23;
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
const FALLBACK_COLORS = [
  { background: "#1f97d4", accent: "#1294d8" },
  { background: "#e57b72", accent: "#d55a52" },
  { background: "#7885cb", accent: "#6270c7" },
  { background: "#ff5b1e", accent: "#f24d11" },
  { background: "#6d6d6d", accent: "#5d5d5d" }
];

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/week-events", async (req, res) => {
  try {
    ensureGoogleConfig();

    const offset = Number.parseInt(req.query.offset, 10) || 0;
    const week = buildWeekRange(offset);
    const items = await fetchGoogleWeekEvents(week.start, week.end);
    const normalized = normalizeWeekResponse(items, week);

    res.json(normalized);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.message || "No se pudieron cargar los eventos."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

function ensureGoogleConfig() {
  if (!GOOGLE_API_KEY || !GOOGLE_CALENDAR_ID) {
    const error = new Error(
      "Faltan GOOGLE_API_KEY o GOOGLE_CALENDAR_ID en el archivo .env."
    );
    error.statusCode = 500;
    throw error;
  }
}

function buildWeekRange(offset) {
  const current = DateTime.now().setZone(TIMEZONE);
  const sundayIndex = current.weekday % 7;
  const weekStart = current
    .minus({ days: sundayIndex })
    .startOf("day")
    .plus({ weeks: offset });
  const weekEnd = weekStart.plus({ days: 6 }).endOf("day");

  return {
    offset,
    start: weekStart,
    end: weekEnd,
    today: current.startOf("day"),
    days: Array.from({ length: 7 }, (_, index) => {
      const date = weekStart.plus({ days: index });

      return {
        index,
        date,
        isoDate: date.toISODate(),
        weekdayLabel: DAY_NAMES[index],
        dayNumber: date.day
      };
    })
  };
}

async function fetchGoogleWeekEvents(weekStart, weekEnd) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      GOOGLE_CALENDAR_ID
    )}/events`
  );

  url.searchParams.set("key", GOOGLE_API_KEY);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", weekStart.toUTC().toISO());
  url.searchParams.set("timeMax", weekEnd.plus({ days: 1 }).startOf("day").toUTC().toISO());
  url.searchParams.set("maxResults", "2500");

  const response = await fetch(url);

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Google Calendar API respondió ${response.status}. ${details}`);
    error.statusCode = 500;
    throw error;
  }

  const payload = await response.json();
  return payload.items || [];
}

function normalizeWeekResponse(items, week) {
  const allDayEvents = [];
  const timedEvents = [];
  const visibleStartMinutes = GRID_START_HOUR * 60;
  const visibleEndMinutes = GRID_END_HOUR * 60;

  for (const item of items) {
    if (isAllDayEvent(item)) {
      const allDay = normalizeAllDayEvent(item, week);
      if (allDay) {
        allDayEvents.push(allDay);
      }
      continue;
    }

    const segments = normalizeTimedEvent(item, week, visibleStartMinutes, visibleEndMinutes);
    timedEvents.push(...segments);
  }

  return {
    timezone: TIMEZONE,
    offset: week.offset,
    todayIso: week.today.toISODate(),
    weekStart: week.start.toISODate(),
    weekEnd: week.end.toISODate(),
    days: week.days.map((day) => ({
      index: day.index,
      isoDate: day.isoDate,
      weekdayLabel: day.weekdayLabel,
      dayNumber: day.dayNumber
    })),
    allDayEvents: layoutAllDayEvents(allDayEvents),
    timedEvents: layoutTimedEvents(timedEvents),
    grid: {
      startHour: GRID_START_HOUR,
      endHour: GRID_END_HOUR
    }
  };
}

function isAllDayEvent(item) {
  return Boolean(item.start?.date && item.end?.date);
}

function normalizeAllDayEvent(item, week) {
  const start = DateTime.fromISO(item.start.date, { zone: TIMEZONE }).startOf("day");
  const endExclusive = DateTime.fromISO(item.end.date, { zone: TIMEZONE }).startOf("day");
  const end = endExclusive.minus({ days: 1 }).endOf("day");

  const clippedStart = start < week.start ? week.start : start;
  const clippedEnd = end > week.end ? week.end : end;

  if (clippedEnd < week.start || clippedStart > week.end) {
    return null;
  }

  const startDayIndex = Math.max(0, Math.floor(clippedStart.diff(week.start, "days").days));
  const endDayIndex = Math.min(6, Math.floor(clippedEnd.startOf("day").diff(week.start, "days").days));
  const color = getEventColor(item);

  return {
    id: item.id,
    title: item.summary || "(Sin título)",
    startDayIndex,
    endDayIndex,
    span: endDayIndex - startDayIndex + 1,
    color
  };
}

function normalizeTimedEvent(item, week, visibleStartMinutes, visibleEndMinutes) {
  const start = parseDateTime(item.start?.dateTime);
  const end = parseDateTime(item.end?.dateTime);

  if (!start || !end || end <= week.start || start >= week.end.plus({ milliseconds: 1 })) {
    return [];
  }

  const clippedStart = start < week.start ? week.start : start;
  const clippedEnd = end > week.end ? week.end : end;
  const color = getEventColor(item);
  const segments = [];

  let cursor = clippedStart.startOf("day");
  const finalDay = clippedEnd.startOf("day");
  while (cursor <= finalDay) {
    const dayIndex = Math.floor(cursor.diff(week.start, "days").days);

    if (dayIndex >= 0 && dayIndex < 7) {
      const segmentStart = clippedStart > cursor ? clippedStart : cursor;
      const segmentEnd = clippedEnd < cursor.endOf("day") ? clippedEnd : cursor.endOf("day");
      const rawStartMinutes = segmentStart.hour * 60 + segmentStart.minute;
      const rawEndMinutes = segmentEnd.hour * 60 + segmentEnd.minute + (segmentEnd.second > 0 ? 1 : 0);
      const startMinutes = Math.max(rawStartMinutes, visibleStartMinutes);
      const endMinutes = Math.min(Math.max(rawEndMinutes, startMinutes + 30), visibleEndMinutes);

      if (endMinutes > visibleStartMinutes && startMinutes < visibleEndMinutes) {
        segments.push({
          id: `${item.id}-${cursor.toISODate()}`,
          sourceId: item.id,
          title: item.summary || "(Sin título)",
          start: segmentStart.toISO(),
          end: segmentEnd.toISO(),
          dayIndex,
          startMinutes,
          endMinutes,
          durationMinutes: endMinutes - startMinutes,
          displayTime: formatDisplayTime(segmentStart, segmentEnd),
          isClippedTop: rawStartMinutes < visibleStartMinutes,
          isClippedBottom: rawEndMinutes > visibleEndMinutes,
          color
        });
      }
    }

    cursor = cursor.plus({ days: 1 });
  }

  return segments;
}

function parseDateTime(value) {
  if (!value) {
    return null;
  }

  return DateTime.fromISO(value, { setZone: true }).setZone(TIMEZONE);
}

function formatDisplayTime(start, end) {
  return `${start.toFormat("HH:mm")} - ${end.toFormat("HH:mm")}`;
}

function getEventColor(item) {
  if (item.colorId && GOOGLE_COLORS[item.colorId]) {
    return GOOGLE_COLORS[item.colorId];
  }

  const base = item.summary || item.id || "evento";
  const hash = Array.from(base).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

function layoutAllDayEvents(events) {
  const sorted = [...events].sort((left, right) => {
    if (left.startDayIndex !== right.startDayIndex) {
      return left.startDayIndex - right.startDayIndex;
    }

    return right.endDayIndex - left.endDayIndex;
  });

  const lanes = [];

  for (const event of sorted) {
    let row = 0;
    while (lanes[row] !== undefined && lanes[row] >= event.startDayIndex) {
      row += 1;
    }

    lanes[row] = event.endDayIndex;
    event.row = row;
  }

  return sorted;
}

function layoutTimedEvents(events) {
  const grouped = new Map();

  for (const event of events) {
    if (!grouped.has(event.dayIndex)) {
      grouped.set(event.dayIndex, []);
    }
    grouped.get(event.dayIndex).push(event);
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
