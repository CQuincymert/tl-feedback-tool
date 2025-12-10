// server.js - Neon/Postgres version

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

// Env vars
const {
  PORT: ENV_PORT,
  ADMIN_PASSWORD,
  OPENAI_API_KEY,
  DATABASE_URL,
} = process.env;

const PORT = ENV_PORT || 4000;
const MIN_COMMENTS_FOR_DISPLAY = 3;

if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is not set. Neon/Postgres will not work.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
});

// Optional OpenAI client
let openai = null;
if (OPENAI_API_KEY) {
  const OpenAI = require("openai");
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serves index.html, admin.html, etc.

// ---------- DB INIT (Postgres / Neon) ----------

async function initDb() {
  // campaigns
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // team_leaders
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_leaders (
      name TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // codes (anonymous passcodes)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      team_leader_id TEXT NOT NULL REFERENCES team_leaders(name),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      used BOOLEAN NOT NULL DEFAULT FALSE,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // feedback responses
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL REFERENCES codes(code),
      campaign_id TEXT NOT NULL,
      team_leader_id TEXT NOT NULL,
      q2 INTEGER,
      q3 INTEGER,
      q4 INTEGER,
      q5 INTEGER,
      q6 INTEGER,
      q7 INTEGER,
      q8 INTEGER,
      q9 INTEGER,
      q10 INTEGER,
      q11 INTEGER,
      q12 INTEGER,
      q13 INTEGER,
      q14 INTEGER,
      q15 INTEGER,
      q16 INTEGER,
      overall_score NUMERIC,
      strengths_text TEXT,
      dev_text TEXT,
      other_text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("Postgres schema initialised");
}

// ---------- HELPER FUNCTIONS ----------

function randomCode() {
  // short anonymous code, e.g. R7KM-3ZPD
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 9; i++) {
    if (i === 4) out += "-";
    else out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function calcOverallScore(scores) {
  const nums = Object.values(scores)
    .map(Number)
    .filter((n) => !isNaN(n));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length;
}

// Admin auth middleware
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD not configured on server." });
  }
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ---------- PUBLIC API (users filling questionnaire) ----------

// GET /api/current-campaign
// Returns the most recently created campaign as the "current" one
app.get("/api/current-campaign", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, label
      FROM campaigns
      ORDER BY created_at DESC
      LIMIT 1
      `
    );

    if (!result.rowCount) {
      // No campaign yet – questionnaire can show a nice message
      return res.status(404).json({ error: "No active campaign configured." });
    }

    const row = result.rows[0];
    res.json({
      campaignId: row.id,
      label: row.label,
    });
  } catch (err) {
    console.error("Error in /api/current-campaign:", err);
    res.status(500).json({ error: "DB error fetching current campaign." });
  }
});


// POST /api/start-session { code }
app.post("/api/start-session", async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Code is required." });
  }

  try {
    const result = await pool.query(
      `
      SELECT c.code, c.campaign_id, c.team_leader_id, c.used,
             cam.label AS campaign_label
      FROM codes c
      JOIN campaigns cam ON cam.id = c.campaign_id
      WHERE c.code = $1
      `,
      [code.trim()]
    );

    if (!result.rowCount) {
      return res.status(400).json({ error: "Code not found." });
    }

    const row = result.rows[0];
    if (row.used) {
      return res.status(400).json({ error: "This code has already been used." });
    }

    res.json({
      code: row.code,
      campaignId: row.campaign_id,
      campaignLabel: row.campaign_label,
      teamLeaderId: row.team_leader_id,
    });
  } catch (err) {
    console.error("Error in /api/start-session:", err);
    res.status(500).json({ error: "Server error verifying code." });
  }
});

// POST /api/submit-feedback
// body: { code, campaignId, teamLeaderId, scores: {q2..q16}, strengthsText, devText, otherText }
app.post("/api/submit-feedback", async (req, res) => {
  const {
    code,
    campaignId,
    teamLeaderId,
    scores = {},
    strengthsText,
    devText,
    otherText,
  } = req.body;

  if (!code || !campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const overall = calcOverallScore(scores);

  try {
    // ensure code exists and not used
    const cRes = await pool.query(
      "SELECT id, used FROM codes WHERE code = $1",
      [code.trim()]
    );
    if (!cRes.rowCount) {
      return res.status(400).json({ error: "Invalid code." });
    }
    if (cRes.rows[0].used) {
      return res.status(400).json({ error: "Code already used." });
    }

    await pool.query("BEGIN");

    // insert feedback
    await pool.query(
      `
      INSERT INTO feedback (
        code, campaign_id, team_leader_id,
        q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12, q13, q14, q15, q16,
        overall_score,
        strengths_text, dev_text, other_text
      )
      VALUES (
        $1, $2, $3,
        $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19,
        $20, $21, $22
      )
      `,
      [
        code.trim(),
        campaignId,
        teamLeaderId,
        scores.q2,
        scores.q3,
        scores.q4,
        scores.q5,
        scores.q6,
        scores.q7,
        scores.q8,
        scores.q9,
        scores.q10,
        scores.q11,
        scores.q12,
        scores.q13,
        scores.q14,
        scores.q15,
        scores.q16,
        overall,
        strengthsText || null,
        devText || null,
        otherText || null,
      ]
    );

    // mark code as used
    await pool.query(
      "UPDATE codes SET used = TRUE, used_at = NOW() WHERE code = $1",
      [code.trim()]
    );

    await pool.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Error in /api/submit-feedback:", err);
    res.status(500).json({ error: "Error saving feedback." });
  }
});

// ---------- ADMIN API ----------

// Get campaigns list
app.get("/api/admin/campaigns", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, label FROM campaigns ORDER BY created_at DESC"
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error("Error /api/admin/campaigns:", err);
    res.status(500).json({ error: "DB error fetching campaigns." });
  }
});

// Create a new campaign
app.post("/api/admin/campaigns", adminAuth, async (req, res) => {
  const { campaignId, label } = req.body;
  if (!campaignId || !label) {
    return res.status(400).json({ error: "campaignId and label required." });
  }

  try {
    await pool.query(
      `
      INSERT INTO campaigns (id, label)
      VALUES ($1, $2)
      ON CONFLICT (id) DO NOTHING
      `,
      [campaignId.trim(), label.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error POST /api/admin/campaigns:", err);
    res.status(500).json({ error: "DB error creating campaign." });
  }
});

// Team leaders list
app.get("/api/admin/team-leaders", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name FROM team_leaders WHERE active = TRUE ORDER BY name"
    );
    res.json({ teamLeaders: result.rows.map((r) => r.name) });
  } catch (err) {
    console.error("Error /api/admin/team-leaders GET:", err);
    res.status(500).json({ error: "DB error fetching TLs." });
  }
});

// Add/reactivate TL
app.post("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required." });

  try {
    await pool.query(
      `
      INSERT INTO team_leaders (name, active)
      VALUES ($1, TRUE)
      ON CONFLICT (name) DO UPDATE SET active = TRUE
      `,
      [name.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error POST /api/admin/team-leaders:", err);
    res.status(500).json({ error: "DB error upserting TL." });
  }
});

// Deactivate TL
app.delete("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required." });

  try {
    const result = await pool.query(
      "UPDATE team_leaders SET active = FALSE WHERE name = $1",
      [name.trim()]
    );
    res.json({ ok: true, affectedRows: result.rowCount });
  } catch (err) {
    console.error("Error DELETE /api/admin/team-leaders:", err);
    res.status(500).json({ error: "DB error deactivating TL." });
  }
});

// Generate codes
app.post("/api/admin/generate-codes", adminAuth, async (req, res) => {
  const { campaignId, teamLeaderId, count } = req.body;
  if (!campaignId || !teamLeaderId || !count) {
    return res.status(400).json({ error: "Missing fields." });
  }
  const n = Math.max(1, Math.min(Number(count) || 1, 500));

  try {
    const codes = [];
    await pool.query("BEGIN");

    for (let i = 0; i < n; i++) {
      let code;
      let inserted = false;
      while (!inserted) {
        code = randomCode();
        try {
          await pool.query(
            `
            INSERT INTO codes (code, team_leader_id, campaign_id)
            VALUES ($1, $2, $3)
            `,
            [code, teamLeaderId.trim(), campaignId.trim()]
          );
          inserted = true;
        } catch (e) {
          // collision -> retry
        }
      }
      codes.push(code);
    }

    await pool.query("COMMIT");
    res.json({ codes });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Error /api/admin/generate-codes:", err);
    res.status(500).json({ error: "Error generating codes." });
  }
});

// Overview for a campaign
app.get("/api/admin/overview", adminAuth, async (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) {
    return res.status(400).json({ error: "campaignId required." });
  }

  try {
    const result = await pool.query(
      `
      SELECT team_leader_id,
             COUNT(*) AS response_count,
             AVG(overall_score) AS avg_score
      FROM feedback
      WHERE campaign_id = $1
      GROUP BY team_leader_id
      ORDER BY team_leader_id
      `,
      [campaignId]
    );

    const rows = result.rows.map((r) => ({
      teamLeaderId: r.team_leader_id,
      responseCount: Number(r.response_count),
      avgScore: r.avg_score ? Number(r.avg_score) : null,
    }));

    res.json({ results: rows });
  } catch (err) {
    console.error("Error /api/admin/overview:", err);
    res.status(500).json({ error: "DB error fetching overview." });
  }
});

// Detail for TL in campaign
app.get("/api/admin/detail", adminAuth, async (req, res) => {
  const { campaignId, teamLeaderId } = req.query;
  if (!campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required." });
  }

  try {
    const base = await pool.query(
      `
      SELECT
        COUNT(*) AS response_count,
        AVG(overall_score) AS avg_overall,
        AVG(q2) AS q2,  AVG(q3) AS q3,  AVG(q4) AS q4,
        AVG(q5) AS q5,  AVG(q6) AS q6,  AVG(q7) AS q7,
        AVG(q8) AS q8,  AVG(q9) AS q9,  AVG(q10) AS q10,
        AVG(q11) AS q11,AVG(q12) AS q12,AVG(q13) AS q13,
        AVG(q14) AS q14,AVG(q15) AS q15,AVG(q16) AS q16
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      `,
      [campaignId, teamLeaderId]
    );

    const row = base.rows[0];
    const responseCount = Number(row.response_count) || 0;

    const questionAverages = {};
    for (let q = 2; q <= 16; q++) {
      const key = "q" + q;
      const value = row[key];
      questionAverages[key] = value != null ? Number(value) : null;
    }

    let comments = null;
    if (responseCount >= MIN_COMMENTS_FOR_DISPLAY) {
      const cRes = await pool.query(
        `
        SELECT strengths_text, dev_text, other_text
        FROM feedback
        WHERE campaign_id = $1 AND team_leader_id = $2
        ORDER BY created_at
        `,
        [campaignId, teamLeaderId]
      );

      const strengths = [];
      const devs = [];
      const others = [];

      for (const c of cRes.rows) {
        if (c.strengths_text) strengths.push(c.strengths_text);
        if (c.dev_text) devs.push(c.dev_text);
        if (c.other_text) others.push(c.other_text);
      }

      comments = { strengths, devs, others };
    }

    res.json({
      responseCount,
      avgOverall: row.avg_overall != null ? Number(row.avg_overall) : null,
      questionAverages,
      comments,
    });
  } catch (err) {
    console.error("Error /api/admin/detail:", err);
    res.status(500).json({ error: "DB error fetching detail." });
  }
});

// AI summary of comments
app.get("/api/admin/ai-summary", adminAuth, async (req, res) => {
  if (!openai) {
    return res.status(500).json({ error: "OpenAI not configured on server." });
  }

  const { campaignId, teamLeaderId } = req.query;
  if (!campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required." });
  }

  try {
    const result = await pool.query(
      `
      SELECT strengths_text, dev_text, other_text
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      `,
      [campaignId, teamLeaderId]
    );

    if (!result.rowCount || result.rowCount < MIN_COMMENTS_FOR_DISPLAY) {
      return res.status(400).json({
        error: `Not enough responses to generate an AI summary (need at least ${MIN_COMMENTS_FOR_DISPLAY}).`,
      });
    }

    const parts = [];
    for (const r of result.rows) {
      if (r.strengths_text) parts.push("Strengths: " + r.strengths_text);
      if (r.dev_text) parts.push("Development: " + r.dev_text);
      if (r.other_text) parts.push("Other: " + r.other_text);
    }

    const prompt = `
You are helping summarise anonymous 360° feedback for a team leader.
You will receive multiple short text comments across strengths, development areas, and other notes.

Your job:
- Identify 3–5 key positive themes
- Identify 3–5 key development themes
- Keep wording broad enough that no individual comment is recognisable
- Do NOT quote or paraphrase any single comment directly
- Keep it neutral, constructive, and suitable to paste into a feedback report.

Comments:
${parts.join("\n")}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You summarise patterns in feedback without exposing individual comments." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const summary = completion.choices[0].message.content.trim();
    res.json({ summary });
  } catch (err) {
    console.error("Error /api/admin/ai-summary:", err);
    res.status(500).json({ error: "Error generating AI summary." });
  }
});

// Delete feedback for TL in a campaign
app.post("/api/admin/delete-feedback", adminAuth, async (req, res) => {
  const { campaignId, teamLeaderId } = req.body;
  if (!campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required." });
  }

  try {
    await pool.query("BEGIN");
    const fbRes = await pool.query(
      `
      DELETE FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      RETURNING code
      `,
      [campaignId, teamLeaderId]
    );
    const deletedRows = fbRes.rowCount;

    // optionally free up codes again
    const codesToReset = fbRes.rows.map((r) => r.code);
    if (codesToReset.length) {
      await pool.query(
        `
        UPDATE codes
        SET used = FALSE, used_at = NULL
        WHERE code = ANY($1::text[])
        `,
        [codesToReset]
      );
    }

    await pool.query("COMMIT");
    res.json({ ok: true, deletedRows });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Error /api/admin/delete-feedback:", err);
    res.status(500).json({ error: "Error deleting feedback." });
  }
});

// ---------- START SERVER ----------

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize DB", err);
    process.exit(1);
  });
