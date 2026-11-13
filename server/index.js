
import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "node:crypto";

const { API_KEY, DATABASE_URL, PORT = 3000 } = process.env;

if (!API_KEY || !DATABASE_URL) {
  console.error("Set API_KEY and DATABASE_URL");
  process.exit(1);
}

// Create a PostgreSQL connection pool for managing database connections.
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 10,
});

// Initialize the database tables, relationships, and indexes.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      start_raw TEXT NOT NULL,
      end_raw TEXT NOT NULL,
      start_ts TIMESTAMPTZ NOT NULL,
      end_ts TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      seq BIGSERIAL,
      id TEXT PRIMARY KEY,
      slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('confirmed','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    -- Prevents more than one confirmed booking per slot.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed';
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      body_hash TEXT NOT NULL,
      status INT NOT NULL,
      response JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
    CREATE TABLE IF NOT EXISTS attempts (
      email TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS attempts_email_ts ON attempts (email, ts);
  `);
}

// Pass asynchronous errors to Express's error-handling middleware.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Format booking records consistently before returning them.
const bookingOut = (b) => ({
  id: b.id,
  slot_id: b.slot_id,
  name: b.name,
  email: b.email,
  status: b.status,
  created_at: new Date(b.created_at).toISOString(),
});

const isDate = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

const app = express();

// Configure CORS to allow the headers required by the API.
app.use(
  cors({
    origin: true,
    allowedHeaders: ["Content-Type", "X-API-Key", "Idempotency-Key"],
    exposedHeaders: ["Retry-After"],
  }),
);

// API key authentication: reject requests with a missing or invalid key.
app.use((req, res, next) => {
  const given = Buffer.from(req.get("X-API-Key") || "");
  const expected = Buffer.from(API_KEY);
  if (
    given.length !== expected.length ||
    !crypto.timingSafeEqual(given, expected)
  ) {
    return res.status(401).json({ error: "missing or invalid API key" });
  }
  next();
});

app.use(express.json());

// Reset the database and load new slots within a single transaction.
app.post(
  "/reset",
  wrap(async (req, res) => {
    const slots = req.body?.slots;
    if (!Array.isArray(slots)) {
      return res.status(400).json({ error: "slots must be an array" });
    }

    // Validate the slots and reject duplicate IDs before modifying the database.
    const seen = new Set();
    for (const s of slots) {
      const ok =
        s &&
        typeof s.id === "string" &&
        s.id &&
        !seen.has(s.id) &&
        typeof s.provider === "string" &&
        isDate(s.start) &&
        isDate(s.end);
      if (!ok) return res.status(400).json({ error: "invalid slot in list" });
      seen.add(s.id);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM bookings");
      await client.query("DELETE FROM slots");
      await client.query("DELETE FROM idempotency");
      await client.query("DELETE FROM attempts");
      for (const s of slots) {
        await client.query(
          `INSERT INTO slots (id, provider, start_raw, end_raw, start_ts, end_ts)
           VALUES ($1, $2, $3::text, $4::text, $3::text::timestamptz, $4::text::timestamptz)`,
          [s.id, s.provider, s.start, s.end],
        );
      }
      await client.query("COMMIT");
      res.json({ ok: true, slots: slots.length });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// Retrieve slots and calculate their current availability.
app.get(
  "/slots",
  wrap(async (req, res) => {
    const params = [];
    let where = "";
    if (typeof req.query.provider === "string") {
      params.push(req.query.provider);
      where = "WHERE s.provider = $1";
    }

    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_raw, s.end_raw,
              NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
       FROM slots s
       ${where}
       ORDER BY s.start_ts ASC, s.id ASC`,
      params,
    );

    res.json({
      slots: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        start: r.start_raw,
        end: r.end_raw,
        available: r.available,
      })),
    });
  }),
);

// Retrieve an individual booking by its ID.
app.get(
  "/bookings/:id",
  wrap(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [
      req.params.id,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "booking not found" });
    res.json(bookingOut(rows[0]));
  }),
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Generate a SHA-256 hash and a consistent representation of request bodies.
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const canon = (b) =>
  b && typeof b === "object" && !Array.isArray(b)
    ? JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]))
    : JSON.stringify(b ?? null);

