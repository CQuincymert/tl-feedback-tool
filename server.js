const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
require("dotenv").config();

const { OPENAI_API_KEY, ADMIN_PASSWORD } = process.env;

// Optional OpenAI client (only used if key present)
let openai = null;
if (OPENAI_API_KEY) {
  const OpenAI = require("openai");
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

const app = express();
const PORT = process.env.PORT || 4000;
const DB_PATH = path.join(__dirname, "feedback.db");

// Minimum number of responses before showing comments
const MIN_COMMENTS_FOR_DISPLAY = 3;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serves index.html, admin.html etc.

// ---------- DB SETUP ----------
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // Codes table: which code belongs to which TL + campaign
  db.run(`CREATE TABLE IF NOT EXISTS codes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    teamLeaderId TEXT NOT NULL,
    campaignId   TEXT NOT NULL,
    used         INTEGER NOT NULL DEFAULT 0,
    createdAt    TEXT NOT NULL DEFAULT (datetime('now')),
    usedAt       TEXT
  );`);

  // Feedback responses
  db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    campaignId    TEXT NOT NULL,
    teamLeaderId  TEXT NOT NULL,
    scoresJson    TEXT NOT NULL,
    overallScore  REAL NOT NULL,
    strengthsText TEXT,
    devText       TEXT,
    otherText     TEXT,
    createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  // Campaigns / cycles (typically one per year)
  db.run(`CREATE TABLE IF NOT EXISTS campaigns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    campaignId TEXT UNIQUE NOT NULL,
    label      TEXT NOT NULL,
    isActive   INTEGER NOT NULL DEFAULT 1,
    createdAt  TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  // Team leaders (for dropdowns & consistency)
  db.run(`CREATE TABLE IF NOT EXISTS team_leaders (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT UNIQUE NOT NULL,
    active   INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  // Seed default team leaders if none exist
  db.get(`SELECT COUNT(*) AS cnt FROM team_leaders`, (err, row) => {
    if (err) {
      console.error("Error checking team_leaders:", err);
      return;
    }
    if (row && row.cnt === 0) {
      const defaultTLs = [
        "Gill",
        "Kristian",
        "Nicola",
        "Teri",
        "Trish",
        "Kate-Marie",
        "Katie"
      ];
      const stmt = db.prepare(
        `INSERT INTO team_leaders (name, active) VALUES (?, 1)`
      );
      defaultTLs.forEach(name => stmt.run(name));
      stmt.finalize();
      console.log("Seeded default team leaders.");
    }
  });
});

// ---------- UTILITIES ----------
function makeSessionId() {
  return (
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chunk = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${chunk()}-${chunk()}`;
}

// In-memory mapping sessionId -> { codeId, teamLeaderId, campaignId }
const sessionStore = new Map();

// ---------- ADMIN AUTH ----------
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res
      .status(500)
      .json({ error: "Admin password not configured on server." });
  }
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

// ---------- PARTICIPANT ROUTES ----------

// Start: user enters code + campaign/year
app.post("/api/start", (req, res) => {
  const { code, campaignId } = req.body;
  if (!code || !campaignId) {
    return res.status(400).json({ error: "Code and campaignId required." });
  }

  db.get(
    `SELECT id, teamLeaderId, campaignId, used
     FROM codes
     WHERE code = ? AND campaignId = ?`,
    [code.trim(), campaignId],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error." });
      if (!row) {
        return res.status(404).json({ error: "Code not recognised for that cycle." });
      }
      if (row.used) {
        return res.status(409).json({ error: "This code has already been used." });
      }

      const sessionId = makeSessionId();
      sessionStore.set(sessionId, {
        codeId: row.id,
        teamLeaderId: row.teamLeaderId,
        campaignId: row.campaignId
      });

      // We deliberately do NOT send back the TL name to the browser.
      res.json({ sessionId });
    }
  );
});

// Submit responses
app.post("/api/submit", (req, res) => {
  const { sessionId, scores, comments } = req.body;
  if (!sessionId || !scores) {
    return res.status(400).json({ error: "Missing sessionId or scores." });
  }

  const sessionData = sessionStore.get(sessionId);
  if (!sessionData) {
    return res.status(400).json({ error: "Invalid or expired session." });
  }

  const scoreValues = Object.values(scores)
    .map(Number)
    .filter(n => !isNaN(n));
  if (!scoreValues.length) {
    return res.status(400).json({ error: "No valid scores submitted." });
  }

  const overallScore =
    scoreValues.reduce((sum, v) => sum + v, 0) / scoreValues.length;

  const strengthsText = comments?.strengths || "";
  const devText = comments?.development || "";
  const otherText = comments?.other || "";

  db.run(
    `INSERT INTO feedback
     (campaignId, teamLeaderId, scoresJson, overallScore,
      strengthsText, devText, otherText)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionData.campaignId,
      sessionData.teamLeaderId,
      JSON.stringify(scores),
      overallScore,
      strengthsText,
      devText,
      otherText
    ],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error saving feedback." });

      // Mark code as used
      db.run(
        `UPDATE codes SET used = 1, usedAt = datetime('now') WHERE id = ?`,
        [sessionData.codeId]
      );

      // Clean up session
      sessionStore.delete(sessionId);

      res.json({ ok: true });
    }
  );
});

