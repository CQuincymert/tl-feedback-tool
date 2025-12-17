/**
 * TL 360 Feedback Tool (Render + Neon)
 * - Postgres schema is created/updated on startup (safe CREATE TABLE IF NOT EXISTS)
 * - campaigns.id is TEXT and is the ONLY campaign identifier everywhere
 * - /api/start-session returns sessionToken (JWT) bound to codeId + campaignId + teamLeaderId
 * - /api/submit-feedback accepts ONLY sessionToken + answers
 * - Admin supports cycles, TL list, code generation, overview/detail, delete responses, delete cycle
 * - AI summary endpoints optional (require OPENAI_API_KEY); otherwise they return helpful error
 *
 * IMPORTANT: Question IDs are q1..q15 (Never..Always scale). Category grouping updated accordingly.
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const {
  DATABASE_URL,
  ADMIN_PASSWORD,
  JWT_SECRET,
  OPENAI_API_KEY
} = process.env;

if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!ADMIN_PASSWORD) throw new Error("Missing ADMIN_PASSWORD");
if (!JWT_SECRET) throw new Error("Missing JWT_SECRET");

let openai = null;
if (OPENAI_API_KEY) {
  try {
    const OpenAI = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  } catch (e) {
    console.warn("OpenAI SDK not installed. AI features disabled. Run: npm i openai");
    openai = null;
  }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MIN_COMMENTS_FOR_DISPLAY = 3;

function safeText(v) {
  return (typeof v === "string" ? v : "").trim();
}
function safeUpper(v) {
  return safeText(v).toUpperCase();
}

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_PASSWORD) return res.status(401).json({ error: "unauthorized" });
  next();
}

function signSessionToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "2h" });
}
function verifySessionToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part()}-${part()}`;
}

/**
 * Category mapping MUST match the questionnaire:
 *
 * Leadership & Management
 * 1..3 => q1 q2 q3
 * Communication
 * 4..6 => q4 q5 q6
 * Team Support & Development
 * 7..9 => q7 q8 q9
 * Collaboration & Culture
 * 10..12 => q10 q11 q12
 * Execution & Accountability
 * 13..15 => q13 q14 q15
 */
const QUESTION_GROUPS = {
  "Leadership & Management": ["q1", "q2", "q3"],
  "Communication": ["q4", "q5", "q6"],
  "Team Support & Development": ["q7", "q8", "q9"],
  "Collaboration & Culture": ["q10", "q11", "q12"],
  "Execution & Accountability": ["q13", "q14", "q15"]
};

function computeCategoryAverages(questionAverages) {
  const out = {};
  for (const [cat, qids] of Object.entries(QUESTION_GROUPS)) {
    let sum = 0;
    let n = 0;
    for (const qid of qids) {
      const v = Number(questionAverages[qid]);
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        n++;
      }
    }
    out[cat] = n ? sum / n : null;
  }
  return out;
}