// Handle booking validation, rate limiting, and creation.
async function createBooking(client, body) {
  // Normalize input by trimming whitespace and converting emails to lowercase.
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  const slotId = clean(body.slot_id);
  const name = clean(body.name);
  const email = clean(body.email).toLowerCase();

  // Rate limiting: restrict each email to five booking attempts per minute.
  if (email) {
    // Advisory lock prevents simultaneous requests from bypassing the rate limit.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "rl:" + email,
    ]);

    await client.query(
      `DELETE FROM attempts WHERE email = $1 AND ts < clock_timestamp() - interval '5 minutes'`,
      [email],
    );

    const {
      rows: [rl],
    } = await client.query(
      `SELECT count(*)::int AS n,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM
                (min(ts) + interval '60 seconds' - clock_timestamp()))))::int AS retry
       FROM attempts
       WHERE email = $1 AND ts > clock_timestamp() - interval '60 seconds'`,
      [email],
    );

    if (rl.n >= 5) {
      return {
        status: 429,
        retryAfter: rl.retry,
        body: { error: "too many booking attempts, try again later" },
      };
    }

    await client.query("INSERT INTO attempts (email) VALUES ($1)", [email]);
  }

  // Validate required fields and email format before proceeding.
  if (!slotId || !name || !email) {
    return {
      status: 400,
      body: { error: "slot_id, name and email are required" },
    };
  }
  if (!EMAIL_RE.test(email)) {
    return { status: 400, body: { error: "invalid email" } };
  }

  // Confirm that the requested slot exists and has not already started.
  const {
    rows: [slot],
  } = await client.query("SELECT start_ts FROM slots WHERE id = $1", [slotId]);
  if (!slot) return { status: 404, body: { error: "slot not found" } };
  if (new Date(slot.start_ts) <= new Date()) {
    return { status: 400, body: { error: "slot has already started" } };
  }

  // Database-level concurrency control ensures only one confirmed booking per slot.
  const { rows } = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slotId, name, email],
  );
  if (rows.length === 0) {
    return { status: 409, body: { error: "slot already booked" } };
  }

  return { status: 201, body: bookingOut(rows[0]) };
}

// Create bookings with transaction safety and idempotency protection.
app.post(
  "/bookings",
  wrap(async (req, res) => {
    const body = req.body ?? {};
    const key = req.get("Idempotency-Key");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Idempotency: reuse the saved response when the same request is retried.
      if (key) {
        // Advisory lock ensures simultaneous requests with the same key wait for each other.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "idem:" + key,
        ]);

        const {
          rows: [saved],
        } = await client.query(
          "SELECT body_hash, status, response FROM idempotency WHERE key = $1",
          [key],
        );
        if (saved) {
          await client.query("COMMIT");
          // Reject reuse of an idempotency key with a different request body.
          if (saved.body_hash !== sha(canon(body))) {
            return res.status(422).json({
              error: "Idempotency-Key was already used with a different request body",
            });
          }
          return res.status(saved.status).json(saved.response);
        }
      }

      const result = await createBooking(client, body);

      // Store the response so future retries receive the same result.
      if (key && result.status !== 429) {
        await client.query(
          "INSERT INTO idempotency (key, body_hash, status, response) VALUES ($1, $2, $3, $4)",
          [key, sha(canon(body)), result.status, JSON.stringify(result.body)],
        );
      }

      await client.query("COMMIT");
      if (result.retryAfter) res.set("Retry-After", String(result.retryAfter));
      return res.status(result.status).json(result.body);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// Cancel a booking by changing its status rather than deleting the record.
app.delete(
  "/bookings/:id",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING *`,
      [req.params.id],
    );
    if (rows[0]) return res.json(bookingOut(rows[0]));

    // Distinguish an already-cancelled booking from a booking that does not exist.
    const { rows: found } = await pool.query(
      "SELECT 1 FROM bookings WHERE id = $1",
      [req.params.id],
    );
    if (found.length) {
      return res.status(409).json({ error: "booking already cancelled" });
    }
    res.status(404).json({ error: "booking not found" });
  }),
);

// Retrieve a customer's bookings using cursor-based pagination.
app.get(
  "/bookings",
  wrap(async (req, res) => {
    const email =
      typeof req.query.email === "string"
        ? req.query.email.trim().toLowerCase()
        : "";
    if (!email) return res.status(400).json({ error: "email is required" });

    // Validate the page size and enforce a maximum of 50 bookings per request.
    let limit = 10;
    if (req.query.limit !== undefined) {
      const raw = String(req.query.limit);
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) {
        return res
          .status(400)
          .json({ error: "limit must be a whole number from 1 to 50" });
      }
      limit = Number(raw);
    }

    // Decode the cursor to identify where the next page should begin.
    let after = "0";
    if (req.query.cursor !== undefined) {
      const decoded = Buffer.from(
        String(req.query.cursor),
        "base64url",
      ).toString();
      if (!/^\d+$/.test(decoded)) {
        return res.status(400).json({ error: "invalid cursor" });
      }
      after = decoded;
    }

    // Fetch one extra record to determine whether another page exists.
    const { rows } = await pool.query(
      `SELECT seq::text AS seq, id, slot_id, name, email, status, created_at
       FROM bookings
       WHERE email = $1 AND seq > $2::bigint
       ORDER BY seq ASC
       LIMIT $3`,
      [email, after, limit + 1],
    );

    // Build the next cursor from the last returned booking, if another page exists.
    const page = rows.slice(0, limit);
    const next_cursor =
      rows.length > limit
        ? Buffer.from(page[page.length - 1].seq).toString("base64url")
        : null;

    res.json({ bookings: page.map(bookingOut), next_cursor });
  }),
);

// Return a 404 response when the requested route does not exist.
app.use((req, res) => res.status(404).json({ error: "not found" }));

// Handle malformed JSON and unexpected server errors.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ error: "invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

// Initialize the database before starting the API server.
await initDb();
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