// ---------- PUBLIC CURRENT-CAMPAIGN ROUTE ----------

// Public endpoint: current active campaign (no auth)
app.get("/api/current-campaign", (req, res) => {
  db.get(
    `SELECT campaignId
     FROM campaigns
     WHERE isActive = 1
     ORDER BY createdAt DESC
     LIMIT 1`,
    [],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: "DB error." });
      }
      if (row) {
        return res.json({ campaignId: row.campaignId });
      }

      // Fallback: latest campaign from feedback if no campaigns explicitly created yet
      db.get(
        `SELECT campaignId
         FROM feedback
         ORDER BY createdAt DESC
         LIMIT 1`,
        [],
        (err2, row2) => {
          if (err2) return res.status(500).json({ error: "DB error." });
          if (row2) return res.json({ campaignId: row2.campaignId });
          // Nothing configured yet
          res.json({ campaignId: null });
        }
      );
    }
  );
});

// ---------- ADMIN ROUTES ----------

// List campaigns (cycles)
app.get("/api/admin/campaigns", adminAuth, (req, res) => {
  db.all(
    `SELECT campaignId, label, isActive
     FROM campaigns
     ORDER BY createdAt DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error." });

      if (rows.length) {
        return res.json({
          campaigns: rows.map(r => ({
            id: r.campaignId,
            label: r.label,
            isActive: !!r.isActive
          }))
        });
      }

      // Fallback if campaigns not set up yet – infer from feedback
      db.all(
        `SELECT DISTINCT campaignId FROM feedback ORDER BY campaignId DESC`,
        [],
        (err2, rows2) => {
          if (err2) return res.status(500).json({ error: "DB error." });
          const campaigns = rows2.map(r => ({
            id: r.campaignId,
            label: r.campaignId,
            isActive: true
          }));
          res.json({ campaigns });
        }
      );
    }
  );
});

// Create a new cycle (and make it active)
app.post("/api/admin/campaigns", adminAuth, (req, res) => {
  const { campaignId, label } = req.body;
  if (!campaignId || !label) {
    return res.status(400).json({ error: "campaignId and label are required." });
  }

  // Make this the active cycle by deactivating others first
  db.run(`UPDATE campaigns SET isActive = 0`, [], err => {
    if (err) {
      return res.status(500).json({ error: "DB error updating cycles." });
    }

    db.run(
      `INSERT INTO campaigns (campaignId, label, isActive)
       VALUES (?, ?, 1)`,
      [campaignId, label],
      function (err2) {
        if (err2) {
          if (err2.message.includes("UNIQUE")) {
            return res.status(409).json({ error: "A cycle with that ID already exists." });
          }
          return res.status(500).json({ error: "DB error creating cycle." });
        }
        res.json({ ok: true });
      }
    );
  });
});

// Overview per TL in a cycle
app.get("/api/admin/overview", adminAuth, (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  db.all(
    `SELECT teamLeaderId,
            COUNT(*) as responseCount,
            AVG(overallScore) as avgScore
     FROM feedback
     WHERE campaignId = ?
     GROUP BY teamLeaderId
     ORDER BY teamLeaderId`,
    [campaignId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error." });
      res.json({ results: rows || [] });
    }
  );
});

// Detailed data for one TL in a cycle
app.get("/api/admin/detail", adminAuth, (req, res) => {
  const { campaignId, teamLeaderId } = req.query;
  if (!campaignId || !teamLeaderId) {
    return res
      .status(400)
      .json({ error: "campaignId and teamLeaderId required" });
  }

  db.all(
    `SELECT scoresJson, overallScore, strengthsText, devText, otherText
     FROM feedback
     WHERE campaignId = ? AND teamLeaderId = ?`,
    [campaignId, teamLeaderId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error." });

      const responseCount = rows.length;
      if (!responseCount) {
        return res.json({
          campaignId,
          teamLeaderId,
          responseCount: 0,
          avgOverall: null,
          questionAverages: {},
          comments: null
        });
      }

      const avgOverall =
        rows.reduce((sum, r) => sum + r.overallScore, 0) / responseCount;

      const sums = {};
      const counts = {};

      const strengths = [];
      const devs = [];
      const others = [];

      for (const row of rows) {
        let scores;
        try {
          scores = JSON.parse(row.scoresJson || "{}");
        } catch {
          scores = {};
        }

        for (const [qid, val] of Object.entries(scores)) {
          const num = Number(val);
          if (isNaN(num)) continue;
          sums[qid] = (sums[qid] || 0) + num;
          counts[qid] = (counts[qid] || 0) + 1;
        }

        if (row.strengthsText) strengths.push(row.strengthsText);
        if (row.devText) devs.push(row.devText);
        if (row.otherText) others.push(row.otherText);
      }

      const questionAverages = {};
      for (const [qid, sum] of Object.entries(sums)) {
        questionAverages[qid] = sum / counts[qid];
      }

      const comments =
        responseCount >= MIN_COMMENTS_FOR_DISPLAY
          ? { strengths, devs, others }
          : null;

      res.json({
        campaignId,
        teamLeaderId,
        responseCount,
        avgOverall,
        questionAverages,
        comments
      });
    }
  );
});

// Generate codes (used from admin UI)
app.post("/api/admin/generate-codes", adminAuth, (req, res) => {
  const { campaignId, teamLeaderId, count } = req.body;
  if (!campaignId || !teamLeaderId || !count) {
    return res
      .status(400)
      .json({ error: "campaignId, teamLeaderId and count are required." });
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0 || n > 500) {
    return res
      .status(400)
      .json({ error: "Count must be an integer between 1 and 500." });
  }

  const codes = [];
  db.serialize(() => {
    db.run("BEGIN TRANSACTION;");
    for (let i = 0; i < n; i++) {
      const code = makeCode();
      db.run(
        `INSERT INTO codes (code, teamLeaderId, campaignId)
         VALUES (?, ?, ?)`,
        [code, teamLeaderId, campaignId]
      );
      codes.push(code);
    }
    db.run("COMMIT;", err => {
      if (err) return res.status(500).json({ error: "DB error generating codes." });
      res.json({ codes });
    });
  });
});

// Delete all responses for a TL in a cycle (clean test data)
app.post("/api/admin/delete-feedback", adminAuth, (req, res) => {
  const { campaignId, teamLeaderId } = req.body;
  if (!campaignId || !teamLeaderId) {
    return res
      .status(400)
      .json({ error: "campaignId and teamLeaderId required." });
  }

  db.run(
    `DELETE FROM feedback WHERE campaignId = ? AND teamLeaderId = ?`,
    [campaignId, teamLeaderId],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error deleting feedback." });
      res.json({ ok: true, deletedRows: this.changes });
    }
  );
});

// AI summary of comments for a TL in a cycle
app.get("/api/admin/ai-summary", adminAuth, (req, res) => {
  if (!OPENAI_API_KEY || !openai) {
    return res
      .status(501)
      .json({ error: "AI summary not configured (no OPENAI_API_KEY)." });
  }
  const { campaignId, teamLeaderId } = req.query;
  if (!campaignId || !teamLeaderId) {
    return res
      .status(400)
      .json({ error: "campaignId and teamLeaderId required" });
  }

  db.all(
    `SELECT strengthsText, devText, otherText
     FROM feedback
     WHERE campaignId = ? AND teamLeaderId = ?`,
    [campaignId, teamLeaderId],
    async (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error." });
      if (!rows.length) {
        return res.json({ summary: "No comments available." });
      }

      const allText = rows
        .map(r =>
          [r.strengthsText, r.devText, r.otherText].filter(Boolean).join("\n")
        )
        .filter(Boolean)
        .join("\n\n---\n\n");

      try {
        const completion = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content:
                "You are summarising anonymous 360-degree feedback comments. " +
                "Only describe overall themes and patterns. " +
                "Do NOT quote or closely paraphrase any original sentence. " +
                "Do NOT mention anything that could identify a specific person or incident. " +
                "Use neutral, HR-safe language."
            },
            {
              role: "user",
              content:
                "Here are comments from multiple people for one team leader. " +
                "Summarise the main strengths and main development themes in 2–4 short paragraphs.\n\n" +
                allText
            }
          ]
        });

        const summary = completion.output[0].content[0].text;
        res.json({ summary });
      } catch (e) {
        console.error("Error from OpenAI:", e);
        res.status(500).json({ error: "Error calling AI service." });
      }
    }
  );
});

// ---------- TEAM LEADER ADMIN (for dropdowns, editing TL list) ----------

// Get active team leaders
app.get("/api/admin/team-leaders", adminAuth, (req, res) => {
  db.all(
    `SELECT name FROM team_leaders WHERE active = 1 ORDER BY name`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error." });
      res.json({ teamLeaders: rows.map(r => r.name) });
    }
  );
});

// Add or reactivate a TL
app.post("/api/admin/team-leaders", adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required." });

  db.run(
    `INSERT INTO team_leaders (name, active)
     VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET active = 1`,
    [name.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error saving TL." });
      res.json({ ok: true });
    }
  );
});

// Deactivate a TL (won't appear in dropdowns)
app.delete("/api/admin/team-leaders", adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required." });

  db.run(
    `UPDATE team_leaders SET active = 0 WHERE name = ?`,
    [name.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error updating TL." });
      res.json({ ok: true, affectedRows: this.changes });
    }
  );
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