function interpretScore(score) {
  if (score == null || !Number.isFinite(Number(score))) return { label: "No data", band: "nodata" };
  const s = Number(score);
  if (s >= 4.25) return { label: "Very strong", band: "good" };
  if (s >= 3.75) return { label: "Strong", band: "good" };
  if (s >= 3.25) return { label: "Generally positive", band: "mixed" };
  if (s >= 3.0) return { label: "Mixed", band: "mixed" };
  return { label: "Needs improvement", band: "bad" };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_leaders (
      id TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      team_leader_id TEXT NOT NULL REFERENCES team_leaders(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      used_at TIMESTAMP NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      team_leader_id TEXT NOT NULL REFERENCES team_leaders(id) ON DELETE CASCADE,
      scores_json JSONB NOT NULL,
      overall_score NUMERIC NOT NULL,
      strengths_text TEXT,
      dev_text TEXT,
      other_text TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  // Seed TLs if empty
  const tlCount = await pool.query(`SELECT COUNT(*)::int AS c FROM team_leaders;`);
  if (tlCount.rows[0].c === 0) {
    const seed = ["Gill", "Kristian", "Nicola", "Teri", "Trish", "Kate-Marie", "Katie"];
    for (const name of seed) {
      await pool.query(
        `INSERT INTO team_leaders (id, active) VALUES ($1, true) ON CONFLICT (id) DO NOTHING;`,
        [name]
      );
    }
    console.log("Seeded default team leaders.");
  }

  console.log("Postgres schema initialised.");
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1;");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// -----------------------------
// PUBLIC API (Questionnaire)
// -----------------------------

app.post("/api/start-session", async (req, res) => {
  const code = safeUpper(req.body?.code);
  if (!code) return res.status(400).json({ error: "Code is required." });

  try {
    const r = await pool.query(
      `
      SELECT id, used, campaign_id, team_leader_id
      FROM codes
      WHERE UPPER(TRIM(code)) = $1
      LIMIT 1
      `,
      [code]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Invalid code." });
    const row = r.rows[0];
    if (row.used) return res.status(409).json({ error: "This code has already been used." });

    const sessionToken = signSessionToken({
      codeId: row.id,
      campaignId: row.campaign_id,
      teamLeaderId: row.team_leader_id
    });

    res.json({ ok: true, sessionToken });
  } catch (e) {
    console.error("Error in /api/start-session:", e);
    res.status(500).json({ error: "Server error verifying code." });
  }
});

app.post("/api/submit-feedback", async (req, res) => {
  const sessionToken = safeText(req.body?.sessionToken);
  const scores = req.body?.scores || null;
  const strengthsText = safeText(req.body?.strengthsText);
  const devText = safeText(req.body?.devText);
  const otherText = safeText(req.body?.otherText);

  if (!sessionToken) return res.status(400).json({ error: "Missing sessionToken." });
  if (!scores || typeof scores !== "object") return res.status(400).json({ error: "Missing scores." });

  // Require written answers (as per your current UI)
  if (!strengthsText || !devText || !otherText) {
    return res.status(400).json({ error: "Please complete all written questions before submitting." });
  }

  let payload;
  try {
    payload = verifySessionToken(sessionToken);
  } catch {
    return res.status(401).json({ error: "Session expired. Please click Start over and re-enter your code." });
  }

  const { codeId, campaignId, teamLeaderId } = payload || {};
  if (!codeId || !campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "Invalid session. Please start over." });
  }

  const values = Object.values(scores).map(Number).filter(v => Number.isFinite(v));
  if (!values.length) return res.status(400).json({ error: "Scores incomplete." });
  const overall = values.reduce((a, b) => a + b, 0) / values.length;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const codeRow = await client.query(
      `SELECT used FROM codes WHERE id = $1 FOR UPDATE`,
      [codeId]
    );

    if (!codeRow.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid code session." });
    }
    if (codeRow.rows[0].used) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This code has already been used." });
    }

    await client.query(
      `
      INSERT INTO feedback (campaign_id, team_leader_id, scores_json, overall_score, strengths_text, dev_text, other_text)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [campaignId, teamLeaderId, JSON.stringify(scores), overall, strengthsText, devText, otherText]
    );

    await client.query(
      `UPDATE codes SET used = true, used_at = now() WHERE id = $1`,
      [codeId]
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

// -----------------------------
// ADMIN API
// -----------------------------

app.get("/api/admin/campaigns", adminAuth, async (req, res) => {
  const r = await pool.query(`SELECT id, label, created_at FROM campaigns ORDER BY created_at DESC;`);
  res.json({ campaigns: r.rows });
});

app.post("/api/admin/campaigns", adminAuth, async (req, res) => {
  const id = safeText(req.body?.campaignId);
  const label = safeText(req.body?.label);
  if (!id || !label) return res.status(400).json({ error: "campaignId and label required" });

  try {
    await pool.query(
      `INSERT INTO campaigns (id, label) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`,
      [id, label]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Error creating campaign:", e);
    res.status(500).json({ error: "DB error creating cycle." });
  }
});

app.post("/api/admin/delete-cycle", adminAuth, async (req, res) => {
  const campaignId = safeText(req.body?.campaignId);
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  try {
    const r = await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error("Error deleting cycle:", e);
    res.status(500).json({ error: "DB error deleting cycle." });
  }
});

// Team Leaders
app.get("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const r = await pool.query(`SELECT id, active FROM team_leaders ORDER BY id ASC;`);
  res.json({ teamLeaders: r.rows });
});

app.post("/api/admin/team-leaders", adminAuth, async (req, res) => {
  const name = safeText(req.body?.name);
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    await pool.query(
      `INSERT INTO team_leaders (id, active) VALUES ($1, true)
       ON CONFLICT (id) DO UPDATE SET active = true`,
      [name]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Error upserting TL:", e);
    res.status(500).json({ error: "DB error saving TL." });
  }
});

app.post("/api/admin/team-leaders/deactivate", adminAuth, async (req, res) => {
  const name = safeText(req.body?.name);
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    const r = await pool.query(`UPDATE team_leaders SET active = false WHERE id = $1`, [name]);
    res.json({ ok: true, affected: r.rowCount });
  } catch (e) {
    console.error("Error deactivating TL:", e);
    res.status(500).json({ error: "DB error updating TL." });
  }
});

app.post("/api/admin/team-leaders/delete", adminAuth, async (req, res) => {
  const name = safeText(req.body?.name);
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    const r = await pool.query(`DELETE FROM team_leaders WHERE id = $1`, [name]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error("Error deleting TL:", e);
    res.status(500).json({ error: "DB error deleting TL." });
  }
});

// Generate codes
app.post("/api/admin/generate-codes", adminAuth, async (req, res) => {
  const campaignId = safeText(req.body?.campaignId);
  const teamLeaderId = safeText(req.body?.teamLeaderId);
  const count = Number(req.body?.count || 0);

  if (!campaignId || !teamLeaderId || !Number.isFinite(count) || count < 1 || count > 500) {
    return res.status(400).json({ error: "campaignId, teamLeaderId, count required" });
  }

  try {
    const c = await pool.query(`SELECT 1 FROM campaigns WHERE id = $1`, [campaignId]);
    if (!c.rowCount) return res.status(400).json({ error: "Campaign not found" });

    const tl = await pool.query(`SELECT 1 FROM team_leaders WHERE id = $1 AND active = true`, [teamLeaderId]);
    if (!tl.rowCount) return res.status(400).json({ error: "Team leader not found / inactive" });

    const codes = [];
    for (let i = 0; i < count; i++) codes.push(randomCode());

    const vals = [];
    const params = [];
    let p = 1;
    for (const code of codes) {
      vals.push(`($${p++}, $${p++}, $${p++})`);
      params.push(code, teamLeaderId, campaignId);
    }

    await pool.query(
      `INSERT INTO codes (code, team_leader_id, campaign_id) VALUES ${vals.join(", ")}`,
      params
    );

    res.json({ ok: true, codes });
  } catch (e) {
    console.error("Error generating codes:", e);
    res.status(500).json({ error: "DB error generating codes." });
  }
});

// Overview by TL for a cycle
app.get("/api/admin/overview", adminAuth, async (req, res) => {
  const campaignId = safeText(req.query?.campaignId);
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  try {
    const cam = await pool.query(`SELECT id, label FROM campaigns WHERE id = $1`, [campaignId]);
    if (!cam.rowCount) return res.status(404).json({ error: "Cycle not found." });

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
      [campaignId]
    );

    res.json({
      campaign: cam.rows[0],
      results: r.rows.map(row => ({
        teamLeaderId: row.teamLeaderId,
        responseCount: row.responseCount,
        avgScore: Number(row.avgScore || 0)
      }))
    });
  } catch (e) {
    console.error("Error in /api/admin/overview:", e);
    res.status(500).json({ error: "DB error loading overview." });
  }
});

// Detail for TL+cycle
app.get("/api/admin/detail", adminAuth, async (req, res) => {
  const campaignId = safeText(req.query?.campaignId);
  const teamLeaderId = safeText(req.query?.teamLeaderId);
  if (!campaignId || !teamLeaderId) return res.status(400).json({ error: "campaignId and teamLeaderId required" });

  try {
    const cam = await pool.query(`SELECT id, label FROM campaigns WHERE id = $1`, [campaignId]);
    if (!cam.rowCount) return res.status(404).json({ error: "Cycle not found." });

    const r = await pool.query(
      `
      SELECT scores_json, overall_score, strengths_text, dev_text, other_text, created_at
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      ORDER BY created_at DESC
      `,
      [campaignId, teamLeaderId]
    );

    const responseCount = r.rowCount;

    const sums = {};
    const counts = {};
    let overallSum = 0;

    for (const row of r.rows) {
      overallSum += Number(row.overall_score);
      const scores = row.scores_json || {};
      for (const [qid, val] of Object.entries(scores)) {
        const n = Number(val);
        if (!Number.isFinite(n)) continue;
        sums[qid] = (sums[qid] || 0) + n;
        counts[qid] = (counts[qid] || 0) + 1;
      }
    }

    const questionAverages = {};
    for (const qid of Object.keys(sums)) {
      questionAverages[qid] = sums[qid] / (counts[qid] || 1);
    }

    const avgOverall = responseCount ? overallSum / responseCount : null;

    let comments = null;
    if (responseCount >= MIN_COMMENTS_FOR_DISPLAY) {
      const strengths = r.rows.map(x => safeText(x.strengths_text)).filter(Boolean);
      const devs = r.rows.map(x => safeText(x.dev_text)).filter(Boolean);
      const others = r.rows.map(x => safeText(x.other_text)).filter(Boolean);
      comments = { strengths, devs, others };
    }

    const catScores = computeCategoryAverages(questionAverages);
    const catEntries = Object.entries(catScores).filter(([_, v]) => v != null);
    catEntries.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0)); // weakest first
    const actionAreas = catEntries.slice(0, 2).map(([cat, v]) => ({
      category: cat,
      avg: v,
      interpretation: interpretScore(v).label
    }));

    res.json({
      campaign: cam.rows[0],
      teamLeaderId,
      responseCount,
      avgOverall,
      questionAverages,
      categoryAverages: catScores,
      actionAreas,
      comments
    });
  } catch (e) {
    console.error("Error in /api/admin/detail:", e);
    res.status(500).json({ error: "DB error loading detail." });
  }
});

// Delete all feedback for TL in a cycle (testing cleanup)
app.post("/api/admin/delete-feedback", adminAuth, async (req, res) => {
  const campaignId = safeText(req.body?.campaignId);
  const teamLeaderId = safeText(req.body?.teamLeaderId);
  if (!campaignId || !teamLeaderId) return res.status(400).json({ error: "campaignId and teamLeaderId required" });

  try {
    const r = await pool.query(
      `DELETE FROM feedback WHERE campaign_id = $1 AND team_leader_id = $2`,
      [campaignId, teamLeaderId]
    );
    res.json({ ok: true, deletedRows: r.rowCount });
  } catch (e) {
    console.error("Error deleting feedback:", e);
    res.status(500).json({ error: "DB error deleting feedback." });
  }
});

// -----------------------------
// AI summaries (Manager + TL)
// -----------------------------

async function aiGenerateText(prompt) {
  // Using OpenAI Responses API (same as your current approach)
  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt
  });
  return resp.output_text?.trim() || "No AI output.";
}

function buildManagerPrompt({ teamLeaderId, campaignId, strengths, devs, others }) {
  return `
You are summarising anonymous 360 feedback comments for a team leader to help managers decide actions.
Important rules:
- DO NOT include anything that could identify individuals (no names, no unique incidents, no exact quotes).
- Paraphrase into themes only.
- UK English.
- If there are very few comments, state that insights are limited.

Output format:
Strengths (themes):
- ...
Development (themes):
- ...
Other notes (themes):
- ...

Suggested actions (3):
1) ...
2) ...
3) ...

Context:
Team Leader: ${teamLeaderId}
Cycle: ${campaignId}

Comments:
Strengths:
${strengths.map(s => `- ${s}`).join("\n")}

Development:
${devs.map(s => `- ${s}`).join("\n")}

Other:
${others.map(s => `- ${s}`).join("\n")}
`.trim();
}

function buildTlPrompt({ teamLeaderId, campaignId, strengths, devs, others }) {
  return `
Write a TL-facing feedback message as a SINGLE block of text (no headings, no bullets).
Tone: supportive, professional, motivating, not HR-jargon.
Important rules:
- DO NOT include anything that could identify individuals (no names, no unique incidents, no exact quotes).
- Do not mention managers or "actions for managers".
- Do not include numeric scores or averages.
- Focus on themes of observable behaviours.
Length: ~140–220 words.
UK English.

Context:
Team Leader: ${teamLeaderId}
Cycle: ${campaignId}

Anonymous comment themes source (do not quote directly):
Strengths:
${strengths.map(s => `- ${s}`).join("\n")}

Development:
${devs.map(s => `- ${s}`).join("\n")}

Other:
${others.map(s => `- ${s}`).join("\n")}
`.trim();
}

// Returns BOTH summaries. Keeps `summary` for backward compatibility (manager summary).
app.get("/api/admin/ai-summary", adminAuth, async (req, res) => {
  if (!openai) {
    return res.status(400).json({
      error: "AI is not configured on the server (missing OPENAI_API_KEY or openai package)."
    });
  }

  const campaignId = safeText(req.query?.campaignId);
  const teamLeaderId = safeText(req.query?.teamLeaderId);
  if (!campaignId || !teamLeaderId) {
    return res.status(400).json({ error: "campaignId and teamLeaderId required" });
  }

  try {
    const r = await pool.query(
      `
      SELECT strengths_text, dev_text, other_text
      FROM feedback
      WHERE campaign_id = $1 AND team_leader_id = $2
      ORDER BY created_at DESC
      `,
      [campaignId, teamLeaderId]
    );

    if (r.rowCount < MIN_COMMENTS_FOR_DISPLAY) {
      const msg = `AI summary hidden until ${MIN_COMMENTS_FOR_DISPLAY}+ responses to protect anonymity.`;
      return res.json({
        summary: msg,             // keep existing field
        managerSummary: msg,
        tlSummary: msg
      });
    }

    const strengths = r.rows.map(x => safeText(x.strengths_text)).filter(Boolean);
    const devs = r.rows.map(x => safeText(x.dev_text)).filter(Boolean);
    const others = r.rows.map(x => safeText(x.other_text)).filter(Boolean);

    const managerPrompt = buildManagerPrompt({ teamLeaderId, campaignId, strengths, devs, others });
    const tlPrompt = buildTlPrompt({ teamLeaderId, campaignId, strengths, devs, others });

    const managerSummary = await aiGenerateText(managerPrompt);
    const tlSummary = await aiGenerateText(tlPrompt);

    // `summary` kept so your current admin UI still works with no changes.
    res.json({
      summary: managerSummary,
      managerSummary,
      tlSummary
    });
  } catch (e) {
    console.error("AI summary error:", e);
    res.status(500).json({ error: "AI summary failed." });
  }
});

// -----------------------------
// Compare any two cycles for a TL (numbers + optional AI change summary)
// -----------------------------
app.get("/api/admin/compare", adminAuth, async (req, res) => {
  const teamLeaderId = safeText(req.query?.teamLeaderId);
  const fromCycle = safeText(req.query?.fromCycle);
  const toCycle = safeText(req.query?.toCycle);
  const includeAi = safeText(req.query?.includeAi) === "1";

  if (!teamLeaderId || !fromCycle || !toCycle) {
    return res.status(400).json({ error: "teamLeaderId, fromCycle, toCycle required" });
  }

  try {
    const getAgg = async (cycleId) => {
      const r = await pool.query(
        `
        SELECT scores_json, overall_score
        FROM feedback
        WHERE campaign_id = $1 AND team_leader_id = $2
        `,
        [cycleId, teamLeaderId]
      );

      const responseCount = r.rowCount;
      if (!responseCount) {
        return {
          cycleId,
          responseCount: 0,
          avgOverall: null,
          questionAverages: {},
          categoryAverages: computeCategoryAverages({})
        };
      }

      const sums = {};
      const counts = {};
      let overallSum = 0;

      for (const row of r.rows) {
        overallSum += Number(row.overall_score);
        const scores = row.scores_json || {};
        for (const [qid, val] of Object.entries(scores)) {
          const n = Number(val);
          if (!Number.isFinite(n)) continue;
          sums[qid] = (sums[qid] || 0) + n;
          counts[qid] = (counts[qid] || 0) + 1;
        }
      }

      const questionAverages = {};
      for (const qid of Object.keys(sums)) {
        questionAverages[qid] = sums[qid] / (counts[qid] || 1);
      }

      const avgOverall = overallSum / responseCount;
      const categoryAverages = computeCategoryAverages(questionAverages);

      return { cycleId, responseCount, avgOverall, questionAverages, categoryAverages };
    };

    const fromAgg = await getAgg(fromCycle);
    const toAgg = await getAgg(toCycle);

    const deltas = {};
    for (const cat of Object.keys(QUESTION_GROUPS)) {
      const a = fromAgg.categoryAverages[cat];
      const b = toAgg.categoryAverages[cat];
      deltas[cat] = (a == null || b == null) ? null : (b - a);
    }
    const overallDelta =
      (fromAgg.avgOverall == null || toAgg.avgOverall == null) ? null : (toAgg.avgOverall - fromAgg.avgOverall);

    let aiChangeSummary = null;
    if (includeAi) {
      if (!openai) {
        aiChangeSummary = "AI is not configured on the server (missing OPENAI_API_KEY or openai package).";
      } else {
        const prompt = `
You are comparing two 360 feedback cycles for the same team leader.
Summarise changes as themes, without identifying individuals.
Be honest if data is thin. UK English.

Return:
- What improved
- What declined
- What stayed similar
- Suggested focus actions (3)

Data:
FROM cycle ${fromCycle} (responses ${fromAgg.responseCount})
Overall avg: ${fromAgg.avgOverall ?? "n/a"}
Category avgs: ${JSON.stringify(fromAgg.categoryAverages, null, 2)}

TO cycle ${toCycle} (responses ${toAgg.responseCount})
Overall avg: ${toAgg.avgOverall ?? "n/a"}
Category avgs: ${JSON.stringify(toAgg.categoryAverages, null, 2)}

Deltas: ${JSON.stringify({ overallDelta, deltas }, null, 2)}
`.trim();

        const resp = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: prompt
        });
        aiChangeSummary = resp.output_text?.trim() || "No AI output.";
      }
    }

    res.json({
      teamLeaderId,
      from: fromAgg,
      to: toAgg,
      overallDelta,
      deltas,
      aiChangeSummary
    });
  } catch (e) {
    console.error("Compare error:", e);
    res.status(500).json({ error: "DB error comparing cycles." });
  }
});

// -----------------------------
// Start server
// -----------------------------
const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
