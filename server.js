const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  NoSuchKey
} = require("@aws-sdk/client-s3");
const { google } = require("googleapis");
const { DateTime } = require("luxon");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const TIMEZONE = process.env.TIMEZONE || "America/Argentina/Buenos_Aires";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const GOOGLE_SCOPES =
  process.env.GOOGLE_SCOPES || "https://www.googleapis.com/auth/calendar.events";
const SESSION_SECRET = process.env.SESSION_SECRET;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;

const TOKEN_OBJECT_KEY = "oauth/google-calendar.json";
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

const r2Client = createR2Client();

app.use(express.json());
app.use(
  session({
    name: "calendar-session",
    secret: SESSION_SECRET || "temporary-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);
app.use(express.static("public"));

app.get("/api/auth/status", async (req, res) => {
  try {
    ensureOAuthConfig();
    ensureR2Config();
    const authenticated = await hydrateSessionFromStoredToken(req);

    res.json({
      authenticated,
      configured: true
    });
  } catch (error) {
    res.status(500).json({
      authenticated: false,
      configured: false,
      error: error.message || "La configuración OAuth/R2 no es válida."
    });
  }
});

app.get("/auth/google", (req, res, next) => {
  try {
    ensureOAuthConfig();
    ensureR2Config();

    const oauthClient = createOAuthClient();
    const state = crypto.randomBytes(16).toString("hex");
    req.session.oauthState = state;

    const authorizationUrl = oauthClient.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES.split(",").map((scope) => scope.trim()).filter(Boolean),
      state
    });

    res.redirect(authorizationUrl);
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    ensureOAuthConfig();
    ensureR2Config();

    if (!req.query.code) {
      const error = new Error("Google no devolvió un código de autorización.");
      error.statusCode = 400;
      throw error;
    }

    if (!req.query.state || req.query.state !== req.session.oauthState) {
      const error = new Error("La validación de seguridad del login OAuth falló.");
      error.statusCode = 400;
      throw error;
    }

    const oauthClient = createOAuthClient();
    const { tokens } = await oauthClient.getToken(String(req.query.code));

    if (!tokens || (!tokens.refresh_token && !tokens.access_token)) {
      const error = new Error("Google no devolvió credenciales utilizables.");
      error.statusCode = 400;
      throw error;
    }

    await saveStoredTokens(await mergeWithStoredTokens(tokens));
    req.session.oauthState = null;
    req.session.authenticated = true;

    res.redirect("/?auth=connected");
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", async (req, res) => {
  try {
    const oauthClient = createOAuthClient();
    const storedTokens = await loadStoredTokens();

    if (storedTokens?.refresh_token) {
      oauthClient.setCredentials(storedTokens);
      await oauthClient.revokeToken(storedTokens.refresh_token);
    } else if (storedTokens?.access_token) {
      await oauthClient.revokeToken(storedTokens.access_token);
    }
  } catch (_error) {
    // Ignore revoke errors in local dev logout.
  } finally {
    await deleteStoredTokens();
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  }
});

app.get("/api/week-events", async (req, res) => {
  try {
    ensureOAuthConfig();
    ensureR2Config();

    const oauthClient = await requireAuthenticatedClient(req);
    const offset = Number.parseInt(req.query.offset, 10) || 0;
    const week = buildWeekRange(offset);
    const items = await fetchGoogleWeekEvents(oauthClient, week.start, week.end);
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
  res.sendFile("index.html", { root: "public" });
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).send(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <title>Error OAuth</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #f5f7fb; color: #243447; padding: 32px; }
          .card { max-width: 720px; margin: 0 auto; background: white; border-radius: 18px; padding: 24px; box-shadow: 0 18px 45px rgba(31,56,88,.10); }
          h1 { margin-top: 0; }
          a { color: #1a73e8; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>No se pudo completar la autenticación</h1>
          <p>${escapeHtml(error.message || "Ocurrió un error inesperado.")}</p>
          <p><a href="/">Volver al calendario</a></p>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

function ensureOAuthConfig() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    const error = new Error(
      "Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REDIRECT_URI en el archivo .env."
    );
    error.statusCode = 500;
    throw error;
  }

  if (!SESSION_SECRET) {
    const error = new Error("Falta SESSION_SECRET en el archivo .env.");
    error.statusCode = 500;
    throw error;
  }
}

function ensureR2Config() {
  if (
    !CLOUDFLARE_ACCOUNT_ID ||
    !R2_BUCKET_NAME ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_ENDPOINT
  ) {
    const error = new Error(
      "Faltan variables de R2: CLOUDFLARE_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY o R2_ENDPOINT."
    );
    error.statusCode = 500;
    throw error;
  }
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function createR2Client() {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return null;
  }

  return new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    }
  });
}

async function hydrateSessionFromStoredToken(req) {
  if (req.session.authenticated) {
    return true;
  }

  const tokens = await loadStoredTokens();
  if (!tokens) {
    return false;
  }

  req.session.authenticated = true;
  return true;
}

async function requireAuthenticatedClient(req) {
  const tokens = await loadStoredTokens();

  if (!tokens) {
    const error = new Error("No hay una sesión autenticada. Conectá Google Calendar.");
    error.statusCode = 401;
    throw error;
  }

  req.session.authenticated = true;

  const oauthClient = createOAuthClient();
  oauthClient.setCredentials(tokens);
  oauthClient.on("tokens", async (nextTokens) => {
    if (!nextTokens || Object.keys(nextTokens).length === 0) {
      return;
    }

    try {
      await saveStoredTokens(await mergeWithStoredTokens(nextTokens));
    } catch (_error) {
      // Avoid breaking request lifecycle on background refresh persistence failures.
    }
  });

  try {
    await oauthClient.getAccessToken();
    return oauthClient;
  } catch (_error) {
    await deleteStoredTokens();
    req.session.authenticated = false;
    const error = new Error(
      "La autorización de Google expiró o no es válida. Volvé a conectar la cuenta."
    );
    error.statusCode = 401;
    throw error;
  }
}

async function loadStoredTokens() {
  ensureR2Client();

  try {
    const response = await r2Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: TOKEN_OBJECT_KEY
      })
    );

    const body = await response.Body.transformToString();
    if (!body.trim()) {
      return null;
    }

    return JSON.parse(body);
  } catch (error) {
    if (
      error instanceof NoSuchKey ||
      error?.name === "NoSuchKey" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }

    const storageError = new Error(`No se pudo leer la persistencia OAuth en R2. ${error.message}`);
    storageError.statusCode = 500;
    throw storageError;
  }
}

