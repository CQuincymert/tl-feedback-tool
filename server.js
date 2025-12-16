// server.js
"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const { OPENAI_API_KEY, ADMIN_PASSWORD, DATABASE_URL, JWT_SECRET } = process.env;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var (Neon connection string).");
}

if (!ADMIN_PASSWORD) {
  console.error("Missing ADMIN_PASSWORD env var.");
}

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET env var (set a long random string).");
}

let openai = null;
if (OPENAI_API_KEY) {
  try {
    const OpenAI = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  } catch (e) {
    console.warn("OpenAI client not available. AI summaries will be disabled.");
  }
}

const app = express();
const PORT = process.env.PORT || 4000;

// Serve static UI
app.use(express.static(path.join(__dirname, "public")));

// Body + CORS
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Postgres pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

// Privacy control: only show raw comments after N responses
const MIN_COMMENTS_FOR_DISPLAY = 3;

// -------------------- Helpers --------------------

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function safeText(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

function computeOverallFromScores(scoresObj) {
  // scoresObj = { q2: 1..5, q3: 1..5 ... }
  const vals = Object.values(scoresObj || {}).map(Number).filter(v => Number.isFinite(v) && v >= 1 && v <= 5);
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return sum / vals.length;
}

function signSessionToken(payload) {
  // payload: { codeId, campaignId, teamLeaderId }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "2h" });
}

function verifySessionToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// -------------------- DB init / schema --------------------

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        campaign_key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_leaders (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS codes (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        team_leader_id INTEGER NOT NULL REFERENCES team_leaders(id),
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        used BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        used_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        team_leader_id INTEGER NOT NULL REFERENCES team_leaders(id),
        scores_json JSONB NOT NULL,
        overall_score DOUBLE PRECISION NOT NULL,
        strengths_text TEXT,
        dev_text TEXT,
        other_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query("COMMIT");
    console.log("Postgres schema initialised.");

    // Seed default TLs (only if table empty)
    const count = await client.query(`SELECT COUNT(*)::int AS n FROM team_leaders;`);
    if (count.rows[0].n === 0) {
      const defaults = ["Gill", "Kristian", "Nicola", "Teri", "Trish", "Kate-Marie", "Katie"];
      for (const name of defaults) {
        await client.query(`INSERT INTO team_leaders(name, active) VALUES ($1, true)`, [name]);
      }
      console.log("Seeded default team leaders.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("DB init error:", e);
    throw e;
  } finally {
    client.release();
  }
}

// -------------------- Public API (questionnaire) --------------------

// Health
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// IMPORTANT: We do NOT bind the questionnaire to a “current cycle”.
// We keep this endpoint for UI convenience only.
app.get("/api/current-campaign", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT campaign_key AS "campaignId", label
      FROM campaigns
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (!r.rowCount) return res.status(404).json({ error: "no_campaigns" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("Error in /api/current-campaign:", e);
    res.status(500).json({ error: "db_error" });
  }
});

// POST /api/start-session
// Verifies a feedback code and returns a sessionToken
app.post("/api/start-session", async (req, res) => {
  const codeRaw = String(req.body?.code || "");
  const code = codeRaw.trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Code is required." });

  try {
    const r = await pool.query(
      `
      SELECT
        c.id              AS code_id,
        c.used            AS used,
        c.campaign_id     AS campaign_id,
        cam.campaign_key  AS campaign_key,
        cam.label         AS campaign_label,
        c.team_leader_id  AS team_leader_id
      FROM codes c
      JOIN campaigns cam ON cam.id = c.campaign_id
      WHERE UPPER(TRIM(c.code)) = $1
      LIMIT 1
      `,
      [code]
    );

    if (!r.rowCount) {
      return res.status(404).json({ error: "Invalid code." });
    }

    const row = r.rows[0];

    if (row.used) {
      return res.status(409).json({ error: "This code has already been used." });
    }

    const sessionToken = signSessionToken({
      codeId: row.code_id,
      campaignId: row.campaign_id,     // INTERNAL id
      teamLeaderId: row.team_leader_id // INTERNAL id
    });

    res.json({
      ok: true,
      sessionToken,
      // not shown to user, useful for debugging
      campaignLabel: row.campaign_label
    });
  } catch (e) {
    console.error("Error in /api/start-session:", e);
    res.status(500).json({ error: "Server error verifying code." });
  }
});


// Step 2: submit feedback (must include sessionToken)
app.post("/api/submit-feedback", async (req, res) => {
  const token = safeText(req.body?.sessionToken);
  const scores = req.body?.scores;

  if (!token) return res.status(400).json({ error: "Missing sessionToken." });
  if (!scores || typeof scores !== "object") return res.status(400).json({ error: "Missing scores." });

  let session;
  try {
    session = verifySessionToken(token);
  } catch (e) {
    return res.status(401).json({ error: "Session expired. Please start again with your code." });
  }

  const overall = computeOverallFromScores(scores);
  if (!overall) return res.status(400).json({ error: "Scores are invalid." });

  const strengthsText = safeText(req.body?.strengthsText);
  const devText = safeText(req.body?.devText);
  const otherText = safeText(req.body?.otherText);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure code still exists and unused (prevents reuse / race conditions)
    const codeCheck = await client.query(
      `SELECT used FROM codes WHERE id = $1 FOR UPDATE`,
      [session.codeId]
    );
    if (!codeCheck.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Code session invalid." });
    }
    if (codeCheck.rows[0].used) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This code has already been used." });
    }

    // Lookup campaign internal ID from campaign_key
    const cam = await client.query(`SELECT id FROM campaigns WHERE campaign_key = $1`, [session.campaignId]);
    if (!cam.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Campaign not found." });
    }
    const campaignDbId = cam.rows[0].id;

    // Insert feedback scoped to the campaignDbId
    await client.query(
      `
      INSERT INTO feedback (
        campaign_id, team_leader_id, scores_json, overall_score,
        strengths_text, dev_text, other_text
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
      `,
      [
        campaignDbId,
        session.teamLeaderId,
        JSON.stringify(scores),
        overall,
        strengthsText,
        devText,
        otherText,
      ]
    );

    // Mark code as used
    await client.query(
      `UPDATE codes SET used = true, used_at = now() WHERE id = $1`,
      [session.codeId]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Error in /api/submit-feedback:", e);
    res.status(500).json({ error: "Server error saving feedback." });
  } finally {
    client.release();
  }
});

// -------------------- Admin API --------------------

// List campaigns
app.get("/api/admin/campaigns", adminAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT campaign_key AS id, label, created_at
      FROM campaigns
      ORDER BY created_at DESC
    `);
    res.json({ campaigns: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Create campaign
app.post("/api/admin/campaigns", adminAuth, async (req, res) => {
  const campaignId = safeText(req.body?.campaignId);
  const label = safeText(req.body?.label);
  if (!campaignId || !label) return res.status(400).json({ error: "campaignId and label required" });

  try {
    await pool.query(
      `INSERT INTO campaigns (campaign_key, label) VALUES ($1, $2)`,
      [campaignId, label]
    );
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message || "").includes("duplicate key")) {
      return res.status(409).json({ error: "Campaign ID already exists." });
    }
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Delete campaign (and its data)
app.post("/api/admin/delete-campaign", adminAuth, async (req, res) => {
  const campaignId = safeText(req.body?.campaignId);
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cam = await client.query(`SELECT id FROM campaigns WHERE campaign_key = $1`, [campaignId]);
    if (!cam.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Campaign not found." });
    }
    const campaignDbId = cam.rows[0].id;

    await client.query(`DELETE FROM feedback WHERE campaign_id = $1`, [campaignDbId]);
    await client.query(`DELETE FROM codes WHERE campaign_id = $1`, [campaignDbId]);
    await client.query(`DELETE FROM campaigns WHERE id = $1`, [campaignDbId]);

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "db_error" });
  } finally {
    client.release();
  }
});

// Team leaders list (active)
app.get("/api/admin/team-leaders", adminAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT name, active FROM team_leaders ORDER BY name ASC`);
    res.json({ teamLeaders: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Add/reactivate TL
app.post("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const name = safeText(req.body?.name);
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    // upsert-ish
    const existing = await pool.query(`SELECT id FROM team_leaders WHERE name = $1`, [name]);
    if (existing.rowCount) {
      await pool.query(`UPDATE team_leaders SET active = true WHERE name = $1`, [name]);
      return res.json({ ok: true, reactivated: true });
    }
    await pool.query(`INSERT INTO team_leaders(name, active) VALUES ($1, true)`, [name]);
    res.json({ ok: true, created: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Deactivate TL
app.delete("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const name = safeText(req.body?.name);
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    const r = await pool.query(`UPDATE team_leaders SET active = false WHERE name = $1`, [name]);
    res.json({ ok: true, affectedRows: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Generate codes
app.post("/api/admin/generate-codes", adminAuth, async (req, res) => {
  const campaignId = safeText(req.body?.campaignId);
  const teamLeaderName = safeText(req.body?.teamLeaderId);
  const count = Number(req.body?.count);

  if (!campaignId || !teamLeaderName || !Number.isFinite(count) || count < 1 || count > 1000) {
    return res.status(400).json({ error: "campaignId, teamLeaderId, count required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cam = await client.query(`SELECT id FROM campaigns WHERE campaign_key = $1`, [campaignId]);
    if (!cam.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Campaign not found." });
    }
    const campaignDbId = cam.rows[0].id;

    const tl = await client.query(`SELECT id FROM team_leaders WHERE name = $1`, [teamLeaderName]);
    if (!tl.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Team leader not found." });
    }
    const teamLeaderDbId = tl.rows[0].id;

    const codes = [];
    for (let i = 0; i < count; i++) {
      // Simple human-friendly code
      const code = `${randPart(4)}-${randPart(4)}`.toUpperCase();
      try {
        await client.query(
          `INSERT INTO codes (code, team_leader_id, campaign_id) VALUES ($1, $2, $3)`,
          [code, teamLeaderDbId, campaignDbId]
        );
        codes.push(code);
      } catch (e) {
        // retry on collision
        i--;
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, codes });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "db_error" });
  } finally {
    client.release();
  }
});

function randPart(n) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Overview (MUST be scoped by campaignId)
// ===============================
// ADMIN: OVERVIEW (per TL, per cycle)
// Accepts campaignId as either:
// - campaigns.campaign_key (UI-friendly)  e.g. "2025-360"
// - campaigns.id (internal DB id)         e.g. "a1b2c3..." or "2025-360" if you use that as id
// ===============================
app.get("/api/admin/overview", adminAuth, async (req, res) => {
  const campaignIdOrKey = String(req.query.campaignId || "").trim();
  if (!campaignIdOrKey) {
    return res.status(400).json({ error: "campaignId is required." });
  }

  try {
    // 1) Resolve campaign internal id from either key or id
    const camRes = await pool.query(
      `
      SELECT id, campaign_key, label
      FROM campaigns
      WHERE campaign_key = $1 OR id = $1
      LIMIT 1
      `,
      [campaignIdOrKey]
    );

    if (!camRes.rowCount) {
      return res.status(404).json({ error: "Cycle not found." });
    }

    const campaign = camRes.rows[0];

    // 2) Build overview by TL for that campaign.id
    const r = await pool.query(
      `
      SELECT
        tl.id AS "teamLeaderId",
        COUNT(f.id)::int AS "responseCount",
        COALESCE(AVG(f.overall_score), 0) AS "avgScore"
      FROM team_leaders tl
      LEFT JOIN feedback f
        ON f.team_leader_id = tl.id
       AND f.campaign_id = $1
      WHERE tl.active = true
      GROUP BY tl.id
      ORDER BY tl.id ASC
      `,
      [campaign.id]
    );

    res.json({
      campaign: {
        id: campaign.id,
        campaign_key: campaign.campaign_key,
        label: campaign.label,
      },
      results: r.rows.map(row => ({
        teamLeaderId: row.teamLeaderId,
        responseCount: row.responseCount,
        avgScore: row.avgScore ? Number(row.avgScore) : 0,
      })),
    });
  } catch (e) {
    console.error("Error in /api/admin/overview:", e);
    res.status(500).json({ error: "DB error loading overview." });
  }
});

// Detail (MUST be scoped by campaignId)
app.get("/api/admin/detail", adminAuth, async (req, res) => {
  const campaignId = safeText(req.query?.campaignId);
  const teamLeaderName = safeText(req.query?.teamLeaderId);

  if (!campaignId || !teamLeaderName) return res.status(400).json({ error: "campaignId and teamLeaderId required" });

  try {
    const cam = await pool.query(`SELECT id FROM campaigns WHERE campaign_key = $1`, [campaignId]);
    if (!cam.rowCount) return res.status(404).json({ error: "Campaign not found." });
    const campaignDbId = cam.rows[0].id;

    const tl = await pool.query(`SELECT id FROM team_leaders WHERE name = $1`, [teamLeaderName]);
    if (!tl.rowCount) return res.status(404).json({ error: "Team leader not found." });
    const teamLeaderDbId = tl.rows[0].id;

    const r = await pool.query(
      `
      SELECT overall_score, scores_json, strengths_text, dev_text, other_text
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      ORDER BY created_at DESC
      `,
      [campaignDbId, teamLeaderDbId]
    );

    const rows = r.rows;
    const responseCount = rows.length;

    // Averages per question
    const sums = {};
    const counts = {};
    let overallSum = 0;

    for (const row of rows) {
      overallSum += Number(row.overall_score) || 0;
      const s = row.scores_json || {};
      for (const [k, v] of Object.entries(s)) {
        const num = Number(v);
        if (!Number.isFinite(num)) continue;
        sums[k] = (sums[k] || 0) + num;
        counts[k] = (counts[k] || 0) + 1;
      }
    }

    const questionAverages = {};
    for (const k of Object.keys(sums)) {
      questionAverages[k] = sums[k] / counts[k];
    }

    // Comments gating
    let comments = null;
    if (responseCount >= MIN_COMMENTS_FOR_DISPLAY) {
      comments = {
        strengths: rows.map(x => x.strengths_text).filter(Boolean),
        devs: rows.map(x => x.dev_text).filter(Boolean),
        others: rows.map(x => x.other_text).filter(Boolean),
      };
    }

    res.json({
      responseCount,
      avgOverall: responseCount ? overallSum / responseCount : null,
      questionAverages,
      comments,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Delete all responses for TL + cycle
app.post("/api/admin/delete-feedback", adminAuth, async (req, res) => {
  const campaignId = safeText(req.body?.campaignId);
  const teamLeaderName = safeText(req.body?.teamLeaderId);

  if (!campaignId || !teamLeaderName) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cam = await client.query(`SELECT id FROM campaigns WHERE campaign_key = $1`, [campaignId]);
    if (!cam.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Campaign not found." });
    }
    const campaignDbId = cam.rows[0].id;

    const tl = await client.query(`SELECT id FROM team_leaders WHERE name = $1`, [teamLeaderName]);
    if (!tl.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Team leader not found." });
    }
    const teamLeaderDbId = tl.rows[0].id;

    const del = await client.query(
      `DELETE FROM feedback WHERE campaign_id = $1 AND team_leader_id = $2`,
      [campaignDbId, teamLeaderDbId]
    );

    await client.query("COMMIT");
    res.json({ ok: true, deletedRows: del.rowCount });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "db_error" });
  } finally {
    client.release();
  }
});

// AI summary (scoped to campaign + TL)
app.get("/api/admin/ai-summary", adminAuth, async (req, res) => {
  const campaignId = safeText(req.query?.campaignId);
  const teamLeaderName = safeText(req.query?.teamLeaderId);

  if (!campaignId || !teamLeaderName) return res.status(400).json({ error: "campaignId and teamLeaderId required" });
  if (!openai) return res.status(400).json({ error: "AI not configured (missing OPENAI_API_KEY)." });

  try {
    const cam = await pool.query(`SELECT id FROM campaigns WHERE campaign_key = $1`, [campaignId]);
    if (!cam.rowCount) return res.status(404).json({ error: "Campaign not found." });
    const campaignDbId = cam.rows[0].id;

    const tl = await pool.query(`SELECT id FROM team_leaders WHERE name = $1`, [teamLeaderName]);
    if (!tl.rowCount) return res.status(404).json({ error: "Team leader not found." });
    const teamLeaderDbId = tl.rows[0].id;

    const r = await pool.query(
      `
      SELECT strengths_text, dev_text, other_text
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      ORDER BY created_at DESC
      `,
      [campaignDbId, teamLeaderDbId]
    );

    if (r.rowCount < MIN_COMMENTS_FOR_DISPLAY) {
      return res.json({ summary: "Comments are hidden until 3+ responses to protect anonymity." });
    }

    const blocks = [];
    for (const row of r.rows) {
      if (row.strengths_text) blocks.push(`Strengths: ${row.strengths_text}`);
      if (row.dev_text) blocks.push(`Development: ${row.dev_text}`);
      if (row.other_text) blocks.push(`Other: ${row.other_text}`);
    }

    const prompt = `
You are summarising anonymous 360 feedback for a team leader.
CRITICAL: Do not quote or closely paraphrase any individual comment.
Write a short, professional themes-based summary that cannot be used to identify authors.
Output in 3 sections:
1) Strength themes
2) Development themes
3) Practical suggestions (bullets)
Text:
${blocks.join("\n---\n")}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const summary = completion.choices?.[0]?.message?.content?.trim() || "No summary available.";
    res.json({ summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "ai_error" });
  }
});

// -------------------- Start --------------------

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Fatal startup error:", e);
    process.exit(1);
  });
