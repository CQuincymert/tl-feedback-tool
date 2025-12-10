// server.js
// Team Leader 360 feedback – Postgres (Neon) backend

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

const { OPENAI_API_KEY, ADMIN_PASSWORD, DATABASE_URL, PORT } = process.env;

// ---------- OpenAI (optional) ----------
let openai = null;
if (OPENAI_API_KEY) {
  const OpenAI = require("openai");
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ---------- Express setup ----------
const app = express();
const SERVER_PORT = PORT || 4000;
const MIN_COMMENTS_FOR_DISPLAY = 3;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serves index.html, admin.html, etc.

// ---------- Postgres / Neon ----------
if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL not set. The server will not be able to connect to Postgres.");
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Run at startup: ensure tables + seed TLs
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_leaders (
        id          SERIAL PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS codes (
        id             SERIAL PRIMARY KEY,
        code           TEXT UNIQUE NOT NULL,
        campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        team_leader_id TEXT NOT NULL,
        used           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        used_at        TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id             SERIAL PRIMARY KEY,
        campaign_id    TEXT NOT NULL,
        team_leader_id TEXT NOT NULL,
        scores_json    TEXT NOT NULL,
        overall_score  REAL NOT NULL,
        strengths_text TEXT,
        dev_text       TEXT,
        other_text     TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Seed default TLs (only if not already there)
    const defaultTLs = ["Gill", "Kristian", "Nicola", "Trish", "Teri", "Kate-Marie", "Katie"];
    for (const name of defaultTLs) {
      await client.query(
        `INSERT INTO team_leaders (name, active)
         VALUES ($1, TRUE)
         ON CONFLICT (name) DO UPDATE SET active = TRUE;`,
        [name]
      );
    }

    await client.query("COMMIT");
    console.log("Postgres schema initialised and default team leaders seeded.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error initialising DB:", err);
  } finally {
    client.release();
  }
}

initDb().catch((e) => console.error(e));

// ---------- Admin auth middleware ----------
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_PASSWORD) {
    console.warn("ADMIN_PASSWORD not set – admin endpoints are unprotected!");
    return next();
  }
  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------- Helper: random code ----------
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segment = () =>
    Array.from({ length: 4 })
      .map(() => chars[Math.floor(Math.random() * chars.length)])
      .join("");
  return `${segment()}-${segment()}`;
}

// ===================================================
//                    ADMIN API
// ===================================================

// List campaigns
app.get("/api/admin/campaigns", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, label, created_at
       FROM campaigns
       ORDER BY created_at DESC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error("Error /api/admin/campaigns:", err);
    res.status(500).json({ error: "DB error fetching campaigns." });
  }
});