async function saveStoredTokens(tokens) {
  ensureR2Client();

  try {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: TOKEN_OBJECT_KEY,
        Body: JSON.stringify(tokens, null, 2),
        ContentType: "application/json"
      })
    );
  } catch (error) {
    const storageError = new Error(`No se pudo guardar la persistencia OAuth en R2. ${error.message}`);
    storageError.statusCode = 500;
    throw storageError;
  }
}

async function deleteStoredTokens() {
  ensureR2Client();

  try {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: TOKEN_OBJECT_KEY
      })
    );
  } catch (error) {
    const storageError = new Error(`No se pudo borrar la persistencia OAuth en R2. ${error.message}`);
    storageError.statusCode = 500;
    throw storageError;
  }
}

async function mergeWithStoredTokens(incomingTokens) {
  const existingTokens = (await loadStoredTokens()) || {};
  return {
    ...existingTokens,
    ...incomingTokens,
    refresh_token: incomingTokens.refresh_token || existingTokens.refresh_token
  };
}

function ensureR2Client() {
  if (!r2Client) {
    const error = new Error("El cliente de Cloudflare R2 no está configurado.");
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

async function fetchGoogleWeekEvents(oauthClient, weekStart, weekEnd) {
  const calendar = google.calendar({ version: "v3", auth: oauthClient });
  const response = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    singleEvents: true,
    orderBy: "startTime",
    timeMin: weekStart.toUTC().toISO(),
    timeMax: weekEnd.plus({ days: 1 }).startOf("day").toUTC().toISO(),
    maxResults: 2500
  });

  return response.data.items || [];
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
  const endDayIndex = Math.min(
    6,
    Math.floor(clippedEnd.startOf("day").diff(week.start, "days").days)
  );
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
      const rawEndMinutes =
        segmentEnd.hour * 60 + segmentEnd.minute + (segmentEnd.second > 0 ? 1 : 0);
      const startMinutes = Math.max(rawStartMinutes, visibleStartMinutes);
      const endMinutes = Math.min(
        Math.max(rawEndMinutes, startMinutes + 30),
        visibleEndMinutes
      );

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
        let columnIndex = columns.findIndex(
          (endMinutes) => endMinutes <= event.startMinutes
        );
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