// Create / update campaign
app.post("/api/admin/campaigns", adminAuth, async (req, res) => {
  const { campaignId, label } = req.body;
  if (!campaignId || !label) {
    return res.status(400).json({ error: "campaignId and label are required." });
  }
  try {
    await pool.query(
      `INSERT INTO campaigns (id, label)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label;`,
      [campaignId.trim(), label.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error POST /api/admin/campaigns:", err);
    res.status(500).json({ error: "DB error creating campaign." });
  }
});

// List team leaders
app.get("/api/admin/team-leaders", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, active
       FROM team_leaders
       ORDER BY name`
    );
    res.json({ teamLeaders: result.rows });
  } catch (err) {
    console.error("Error /api/admin/team-leaders:", err);
    res.status(500).json({ error: "DB error fetching team leaders." });
  }
});

// Add / reactivate TL
app.post("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    await pool.query(
      `INSERT INTO team_leaders (name, active)
       VALUES ($1, TRUE)
       ON CONFLICT (name) DO UPDATE SET active = TRUE;`,
      [name.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error POST /api/admin/team-leaders:", err);
    res.status(500).json({ error: "DB error updating team leader." });
  }
});

// Deactivate TL
app.delete("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    const result = await pool.query(
      `UPDATE team_leaders SET active = FALSE WHERE name = $1`,
      [name.trim()]
    );
    res.json({ ok: true, affectedRows: result.rowCount });
  } catch (err) {
    console.error("Error DELETE /api/admin/team-leaders:", err);
    res.status(500).json({ error: "DB error updating team leader." });
  }
});

// Overview per TL for a campaign
app.get("/api/admin/overview", adminAuth, async (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) return res.status(400).json({ error: "campaignId is required." });

  try {
    const result = await pool.query(
      `
      SELECT f.team_leader_id AS "teamLeaderId",
             COUNT(*)          AS "responseCount",
             AVG(f.overall_score)::float AS "avgScore"
      FROM feedback f
      WHERE f.campaign_id = $1
      GROUP BY f.team_leader_id
      ORDER BY f.team_leader_id;
      `,
      [campaignId]
    );
    res.json({ results: result.rows });
  } catch (err) {
    console.error("Error GET /api/admin/overview:", err);
    res.status(500).json({ error: "DB error fetching overview." });
  }
});

// Detail for TL + campaign
app.get("/api/admin/detail", adminAuth, async (req, res) => {
  const { campaignId, teamLeaderId } = req.query;
  if (!campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required." });
  }

  try {
    const result = await pool.query(
      `
      SELECT scores_json, overall_score, strengths_text, dev_text, other_text
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      ORDER BY created_at ASC;
      `,
      [campaignId, teamLeaderId]
    );

    const rows = result.rows;
    const responseCount = rows.length;

    if (!responseCount) {
      return res.json({
        responseCount: 0,
        avgOverall: null,
        questionAverages: {},
        comments: null,
      });
    }

    // Overall average
    const avgOverall =
      rows.reduce((sum, r) => sum + (r.overall_score || 0), 0) / responseCount;

    // Question averages
    const questionSums = {};
    const questionCounts = {};

    for (const row of rows) {
      if (!row.scores_json) continue;
      let scores;
      try {
        scores = JSON.parse(row.scores_json);
      } catch {
        continue;
      }
      Object.entries(scores).forEach(([qid, val]) => {
        const n = Number(val);
        if (!Number.isFinite(n)) return;
        questionSums[qid] = (questionSums[qid] || 0) + n;
        questionCounts[qid] = (questionCounts[qid] || 0) + 1;
      });
    }

    const questionAverages = {};
    Object.keys(questionSums).forEach((qid) => {
      questionAverages[qid] = questionSums[qid] / questionCounts[qid];
    });

    // Comments (only if enough responses)
    let comments = null;
    if (responseCount >= MIN_COMMENTS_FOR_DISPLAY) {
      comments = {
        strengths: rows
          .map((r) => (r.strengths_text || "").trim())
          .filter((t) => t.length > 0),
        devs: rows
          .map((r) => (r.dev_text || "").trim())
          .filter((t) => t.length > 0),
        others: rows
          .map((r) => (r.other_text || "").trim())
          .filter((t) => t.length > 0),
      };
    }

    res.json({
      responseCount,
      avgOverall,
      questionAverages,
      comments,
    });
  } catch (err) {
    console.error("Error GET /api/admin/detail:", err);
    res.status(500).json({ error: "DB error fetching detail." });
  }
});

// Delete all feedback for TL+campaign
app.post("/api/admin/delete-feedback", adminAuth, async (req, res) => {
  const { campaignId, teamLeaderId } = req.body;
  if (!campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required." });
  }

  try {
    const result = await pool.query(
      `DELETE FROM feedback WHERE campaign_id = $1 AND team_leader_id = $2`,
      [campaignId, teamLeaderId]
    );

    // Make all codes for that TL+campaign reusable
    await pool.query(
      `UPDATE codes
       SET used = FALSE, used_at = NULL
       WHERE campaign_id = $1 AND team_leader_id = $2`,
      [campaignId, teamLeaderId]
    );

    res.json({ ok: true, deletedRows: result.rowCount });
  } catch (err) {
    console.error("Error POST /api/admin/delete-feedback:", err);
    res.status(500).json({ error: "DB error deleting feedback." });
  }
});

// Generate feedback codes
app.post("/api/admin/generate-codes", adminAuth, async (req, res) => {
  const { campaignId, teamLeaderId, count } = req.body;
  if (!campaignId || !teamLeaderId || !count) {
    return res.status(400).json({ error: "campaignId, teamLeaderId and count required." });
  }

  const num = Math.max(1, Math.min(Number(count) || 1, 500));
  const codes = [];

  try {
    for (let i = 0; i < num; i++) {
      let code;
      let inserted = false;

      // retry until we get a unique code
      while (!inserted) {
        code = generateCode();
        try {
          await pool.query(
            `
            INSERT INTO codes (code, campaign_id, team_leader_id, used)
            VALUES ($1, $2, $3, FALSE);
            `,
            [code, campaignId, teamLeaderId]
          );
          inserted = true;
        } catch (err) {
          if (err.code === "23505") {
            // duplicate, try again
            continue;
          }
          throw err;
        }
      }
      codes.push(code);
    }

    res.json({ codes });
  } catch (err) {
    console.error("Error POST /api/admin/generate-codes:", err);
    res.status(500).json({ error: "DB error generating codes." });
  }
});

// AI summary of comments using OpenAI
app.get("/api/admin/ai-summary", adminAuth, async (req, res) => {
  const { campaignId, teamLeaderId } = req.query;
  if (!campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required." });
  }
  if (!openai) {
    return res.status(400).json({ error: "OpenAI key not configured." });
  }

  try {
    const result = await pool.query(
      `
      SELECT strengths_text, dev_text, other_text
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      ORDER BY created_at ASC;
      `,
      [campaignId, teamLeaderId]
    );

    if (!result.rowCount) {
      return res.status(400).json({ error: "No comments available yet." });
    }

    const strengths = [];
    const devs = [];
    const others = [];
    for (const row of result.rows) {
      if (row.strengths_text) strengths.push(row.strengths_text);
      if (row.dev_text) devs.push(row.dev_text);
      if (row.other_text) others.push(row.other_text);
    }

    const prompt = `
You are summarising anonymous 360° feedback for a team leader.
Do NOT quote or echo specific sentences, and do NOT include any identifying details.
Instead, describe overall themes in neutral language.

Strengths comments:
${strengths.join("\n\n")}

Development comments:
${devs.join("\n\n")}

Other comments:
${others.join("\n\n")}

Write a short, neutral summary (3–6 bullet points) that:
- highlights clear strengths
- neutrally describes development areas
- avoids any identifying detail or specific quotes.
`;

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    });

    const summary = resp.output[0].content[0].text.trim();
    res.json({ summary });
  } catch (err) {
    console.error("Error GET /api/admin/ai-summary:", err);
    res.status(500).json({ error: "Error generating AI summary." });
  }
});

// ===================================================
//                 PUBLIC QUESTIONNAIRE API
// ===================================================

// Current campaign for questionnaire header
app.get("/api/current-campaign", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, label
      FROM campaigns
      ORDER BY created_at DESC
      LIMIT 1;
      `
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "No active campaign configured." });
    }

    const row = result.rows[0];
    res.json({ campaignId: row.id, label: row.label });
  } catch (err) {
    console.error("Error GET /api/current-campaign:", err);
    res.status(500).json({ error: "DB error fetching current campaign." });
  }
});

// Shared logic for verifying a code
async function handleStartSession(req, res) {
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
      WHERE c.code = $1;
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
      ok: true,
      campaignId: row.campaign_id,
      teamLeaderId: row.team_leader_id,
      campaignLabel: row.campaign_label,
    });
  } catch (err) {
    console.error("Error verifying code:", err);
    res.status(500).json({ error: "Server error verifying code." });
  }
}

// Old path used by questionnaire JS
app.post("/api/start", (req, res) => {
  handleStartSession(req, res);
});

// Newer path, used by some admin/testing
app.post("/api/start-session", (req, res) => {
  handleStartSession(req, res);
});

// Submit feedback
app.post("/api/submit-feedback", async (req, res) => {
  const {
    code,
    campaignId,
    teamLeaderId,
    scores, // object: { q2: 5, q3: 4, ... }
    overallScore,
    strengthsText,
    devText,
    otherText,
  } = req.body;

  if (!code || !campaignId || !teamLeaderId || !scores) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    // verify code and mark used
    const codeResult = await pool.query(
      `SELECT id, used FROM codes WHERE code = $1 AND campaign_id = $2 AND team_leader_id = $3`,
      [code.trim(), campaignId, teamLeaderId]
    );
    if (!codeResult.rowCount) {
      return res.status(400).json({ error: "Invalid feedback code." });
    }
    const codeRow = codeResult.rows[0];
    if (codeRow.used) {
      return res.status(400).json({ error: "This code has already been used." });
    }

    // compute overall if not supplied
    let overall = Number(overallScore);
    if (!Number.isFinite(overall)) {
      const vals = Object.values(scores).map((v) => Number(v)).filter((n) => Number.isFinite(n));
      overall = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }

    await pool.query(
      `
      INSERT INTO feedback
        (campaign_id, team_leader_id, scores_json, overall_score,
         strengths_text, dev_text, other_text)
      VALUES ($1, $2, $3, $4, $5, $6, $7);
      `,
      [
        campaignId,
        teamLeaderId,
        JSON.stringify(scores),
        overall,
        strengthsText || null,
        devText || null,
        otherText || null,
      ]
    );

    await pool.query(`UPDATE codes SET used = TRUE, used_at = NOW() WHERE id = $1`, [
      codeRow.id,
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error("Error POST /api/submit-feedback:", err);
    res.status(500).json({ error: "Server error saving feedback." });
  }
});

// ---------- START SERVER ----------
app.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://localhost:${SERVER_PORT}`);
});
