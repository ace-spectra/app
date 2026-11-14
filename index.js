require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 25584);
const TOKEN = process.env.TUNNEL_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const ROLE_ID = String(process.env.STAFF_DISCORD_ID || "").trim();
const GUILD_ID = String(process.env.DISCORD_GUILD_ID || "").trim();
const SECURE = String(REDIRECT_URI || "").startsWith("https");
const DATA_KEY = Buffer.from(process.env.DATA_KEY || "", "hex");
const PUBLIC_DIR = path.join(__dirname, "public");
const CLOUDFLARED = process.env.CLOUDFLARED_PATH || path.join(__dirname, "bin", "cloudflared");

const STATUSES = ["Pending", "Under review", "Shortlisted", "Interview", "Accepted", "Rejected"];
const ROLES = ["Administrator", "Recruitment Manager", "Department Lead", "Reviewer"];
const CATEGORIES = ["experience", "communication", "judgement", "general"];
const FILE_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".pdf": "application/pdf"
};

const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z",
    decimalNumbers: true
});

const ID_KEY = crypto.createHmac("sha256", DATA_KEY).update("lumo-blind-index-v1").digest();
const sessions = new Map();

setInterval(() => {
    for (const [key, session] of sessions) {
        if (session.expires < Date.now()) sessions.delete(key);
    }
}, 600000).unref();

function blind(value) {
    return crypto.createHmac("sha256", ID_KEY).update(String(value)).digest("hex");
}

function encrypt(value) {
    if (value === null || value === undefined) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", DATA_KEY, iv);
    const data = Buffer.concat([
        cipher.update(String(value), "utf8"),
        cipher.final()
    ]);
    return "enc:" + [
        iv.toString("hex"),
        cipher.getAuthTag().toString("hex"),
        data.toString("hex")
    ].join(":");
}

function decrypt(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    if (!text.startsWith("enc:")) return text;

    try {
        const parts = text.slice(4).split(":");
        if (parts.length !== 3) return "";
        const iv = Buffer.from(parts[0], "hex");
        const tag = Buffer.from(parts[1], "hex");
        const data = Buffer.from(parts[2], "hex");
        const decipher = crypto.createDecipheriv("aes-256-gcm", DATA_KEY, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([
            decipher.update(data),
            decipher.final()
        ]).toString("utf8");
    } catch {
        return "";
    }
}

function jsonValue(value, fallback = {}) {
    try {
        const result = JSON.parse(decrypt(value));
        return result === null || result === undefined ? fallback : result;
    } catch {
        return fallback;
    }
}

function safeString(value, max = 2000) {
    return String(value ?? "").trim().slice(0, max);
}

function iso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getCookies(req) {
    const result = {};
    String(req.headers.cookie || "").split(";").forEach(part => {
        const index = part.indexOf("=");
        if (index > 0) {
            result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
        }
    });
    return result;
}

function cookie(name, value, age) {
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${SECURE ? "; Secure" : ""}`;
}

function redirect(res, location, cookies = []) {
    res.writeHead(302, {
        Location: location,
        "Set-Cookie": cookies
    });
    res.end();
}

function sendJson(res, status, data, headers = {}) {
    if (res.writableEnded) return;
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers
    });
    res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
    return sendJson(res, status, { error: message });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 150000) {
                reject(new Error("Request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

async function bodyJson(req) {
    try {
        const raw = await readBody(req);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return null;
    }
}

function getUser(req) {
    const id = getCookies(req).lumo_session;
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expires < Date.now()) {
        sessions.delete(id);
        return null;
    }
    return session;
}

function rolePermissions(role) {
    const permissions = {
        "Administrator": [
            "apps.view", "apps.review", "apps.decide", "apps.assign", "apps.note", "apps.export",
            "positions.view", "positions.manage",
            "departments.view", "departments.manage",
            "staff.view", "staff.manage",
            "analytics.view"
        ],
        "Recruitment Manager": [
            "apps.view", "apps.review", "apps.decide", "apps.assign", "apps.note", "apps.export",
            "positions.view", "positions.manage",
            "departments.view", "departments.manage",
            "staff.view",
            "analytics.view"
        ],
        "Department Lead": [
            "apps.view", "apps.review", "apps.decide", "apps.note",
            "positions.view", "departments.view", "analytics.view"
        ],
        "Reviewer": [
            "apps.view", "apps.review", "apps.note"
        ]
    };
    return permissions[role] || [];
}

function can(staff, permission) {
    return !!staff && rolePermissions(staff.role).includes(permission);
}

function fullRole(staff) {
    return !!staff && ["Administrator", "Recruitment Manager"].includes(staff.role);
}

async function staffOf(user) {
    if (!user || !user.isStaffRole) return null;
    const [rows] = await db.query(
        "SELECT discord_id, username, avatar, role, dept, responsibilities, joined_at FROM staff WHERE discord_id = ? AND active = 1",
        [blind(user.id)]
    );
    if (!rows.length) return null;
    return {
        id: rows[0].discord_id,
        username: decrypt(rows[0].username) || user.username,
        avatar: rows[0].avatar || user.avatar || "",
        role: rows[0].role,
        dept: rows[0].dept,
        responsibilities: decrypt(rows[0].responsibilities),
        joined: rows[0].joined_at
    };
}

function makeSessionUser(user, staff) {
    return {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        isStaff: !!staff,
        role: staff ? staff.role : null,
        dept: staff ? staff.dept : null,
        perms: staff ? rolePermissions(staff.role) : []
    };
}

async function discordGet(url, accessToken) {
    try {
        const response = await fetch(url, {
            headers: { Authorization: "Bearer " + accessToken }
        });
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}

function hasRole(member) {
    return !!member && Array.isArray(member.roles) && member.roles.includes(ROLE_ID);
}

async function hasStaffRole(accessToken) {
    if (!ROLE_ID) return false;

    if (GUILD_ID) {
        const member = await discordGet(
            `https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`,
            accessToken
        );
        return hasRole(member);
    }

    const guilds = await discordGet(
        "https://discord.com/api/users/@me/guilds",
        accessToken
    );

    if (!Array.isArray(guilds)) return false;

    const ids = guilds.slice(0, 100).map(guild => guild.id);

    for (let index = 0; index < ids.length; index += 5) {
        const members = await Promise.all(
            ids.slice(index, index + 5).map(id =>
                discordGet(
                    `https://discord.com/api/users/@me/guilds/${id}/member`,
                    accessToken
                )
            )
        );

        if (members.some(hasRole)) return true;
    }

    return false;
}

async function registerStaff(id, username, avatar, hasStaff) {
    const hashed = blind(id);

    if (!hasStaff) {
        await db.query(
            "UPDATE staff SET active = 0 WHERE discord_id = ? AND source = 'discord'",
            [hashed]
        );
        return;
    }

    const [[adminCount]] = await db.query(
        "SELECT COUNT(*) AS n FROM staff WHERE role = 'Administrator' AND active = 1"
    );

    await db.query(
        `INSERT INTO staff
        (discord_id, discord_enc, username, avatar, role, active, source, joined_at)
        VALUES (?, ?, ?, ?, ?, 1, 'discord', UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
        username = VALUES(username),
        avatar = VALUES(avatar),
        discord_enc = VALUES(discord_enc),
        active = 1`,
        [
            hashed,
            encrypt(id),
            encrypt(username),
            avatar || null,
            Number(adminCount.n) === 0 ? "Administrator" : "Reviewer"
        ]
    );
}

function startLogin(res) {
    if (!CLIENT_ID || !REDIRECT_URI) {
        return redirect(res, "/?login=failed");
    }

    const state = crypto.randomBytes(24).toString("hex");
    const query = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: "identify guilds.members.read" + (GUILD_ID ? "" : " guilds"),
        state
    });

    redirect(
        res,
        "https://discord.com/oauth2/authorize?" + query,
        [cookie("lumo_state", state, 600)]
    );
}

async function finishLogin(req, res, url) {
    const failed = [cookie("lumo_state", "", 0)];
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state || state !== getCookies(req).lumo_state) {
        return redirect(res, "/?login=failed", failed);
    }

    try {
        const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT_URI
            })
        });

        if (!tokenResponse.ok) return redirect(res, "/?login=failed", failed);

        const token = await tokenResponse.json();
        const profile = await discordGet(
            "https://discord.com/api/users/@me",
            token.access_token
        );

        if (!profile || !profile.id) {
            return redirect(res, "/?login=failed", failed);
        }

        const avatar = profile.avatar
            ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128`
            : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(profile.id) >> 22n) % 6n)}.png`;

        const username = profile.global_name || profile.username;
        const isStaffRole = await hasStaffRole(token.access_token);

        await registerStaff(profile.id, username, avatar, isStaffRole);

        const maxAge = isStaffRole ? 28800 : 604800;
        const sessionId = crypto.randomBytes(32).toString("hex");

        sessions.set(sessionId, {
            id: profile.id,
            username,
            avatar,
            isStaffRole,
            expires: Date.now() + maxAge * 1000
        });

        redirect(res, "/", [
            cookie("lumo_session", sessionId, maxAge),
            cookie("lumo_state", "", 0)
        ]);
    } catch {
        redirect(res, "/?login=failed", failed);
    }
}

function logout(req, res) {
    const id = getCookies(req).lumo_session;
    if (id) sessions.delete(id);
    redirect(res, "/", [cookie("lumo_session", "", 0)]);
}

const SCORING = {
    minWords: 10,
    defaultQuestions: [
        { key: "about", label: "About the applicant", max: 15, words: 40 },
        { key: "why", label: "Motivation", max: 20, words: 40 },
        { key: "experience", label: "Relevant experience", max: 20, words: 40 },
        { key: "scenario", label: "Situational judgement", max: 25, words: 50 }
    ],
    hours: { key: "hours", label: "Weekly availability", max: 20, required: 3 }
};

function screen(answers, questions = null) {
    const result = {
        score: 0,
        max: 100,
        breakdown: [],
        categories: {},
        flags: [],
        missing: [],
        checks: [],
        meetsRequirements: true
    };

    const entries = Object.entries(answers || {});
    const questionList = Array.isArray(questions) && questions.length
        ? questions
        : SCORING.defaultQuestions.map(q => ({
            id: q.key,
            label: q.label,
            category: "general",
            minWords: q.words,
            keywords: ""
        }));

    const categoryTotals = {};

    for (const question of questionList) {
        const key = String(question.id || question.key || "");
        const label = safeString(question.label || key, 200);
        const answer = safeString((answers || {})[key], 2000);
        const words = answer ? answer.split(/\s+/).filter(Boolean) : [];
        const minimum = Math.max(0, Number(question.minWords || 0));
        const category = CATEGORIES.includes(question.category) ? question.category : "general";

        if (!answer) {
            result.missing.push(label);
        }

        let lengthRatio = words.length === 0
            ? 0
            : minimum > 0
                ? Math.min(words.length / minimum, 1)
                : Math.min(words.length / 40, 1);

        const keywordList = String(question.keywords || "")
            .split(",")
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);

        const matched = keywordList.filter(word =>
            answer.toLowerCase().includes(word)
        ).length;

        const keywordRatio = keywordList.length
            ? matched / keywordList.length
            : lengthRatio;

        let ratio = keywordList.length
            ? lengthRatio * 0.6 + keywordRatio * 0.4
            : lengthRatio;

        const uniqueRatio = words.length
            ? new Set(words.map(word => word.toLowerCase())).size / words.length
            : 1;

        if (words.length >= 5 && uniqueRatio < 0.4) {
            ratio *= 0.5;
            result.flags.push(`${label}: answer is very repetitive`);
        }

        if (minimum > 0 && words.length < minimum) {
            result.flags.push(`${label}: answer is shorter than the recommended ${minimum} words`);
        }

        const points = Math.max(0, Math.round(ratio * 100));
        categoryTotals[category] ||= { score: 0, max: 0 };
        categoryTotals[category].score += points;
        categoryTotals[category].max += 100;

        result.breakdown.push({
            label,
            got: points,
            max: 100,
            category
        });

        result.score += points;
    }

    const hoursAnswer = entries.find(([key]) => key.toLowerCase().includes("hour"));
    const hoursText = hoursAnswer ? String(hoursAnswer[1]) : "";
    const match = hoursText.match(/\d+(\.\d+)?/);
    const hours = match ? Number(match[0]) : null;

    if (hours === null) {
        result.missing.push("Weekly availability");
    } else if (hours < SCORING.hours.required) {
        result.flags.push(`Only ${hours} hours a week (${SCORING.hours.required} required)`);
        result.meetsRequirements = false;
    } else if (hours > 168) {
        result.flags.push("Weekly hours are not realistic");
        result.meetsRequirements = false;
    }

    const texts = entries.map(([, value]) => String(value || "").trim().toLowerCase()).filter(Boolean);
    const duplicate = new Set(texts).size !== texts.length;

    if (duplicate) result.flags.push("Two or more answers are identical");

    result.checks = [
        { label: "Every question answered", pass: result.missing.length === 0 },
        { label: "Weekly availability is realistic", pass: hours !== null && hours >= 3 && hours <= 168 },
        { label: "All answers are different", pass: !duplicate },
        { label: "No answers flagged as too short", pass: !result.flags.some(flag => flag.includes("shorter")) }
    ];

    for (const [name, category] of Object.entries(categoryTotals)) {
        result.categories[name] = {
            score: Math.round(category.score / Math.max(category.max, 1) * 100),
            max: 100
        };
    }

    const totalPossible = Math.max(1, result.breakdown.length * 100);
    result.score = Math.round(result.score / totalPossible * 100);

    return result;
}

async function addEvent(appId, who, kind, text, meta = null, author = null) {
    await db.query(
        `INSERT INTO app_events (app_id, who, kind, text, meta, author_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [appId, encrypt(who), kind, encrypt(text), meta, author && (author.discordId || author.id) ? blind(author.discordId || author.id) : null]
    );
}

async function notify(ids, text, appId = null) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return;

    for (const id of unique) {
        await db.query(
            `INSERT INTO notifications
            (discord_id, text, app_id, is_read, created_at)
            VALUES (?, ?, ?, 0, UTC_TIMESTAMP())`,
            [id, encrypt(safeString(text, 300)), appId]
        );
    }
}

async function notifyManagers(text, appId, department = null) {
    let sql = "SELECT discord_id FROM staff WHERE active = 1 AND role IN ('Administrator', 'Recruitment Manager')";
    const args = [];

    if (department) {
        sql += " UNION SELECT discord_id FROM staff WHERE active = 1 AND role = 'Department Lead' AND dept = ?";
        args.push(department);
    }

    const [rows] = await db.query(sql, args);
    await notify(rows.map(row => row.discord_id), text, appId);
}

function staffScope(staff, alias = "") {
    const prefix = alias ? alias + "." : "";
    if (staff.role === "Administrator") return { sql: "1=1", args: [] };

    const accessSql = `NOT EXISTS (
        SELECT 1 FROM departments da WHERE da.name = ${prefix}dept
    ) OR EXISTS (
        SELECT 1 FROM departments da
        WHERE da.name = ${prefix}dept
        AND (da.role_access IS NULL OR JSON_CONTAINS(da.role_access, JSON_QUOTE(?)))
    )`;
    const accessArgs = [staff.role];

    if (staff.role === "Recruitment Manager") {
        return { sql: `(${accessSql})`, args: accessArgs };
    }
    if (staff.role === "Department Lead" && staff.dept) {
        return {
            sql: `((${prefix}dept = ? OR ${prefix}assigned_to = ?) AND (${accessSql}))`,
            args: [staff.dept, staff.id, ...accessArgs]
        };
    }
    return {
        sql: `(${prefix}assigned_to = ? AND (${accessSql}))`,
        args: [staff.id, ...accessArgs]
    };
}

async function visibleApplication(id, staff) {
    const scope = staffScope(staff);
    const [rows] = await db.query(
        `SELECT * FROM applications WHERE id = ? AND ${scope.sql}`,
        [id, ...scope.args]
    );
    return rows[0] || null;
}

async function getPosition(id) {
    const [rows] = await db.query(
        "SELECT * FROM positions WHERE id = ?",
        [id]
    );
    return rows[0] || null;
}

function positionObject(row, includeQuestions = true) {
    const questions = jsonValue(row.questions, []);
    const requirements = jsonValue(row.requirements, []);

    const result = {
        id: Number(row.id),
        title: row.title,
        dept: row.department_name || row.dept || "",
        department: row.department_name || row.dept || "",
        departmentId: Number(row.department_id || 0),
        type: row.type || "Full-time",
        blurb: row.blurb || "",
        about: row.about || "",
        requirements,
        posted: iso(row.created_at),
        closesAt: row.closes_at ? String(row.closes_at).slice(0, 10) : "",
        minAccountDays: Number(row.min_account_days || 0),
        notifyAt: Number(row.notify_at || 0),
        status: row.status || "draft",
        applications: Number(row.application_count || 0)
    };

    if (includeQuestions) result.questions = questions;
    return result;
}

function applicationObject(row) {
    return {
        id: row.id,
        username: decrypt(row.username),
        discordId: decrypt(row.discord_enc),
        robloxUsername: decrypt(row.roblox_username),
        title: row.title,
        dept: row.dept,
        jobId: Number(row.job_id),
        positionId: Number(row.position_id || row.job_id),
        status: row.status,
        score: row.score === null ? null : Number(row.score),
        assignedTo: row.assigned_to,
        assignee: row.assigned_name ? decrypt(row.assigned_name) : null,
        date: iso(row.created_at)
    };
}

async function setApplicationStatus(id, status, actor) {
    if (!STATUSES.includes(status)) return false;

    const [rows] = await db.query(
        "SELECT username, status, assigned_to FROM applications WHERE id = ?",
        [id]
    );

    if (!rows.length || rows[0].status === status) return false;

    await db.query(
        `UPDATE applications
        SET status = ?, reviewed_at = COALESCE(reviewed_at, UTC_TIMESTAMP())
        WHERE id = ?`,
        [status, id]
    );

    const applicant = decrypt(rows[0].username);

    await addEvent(
        id,
        actor.username,
        "history",
        `Status changed from ${rows[0].status} to ${status}`,
        status,
        actor
    );

    const targets = [rows[0].assigned_to];

    if (["Accepted", "Rejected"].includes(status)) {
        const [managers] = await db.query(
            "SELECT discord_id FROM staff WHERE active = 1 AND role IN ('Administrator', 'Recruitment Manager')"
        );
        targets.push(...managers.map(row => row.discord_id));
    }

    await notify(
        targets.filter(target => target && target !== actor.id),
        `${actor.username} moved ${applicant}'s application to ${status}`,
        id
    );

    return true;
}

async function assignApplication(id, memberId, actor) {
    let assignedName = null;
    let assignedId = null;

    if (memberId) {
        const [members] = await db.query(
            "SELECT discord_id, username FROM staff WHERE discord_id = ? AND active = 1",
            [memberId]
        );

        if (!members.length) return false;

        assignedId = members[0].discord_id;
        assignedName = decrypt(members[0].username);
    }

    const [apps] = await db.query(
        "SELECT username FROM applications WHERE id = ?",
        [id]
    );

    if (!apps.length) return false;

    await db.query(
        "UPDATE applications SET assigned_to = ?, assigned_name = ? WHERE id = ?",
        [assignedId, assignedName ? encrypt(assignedName) : null, id]
    );

    await addEvent(
        id,
        actor.username,
        "history",
        assignedName ? `Assigned to ${assignedName}` : "Application unassigned",
        null,
        actor
    );

    if (assignedId && assignedId !== actor.id) {
        await notify(
            [assignedId],
            `${actor.username} assigned you ${decrypt(apps[0].username)}'s application`,
            id
        );
    }

    return true;
}

async function lookupRobloxUser(username) {
    const clean = safeString(username, 20);
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(clean)) return null;
    try {
        const response = await fetch("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [clean], excludeBannedUsers: false }),
            signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) return null;
        const payload = await response.json();
        const user = Array.isArray(payload.data) ? payload.data[0] : null;
        if (!user || !user.id) return null;
        const thumbResponse = await fetch(
            "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=" +
            encodeURIComponent(user.id) + "&size=150x150&format=Png&isCircular=true",
            { signal: AbortSignal.timeout(8000) }
        );
        const thumbs = thumbResponse.ok ? await thumbResponse.json() : null;
        return {
            id: String(user.id),
            username: user.name || clean,
            displayName: user.displayName || user.name || clean,
            avatar: thumbs && thumbs.data && thumbs.data[0] ? thumbs.data[0].imageUrl || "" : ""
        };
    } catch {
        return null;
    }
}

async function submitApplication(req, res, user) {
    const data = await bodyJson(req);

    if (!data || typeof data !== "object") {
        return sendError(res, 400, "Invalid application data.");
    }

    const positionId = Number(data.positionId || data.jobId);
    const robloxUsername = safeString(data.robloxUsername, 20);
    const submittedAnswers = data.answers;
    const robloxProfile = await lookupRobloxUser(robloxUsername);
    if (!robloxProfile) return sendError(res, 400, "We couldn't find that Roblox username. Check it and try again.");

    if (!Number.isInteger(positionId) || positionId < 1) {
        return sendError(res, 400, "Please select a valid position.");
    }

    if (!robloxUsername || !/^[a-zA-Z0-9_]{3,20}$/.test(robloxUsername)) {
        return sendError(res, 400, "Please enter a valid Roblox username.");
    }

    if (!submittedAnswers || typeof submittedAnswers !== "object" || Array.isArray(submittedAnswers)) {
        return sendError(res, 400, "Please provide your answers.");
    }

    const position = await getPosition(positionId);

    if (!position || position.status !== "published") {
        return sendError(res, 400, "This position is no longer accepting applications.");
    }

    if (position.closes_at && new Date(position.closes_at) < new Date()) {
        return sendError(res, 400, "The closing date for this position has passed.");
    }

    const questions = jsonValue(position.questions, []);

    if (!questions.length) {
        return sendError(res, 400, "This position does not have application questions configured.");
    }

    const answers = {};

    for (const question of questions) {
        const id = String(question.id);
        const answer = safeString(submittedAnswers[id], 2000);

        if (!answer) {
            return sendError(res, 400, `Please answer: ${question.label}`);
        }

        answers[id] = answer;
    }

    const userHash = blind(user.id);

    const [existing] = await db.query(
        `SELECT id FROM applications
        WHERE discord_id = ? AND job_id = ?
        AND status NOT IN ('Rejected')
        LIMIT 1`,
        [userHash, positionId]
    );

    if (existing.length) {
        return sendError(res, 409, "You've already applied for this position.");
    }

    const id = crypto.randomBytes(6).toString("hex");
    const screening = screen(answers, questions);

    await db.query(
        `INSERT INTO applications
        (id, discord_id, discord_enc, username, roblox_username, roblox_id, roblox_avatar,
        job_id, position_id, title, dept, answers, score, screening,
        status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', UTC_TIMESTAMP())`,
        [
            id,
            userHash,
            encrypt(user.id),
            encrypt(user.username),
            encrypt(robloxUsername),
            String(robloxProfile.id),
            robloxProfile.avatar,
            positionId,
            positionId,
            position.title,
            position.department_name || position.dept || "",
            encrypt(JSON.stringify(answers)),
            screening.score,
            encrypt(JSON.stringify(screening))
        ]
    );

    await addEvent(id, user.username, "history", "Application submitted", null, user);
    await notifyManagers(
        `New application from ${user.username} for ${position.title}`,
        id,
        position.department_name || position.dept
    );

    const [[count]] = await db.query(
        "SELECT COUNT(*) AS n FROM applications WHERE job_id = ?",
        [positionId]
    );

    if (Number(position.notify_at || 0) > 0 && Number(count.n) === Number(position.notify_at)) {
        await notifyManagers(
            `${position.title} has reached ${position.notify_at} applications.`,
            id,
            position.department_name || position.dept
        );
    }

    return sendJson(res, 201, {
        ok: true,
        application: {
            id,
            title: position.title,
            dept: position.department_name || position.dept,
            status: "Pending"
        }
    });
}

async function applicantRoutes(req, res, url, user) {
    const route = req.method + " " + url.pathname;
    const userHash = blind(user.id);

    if (route === "GET /api/positions") {
        const [rows] = await db.query(
            `SELECT p.*, d.name AS department_name,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = p.id) AS application_count
            FROM positions p
            LEFT JOIN departments d ON d.id = p.department_id
            WHERE p.status = 'published'
            AND (p.closes_at IS NULL OR p.closes_at >= CURDATE())
            ORDER BY p.created_at DESC`
        );

        return sendJson(res, 200, {
            positions: rows.map(row => positionObject(row))
        });
    }

    if (route === "POST /api/roblox/lookup") {
        const data = await bodyJson(req);
        const username = safeString(data && data.username, 20);
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return sendError(res, 400, "Enter a valid Roblox username.");
        const profile = await lookupRobloxUser(username);
        return profile ? sendJson(res, 200, profile) : sendError(res, 404, "Roblox user not found.");
    }

    if (route === "POST /api/apply") {
        return submitApplication(req, res, user);
    }

    if (route === "GET /api/my-applications") {
        const [rows] = await db.query(
            "SELECT * FROM applications WHERE discord_id = ? ORDER BY created_at DESC",
            [userHash]
        );

        return sendJson(res, 200, {
            applications: rows.map(row => {
                const answers = jsonValue(row.answers, {});
                const questions = jsonValue(row.question_snapshot, []);
                const answerList = questions.length
                    ? questions.map(question => ({
                        label: question.label,
                        answer: answers[String(question.id)] || ""
                    }))
                    : Object.entries(answers).map(([label, answer]) => ({
                        label,
                        answer
                    }));

                return {
                    ...applicationObject(row),
                    answerList
                };
            })
        });
    }

    if (route === "GET /api/my-data") {
        const [rows] = await db.query(
            "SELECT * FROM applications WHERE discord_id = ? ORDER BY created_at DESC",
            [userHash]
        );

        const applications = [];

        for (const row of rows) {
            const [events] = await db.query(
                "SELECT text, created_at FROM app_events WHERE app_id = ? AND kind = 'history' ORDER BY id",
                [row.id]
            );

            applications.push({
                ...applicationObject(row),
                answers: jsonValue(row.answers, {}),
                history: events.map(event => ({
                    text: decrypt(event.text),
                    date: iso(event.created_at)
                }))
            });
        }

        const [notifications] = await db.query(
            "SELECT text, created_at FROM notifications WHERE discord_id = ? ORDER BY id DESC",
            [userHash]
        );

        return sendJson(
            res,
            200,
            {
                discord: {
                    id: user.id,
                    username: user.username
                },
                applications,
                notifications: notifications.map(row => ({
                    text: decrypt(row.text),
                    date: iso(row.created_at)
                }))
            },
            {
                "Content-Disposition": 'attachment; filename="my-lumo-data.json"'
            }
        );
    }

    if (route === "DELETE /api/me") {
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [mine] = await connection.query(
                "SELECT id FROM applications WHERE discord_id = ?",
                [userHash]
            );

            const ids = mine.map(row => row.id);

            if (ids.length) {
                await connection.query(
                    "DELETE FROM app_events WHERE app_id IN (?)",
                    [ids]
                );
            }

            await connection.query(
                "DELETE FROM applications WHERE discord_id = ?",
                [userHash]
            );

            await connection.query(
                "DELETE FROM notifications WHERE discord_id = ?",
                [userHash]
            );

            await connection.query(
                "UPDATE applications SET assigned_to = NULL, assigned_name = NULL WHERE assigned_to = ?",
                [userHash]
            );

            await connection.query(
                "DELETE FROM staff WHERE discord_id = ?",
                [userHash]
            );

            await connection.commit();

            for (const [sessionId, session] of sessions) {
                if (session.id === user.id) sessions.delete(sessionId);
            }

            return sendJson(
                res,
                200,
                { deleted: ids.length },
                { "Set-Cookie": cookie("lumo_session", "", 0) }
            );
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    return false;
}

async function getStaffApplicationList(url, staff) {
    const query = url.searchParams;
    const scope = staffScope(staff, "a");
    const where = [scope.sql];
    const args = [...scope.args];

    const status = query.get("status");
    const dept = query.get("dept");
    const position = query.get("position") || query.get("job");
    const from = query.get("from");
    const to = query.get("to");
    const assigned = query.get("assigned");
    const minScore = query.get("minScore");
    const maxScore = query.get("maxScore");

    if (status && STATUSES.includes(status)) {
        where.push("a.status = ?");
        args.push(status);
    }

    if (dept) {
        where.push("a.dept = ?");
        args.push(dept);
    }

    if (position && /^\d+$/.test(position)) {
        where.push("a.job_id = ?");
        args.push(Number(position));
    }

    if (assigned === "unassigned" || assigned === "none") {
        where.push("a.assigned_to IS NULL");
    } else if (assigned === "me") {
        where.push("a.assigned_to = ?");
        args.push(staff.id);
    } else if (assigned) {
        where.push("a.assigned_to = ?");
        args.push(assigned);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(from || "")) {
        where.push("a.created_at >= ?");
        args.push(from + " 00:00:00");
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
        where.push("a.created_at <= ?");
        args.push(to + " 23:59:59");
    }

    if (minScore !== null && minScore !== "" && Number.isFinite(Number(minScore))) {
        where.push("a.score >= ?");
        args.push(Number(minScore));
    }

    if (maxScore !== null && maxScore !== "" && Number.isFinite(Number(maxScore))) {
        where.push("a.score <= ?");
        args.push(Number(maxScore));
    }

    const sortNames = {
        submitted: "a.created_at",
        date: "a.created_at",
        score: "a.score",
        status: "a.status",
        position: "a.title",
        dept: "a.dept",
        assigned: "a.assigned_name",
        applicant: "a.username",
        name: "a.username"
    };

    const sort = sortNames[query.get("sort")] || "a.created_at";
    const direction = query.get("dir") === "asc" ? "ASC" : "DESC";
    const page = Math.max(1, Number(query.get("page") || 1));
    const pageSize = 25;

    const [rows] = await db.query(
        `SELECT a.* FROM applications a
        WHERE ${where.join(" AND ")}
        ORDER BY ${sort} ${direction}
        LIMIT 10000`,
        args
    );

    const needle = safeString(query.get("search") || query.get("q"), 100).toLowerCase();

    let list = rows.map(applicationObject);

    if (needle) {
        list = list.filter(row =>
            row.username.toLowerCase().includes(needle) ||
            row.robloxUsername.toLowerCase().includes(needle) ||
            row.discordId.includes(needle) ||
            row.id.toLowerCase().includes(needle)
        );
    }

    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const applications = list.slice((page - 1) * pageSize, page * pageSize);

    return {
        rows: applications,
        applications,
        total,
        page,
        pages,
        pageSize
    };
}

async function staffRoutes(req, res, url, user) {
    const staff = await staffOf(user);

    if (!staff) return sendError(res, 403, "Staff access is required.");

    const method = req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const base = "/api/staff";
    const route = pathname.slice(base.length) || "/";
    const actor = {
        id: staff.id,
        discordId: user.id,
        username: user.username
    };

    const deny = () => sendError(res, 403, "You don't have permission to do that.");

    if (method === "GET" && route === "/unread") {
        const [[row]] = await db.query(
            "SELECT COUNT(*) AS n FROM notifications WHERE discord_id = ? AND is_read = 0",
            [staff.id]
        );
        return sendJson(res, 200, { count: Number(row.n) });
    }

    if (method === "GET" && route === "/overview") {
        if (!can(staff, "apps.view")) return deny();

        const scope = staffScope(staff, "a");
        const [countsRows] = await db.query(
            `SELECT a.status, COUNT(*) AS n FROM applications a
            WHERE ${scope.sql} GROUP BY a.status`,
            scope.args
        );

        const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
        countsRows.forEach(row => counts[row.status] = Number(row.n));

        const [[totalRow]] = await db.query(
            `SELECT COUNT(*) AS n FROM applications a WHERE ${scope.sql}`,
            scope.args
        );

        const [recentRows] = await db.query(
            `SELECT a.* FROM applications a WHERE ${scope.sql}
            ORDER BY a.created_at DESC LIMIT 6`,
            scope.args
        );

        const [activityRows] = await db.query(
            `SELECT e.*, a.username AS applicant, a.id AS application_id,
            s.username AS staff_username, s.avatar AS staff_avatar
            FROM app_events e
            JOIN applications a ON a.id = e.app_id
            LEFT JOIN staff s ON s.discord_id = e.author_id
            WHERE ${scope.sql}
            ORDER BY e.id DESC LIMIT 12`,
            scope.args
        );

        const [[waitingRow]] = await db.query(
            `SELECT COUNT(*) AS n FROM applications a
            WHERE ${scope.sql}
            AND a.assigned_to IS NULL
            AND a.status = 'Pending'
            AND a.created_at < UTC_TIMESTAMP() - INTERVAL 3 DAY`,
            scope.args
        );

        return sendJson(res, 200, {
            total: Number(totalRow.n),
            counts,
            waiting: Number(waitingRow.n),
            recent: recentRows.map(applicationObject),
            activity: activityRows.map(row => ({
                who: decrypt(row.who),
                authorUsername: decrypt(row.staff_username) || decrypt(row.who),
                authorAvatar: row.staff_avatar || "",
                applicationId: row.application_id,
                text: decrypt(row.text),
                date: iso(row.created_at)
            }))
        });
    }

    if (method === "GET" && route === "/applications") {
        if (!can(staff, "apps.view")) return deny();
        return sendJson(res, 200, await getStaffApplicationList(url, staff));
    }

    if (method === "GET" && route === "/applications/export") {
        if (!can(staff, "apps.export")) return deny();

        const result = await getStaffApplicationList(url, staff);
        const all = result.rows;
        const csvCell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;

        const lines = [
            ["Application ID", "Applicant", "Discord ID", "Roblox username", "Position", "Department", "Status", "Score", "Reviewer", "Submitted"].map(csvCell).join(",")
        ];

        const scope = staffScope(staff, "a");
        const [rows] = await db.query(
            `SELECT a.* FROM applications a WHERE ${scope.sql} ORDER BY a.created_at DESC LIMIT 10000`,
            scope.args
        );

        let exportRows = rows.map(applicationObject);
        const needle = safeString(url.searchParams.get("search") || url.searchParams.get("q"), 100).toLowerCase();

        if (needle) {
            exportRows = exportRows.filter(row =>
                row.username.toLowerCase().includes(needle) ||
                row.robloxUsername.toLowerCase().includes(needle) ||
                row.discordId.includes(needle) ||
                row.id.toLowerCase().includes(needle)
            );
        }

        for (const row of exportRows) {
            lines.push([
                row.id,
                row.username,
                row.discordId,
                row.robloxUsername,
                row.title,
                row.dept,
                row.status,
                row.score,
                row.assignee,
                row.date
            ].map(csvCell).join(","));
        }

        res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="lumo-applications.csv"',
            "Cache-Control": "no-store"
        });
        return res.end("\uFEFF" + lines.join("\r\n"));
    }

    if (method === "GET" && route === "/lookups") {
        if (!can(staff, "apps.view")) return deny();

        const [departments] = await db.query(
            "SELECT name FROM departments ORDER BY name"
        );

        const [positions] = await db.query(
            "SELECT id, title FROM positions ORDER BY title"
        );

        const [members] = await db.query(
            "SELECT discord_id, username FROM staff WHERE active = 1 ORDER BY username"
        );

        return sendJson(res, 200, {
            departments: departments.map(row => row.name),
            positions: positions.map(row => ({
                id: Number(row.id),
                title: row.title
            })),
            staff: members.map(row => ({
                id: row.discord_id,
                username: decrypt(row.username)
            }))
        });
    }

    if (method === "POST" && route === "/applications/bulk") {
        if (!fullRole(staff)) return deny();

        const data = await bodyJson(req);
        if (!data) return sendError(res, 400, "Invalid request.");

        const ids = Array.isArray(data.ids)
            ? data.ids.slice(0, 200).map(String)
            : [];

        let updated = 0;

        for (const id of ids) {
            const row = await visibleApplication(id, staff);
            if (!row) continue;

            if (data.action === "status" && STATUSES.includes(data.value)) {
                if (!can(staff, "apps.decide") &&
                    !(can(staff, "apps.review") && ["Under review", "Shortlisted"].includes(data.value))) {
                    continue;
                }

                if (await setApplicationStatus(id, data.value, actor)) updated++;
            } else if (data.action === "assign" && can(staff, "apps.assign")) {
                if (await assignApplication(id, data.value || null, actor)) updated++;
            }
        }

        return sendJson(res, 200, { ok: true, updated, count: updated });
    }

    if (route === "/applications" && method === "POST") {
        if (!can(staff, "apps.review")) return deny();
        const data = await bodyJson(req);
        if (!data) return sendError(res, 400, "Invalid request.");
        const discordId = safeString(data.discordId, 20);
        const username = safeString(data.username, 80);
        const robloxUsername = safeString(data.robloxUsername, 20);
        const positionId = Number(data.positionId);
        if (!/^\\d{17,20}$/.test(discordId) || !username) return sendError(res, 400, "Enter the applicant's Discord ID and username.");
        if (!Number.isInteger(positionId) || positionId < 1) return sendError(res, 400, "Choose a valid position.");
        const position = await getPosition(positionId);
        if (!position) return sendError(res, 404, "Position not found.");
        const robloxProfile = await lookupRobloxUser(robloxUsername);
        if (!robloxProfile) return sendError(res, 400, "Enter a valid Roblox username.");
        const questions = jsonValue(position.questions, []);
        const answers = {};
        for (const question of questions) {
            const answer = safeString((data.answers || {})[String(question.id)], 2000);
            if (!answer) return sendError(res, 400, "Please answer: " + question.label);
            answers[String(question.id)] = answer;
        }
        const id = crypto.randomBytes(6).toString("hex");
        const screening = screen(answers, questions);
        await db.query(
            `INSERT INTO applications
            (id, discord_id, discord_enc, username, roblox_username, roblox_id, roblox_avatar,
            job_id, position_id, title, dept, answers, question_snapshot, score, screening, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', UTC_TIMESTAMP())`,
            [id, blind(discordId), encrypt(discordId), encrypt(username), encrypt(robloxProfile.username),
                robloxProfile.id, robloxProfile.avatar, positionId, positionId, position.title,
                position.department_name || position.dept || "", encrypt(JSON.stringify(answers)),
                encrypt(JSON.stringify(questions)), screening.score, encrypt(JSON.stringify(screening))]
        );
        await addEvent(id, staff.username, "history", "Application created by staff", null, user);
        return sendJson(res, 201, { ok: true, id });
    }

    const appMatch = route.match(/^\/applications\/([a-f0-9]+)(?:\/(status|assign|note|notes|rescore|summary|edit|delete))?$/i);

    if (appMatch) {
        const id = appMatch[1];
        const action = appMatch[2] || null;
        const row = await visibleApplication(id, staff);

        if (!row) return sendError(res, 404, "Application not found.");

        if (method === "GET" && !action) {
            if (!can(staff, "apps.view")) return deny();

            const application = applicationObject(row);
            const answers = jsonValue(row.answers, {});
            const questions = jsonValue(row.question_snapshot, []);
            const screening = screen(answers, questions);
            const answerList = questions.map(question => ({
                id: question.id,
                label: question.label,
                category: question.category || "general",
                answer: answers[String(question.id)] || ""
            }));

            const [events] = await db.query(
                `SELECT e.*, s.username AS staff_username, s.avatar AS staff_avatar
                FROM app_events e
                LEFT JOIN staff s ON s.discord_id = e.author_id
                WHERE e.app_id = ? ORDER BY e.id DESC`,
                [id]
            );

            const [people] = await db.query(
                "SELECT discord_id, username FROM staff WHERE active = 1 ORDER BY username"
            );

            const notes = events
                .filter(event => event.kind === "note")
                .map(event => ({
                    who: decrypt(event.who),
                    authorUsername: decrypt(event.staff_username) || decrypt(event.who),
                    authorAvatar: event.staff_avatar || "",
                    text: decrypt(event.text),
                    date: iso(event.created_at)
                }));

            const history = events
                .filter(event => event.kind === "history")
                .map(event => ({
                    who: decrypt(event.who),
                    authorUsername: decrypt(event.staff_username) || decrypt(event.who),
                    authorAvatar: event.staff_avatar || "",
                    text: decrypt(event.text),
                    date: iso(event.created_at)
                }));

            return sendJson(res, 200, {
                application: {
                    ...application,
                    robloxUsername: decrypt(row.roblox_username),
                    robloxId: row.roblox_id || "",
                    robloxAvatar: row.roblox_avatar || "",
                    assignedTo: row.assigned_to,
                    assignee: row.assigned_name ? decrypt(row.assigned_name) : null
                },
                answers: answerList,
                notes,
                history,
                events: history,
                screening: {
                    ...screening,
                    categories: screening.categories,
                    meetsRequirements: screening.meetsRequirements
                },
                people: people.map(person => ({
                    id: person.discord_id,
                    username: decrypt(person.username)
                })),
                aiAvailable: false,
                summary: null,
                perms: {
                    statuses: STATUSES.filter(status =>
                        can(staff, "apps.decide") ||
                        (can(staff, "apps.review") && ["Under review", "Shortlisted"].includes(status))
                    ),
                    canAssign: can(staff, "apps.assign")
                }
            });
        }

        if (method === "DELETE" && action === "delete") {
            if (!can(staff, "apps.review")) return deny();
            await db.query("DELETE FROM app_events WHERE app_id = ?", [id]);
            await db.query("DELETE FROM notifications WHERE app_id = ?", [id]);
            await db.query("DELETE FROM applications WHERE id = ?", [id]);
            return sendJson(res, 200, { ok: true });
        }

        if (method === "PUT" && action === "edit") {
            if (!can(staff, "apps.review")) return deny();
            const data = await bodyJson(req);
            if (!data) return sendError(res, 400, "Invalid request.");
            const username = safeString(data.username, 80);
            const robloxUsername = safeString(data.robloxUsername, 20);
            if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(robloxUsername)) return sendError(res, 400, "Enter a valid applicant name and Roblox username.");
            const profile = await lookupRobloxUser(robloxUsername);
            if (!profile) return sendError(res, 400, "Roblox user not found.");
            const questions = jsonValue(row.question_snapshot, []);
            const answers = data.answers && typeof data.answers === "object" ? data.answers : jsonValue(row.answers, {});
            for (const question of questions) {
                if (!safeString(answers[String(question.id)], 2000)) return sendError(res, 400, "Please answer: " + question.label);
            }
            const cleanAnswers = {};
            for (const question of questions) cleanAnswers[String(question.id)] = safeString(answers[String(question.id)], 2000);
            const screening = screen(cleanAnswers, questions);
            await db.query(
                "UPDATE applications SET username = ?, roblox_username = ?, roblox_id = ?, roblox_avatar = ?, answers = ?, score = ?, screening = ? WHERE id = ?",
                [encrypt(username), encrypt(profile.username), profile.id, profile.avatar,
                    encrypt(JSON.stringify(cleanAnswers)), screening.score, encrypt(JSON.stringify(screening)), id]
            );
            await addEvent(id, staff.username, "history", "Application details edited", null, user);
            return sendJson(res, 200, { ok: true });
        }

        if (method === "POST" && action) {
            const data = await bodyJson(req);
            if (!data) return sendError(res, 400, "Invalid request.");

            if (action === "status") {
                if (!can(staff, "apps.review")) return deny();
                if (!STATUSES.includes(data.status)) return sendError(res, 400, "Invalid status.");

                const decision = ["Interview", "Accepted", "Rejected", "Pending"].includes(data.status);
                if (decision && !can(staff, "apps.decide")) return deny();

                await setApplicationStatus(id, data.status, actor);
                return sendJson(res, 200, { ok: true });
            }

            if (action === "assign") {
                if (!can(staff, "apps.assign")) return deny();

                const memberId = data.memberId || data.staffId || null;
                if (!(await assignApplication(id, memberId, actor))) {
                    return sendError(res, 400, "Could not assign this application.");
                }

                return sendJson(res, 200, { ok: true });
            }

            if (action === "note" || action === "notes") {
                if (!can(staff, "apps.note")) return deny();

                const note = safeString(data.text || data.note, 2000);
                if (!note) return sendError(res, 400, "Comment cannot be empty.");

                await addEvent(id, user.username, "note", note, null, user);
                return sendJson(res, 200, { ok: true });
            }

            if (action === "rescore") {
                if (!can(staff, "apps.review")) return deny();

                const questions = jsonValue(row.question_snapshot, []);
                const result = screen(jsonValue(row.answers, {}), questions);

                await db.query(
                    "UPDATE applications SET score = ?, screening = ? WHERE id = ?",
                    [result.score, encrypt(JSON.stringify(result)), id]
                );

                await addEvent(id, user.username, "history", "Automated screening was re-run", null, user);
                return sendJson(res, 200, { ok: true, screening: result });
            }

            if (action === "summary") {
                return sendError(res, 400, "AI summaries are not configured.");
            }
        }
    }

    if (route === "/positions" && method === "GET") {
        if (!can(staff, "positions.view")) return deny();

        const [rows] = await db.query(
            `SELECT p.*, d.name AS department_name,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = p.id) AS application_count
            FROM positions p
            LEFT JOIN departments d ON d.id = p.department_id
            WHERE (? = 'Administrator' OR d.role_access IS NULL OR JSON_CONTAINS(d.role_access, JSON_QUOTE(?)))
            ORDER BY p.created_at DESC`,
            [staff.role, staff.role]
        );

        const [departments] = await db.query(
            "SELECT id, name FROM departments WHERE role_access IS NULL OR JSON_CONTAINS(role_access, JSON_QUOTE(?)) OR ? = 'Administrator' ORDER BY name",
            [staff.role, staff.role]
        );

        return sendJson(res, 200, {
            positions: rows.map(row => positionObject(row)),
            departments: departments.map(row => ({
                id: Number(row.id),
                name: row.name
            }))
        });
    }

    if (route === "/positions" && method === "POST") {
        if (!can(staff, "positions.manage")) return deny();

        const data = await bodyJson(req);
        if (!data) return sendError(res, 400, "Invalid request.");

        const title = safeString(data.title, 100);
        if (title.length < 3) return sendError(res, 400, "Position title is too short.");

        const [departments] = await db.query(
            "SELECT id, name FROM departments WHERE id = ?",
            [Number(data.departmentId)]
        );

        if (!departments.length) return sendError(res, 400, "Choose a valid department.");

        const questions = Array.isArray(data.questions) ? data.questions.slice(0, 20) : [];
        if (!questions.length || questions.some(question => !safeString(question.label, 200))) {
            return sendError(res, 400, "Add at least one valid application question.");
        }

        const cleanQuestions = questions.map((question, index) => ({
            id: safeString(question.id || "q" + (index + 1), 60),
            label: safeString(question.label, 200),
            category: CATEGORIES.includes(question.category) ? question.category : "general",
            minWords: Math.max(0, Math.min(2000, Number(question.minWords || 0))),
            keywords: safeString(question.keywords, 500)
        }));

        const status = ["draft", "published", "closed"].includes(data.status) ? data.status : "draft";
        const requirements = Array.isArray(data.requirements)
            ? data.requirements.map(item => safeString(item, 300)).filter(Boolean).slice(0, 30)
            : [];

        const [result] = await db.query(
            `INSERT INTO positions
            (department_id, title, type, blurb, about, requirements, questions,
            closes_at, min_account_days, notify_at, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
            [
                Number(data.departmentId),
                title,
                safeString(data.type || "Full-time", 40),
                safeString(data.blurb, 200),
                safeString(data.about, 4000),
                encrypt(JSON.stringify(requirements)),
                encrypt(JSON.stringify(cleanQuestions)),
                /^\d{4}-\d{2}-\d{2}$/.test(data.closesAt || "") ? data.closesAt : null,
                Math.max(0, Number(data.minAccountDays || 0)),
                Math.max(0, Number(data.notifyAt || 0)),
                status
            ]
        );

        return sendJson(res, 201, { ok: true, id: result.insertId });
    }

    const positionMatch = route.match(/^\/positions\/(\d+)(?:\/status)?$/);

    if (positionMatch) {
        const id = Number(positionMatch[1]);

        if (method === "PUT" && !route.endsWith("/status")) {
            if (!can(staff, "positions.manage")) return deny();

            const data = await bodyJson(req);
            if (!data) return sendError(res, 400, "Invalid request.");

            const title = safeString(data.title, 100);
            if (title.length < 3) return sendError(res, 400, "Position title is too short.");

            const [existing] = await db.query(
                "SELECT id FROM positions WHERE id = ?",
                [id]
            );

            if (!existing.length) return sendError(res, 404, "Position not found.");

            const questions = Array.isArray(data.questions) ? data.questions.slice(0, 20) : [];
            if (!questions.length || questions.some(question => !safeString(question.label, 200))) {
                return sendError(res, 400, "Add at least one valid question.");
            }

            const cleanQuestions = questions.map((question, index) => ({
                id: safeString(question.id || "q" + (index + 1), 60),
                label: safeString(question.label, 200),
                category: CATEGORIES.includes(question.category) ? question.category : "general",
                minWords: Math.max(0, Math.min(2000, Number(question.minWords || 0))),
                keywords: safeString(question.keywords, 500)
            }));

            const requirements = Array.isArray(data.requirements)
                ? data.requirements.map(item => safeString(item, 300)).filter(Boolean).slice(0, 30)
                : [];

            await db.query(
                `UPDATE positions SET
                department_id = ?, title = ?, type = ?, blurb = ?, about = ?,
                requirements = ?, questions = ?, closes_at = ?, min_account_days = ?,
                notify_at = ?, status = ?, updated_at = UTC_TIMESTAMP()
                WHERE id = ?`,
                [
                    Number(data.departmentId),
                    title,
                    safeString(data.type || "Full-time", 40),
                    safeString(data.blurb, 200),
                    safeString(data.about, 4000),
                    encrypt(JSON.stringify(requirements)),
                    encrypt(JSON.stringify(cleanQuestions)),
                    /^\d{4}-\d{2}-\d{2}$/.test(data.closesAt || "") ? data.closesAt : null,
                    Math.max(0, Number(data.minAccountDays || 0)),
                    Math.max(0, Number(data.notifyAt || 0)),
                    ["draft", "published", "closed"].includes(data.status) ? data.status : "draft",
                    id
                ]
            );

            return sendJson(res, 200, { ok: true });
        }

        if (method === "POST" && route.endsWith("/status")) {
            if (!can(staff, "positions.manage")) return deny();

            const data = await bodyJson(req);
            if (!data || !["draft", "published", "closed"].includes(data.status)) {
                return sendError(res, 400, "Invalid position status.");
            }

            await db.query(
                "UPDATE positions SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
                [data.status, id]
            );

            return sendJson(res, 200, { ok: true });
        }
    }

    if (route === "/departments" && method === "GET") {
        if (!can(staff, "departments.view")) return deny();

        const [rows] = await db.query(
            `SELECT d.*,
            s.username AS lead_username,
            s.discord_id AS lead_id,
            (SELECT COUNT(*) FROM staff st WHERE st.active = 1 AND st.dept = d.name) AS staff_count,
            (SELECT COUNT(*) FROM positions p WHERE p.department_id = d.id AND p.status = 'published') AS open_positions,
            (SELECT COUNT(*) FROM applications a WHERE a.dept = d.name) AS application_count
            FROM departments d
            LEFT JOIN staff s ON s.discord_id = d.lead_id
            ORDER BY d.name`
        );

        const [members] = await db.query(
            "SELECT discord_id, username FROM staff WHERE active = 1 ORDER BY username"
        );

        const people = members.map(row => ({
            id: row.discord_id,
            username: decrypt(row.username)
        }));

        const departments = [];

        for (const row of rows) {
            const [staffRows] = await db.query(
                "SELECT username FROM staff WHERE active = 1 AND dept = ? ORDER BY username",
                [row.name]
            );

            departments.push({
                id: Number(row.id),
                name: row.name,
                description: row.description || "",
                roleAccess: (() => { try { return JSON.parse(row.role_access || "null") || ROLES; } catch { return ROLES; } })(),
                lead: row.lead_username ? decrypt(row.lead_username) : null,
                leadId: row.lead_id,
                staff: staffRows.map(member => decrypt(member.username)),
                openPositions: Number(row.open_positions),
                applications: Number(row.application_count)
            });
        }

        return sendJson(res, 200, { departments, people });
    }

    if (route === "/departments" && method === "POST") {
        if (staff.role !== "Administrator") return deny();

        const data = await bodyJson(req);
        if (!data) return sendError(res, 400, "Invalid request.");

        const name = safeString(data.name, 50);
        if (name.length < 2) return sendError(res, 400, "Department name is too short.");

        const roleAccess = Array.isArray(data.roleAccess)
            ? ROLES.filter(role => role === "Administrator" || data.roleAccess.includes(role))
            : ROLES;
        const [result] = await db.query(
            "INSERT INTO departments (name, description, role_access, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())",
            [name, safeString(data.description, 300), JSON.stringify(roleAccess)]
        );

        if (data.leadId) {
            await db.query(
                "UPDATE staff SET dept = ? WHERE discord_id = ? AND active = 1",
                [name, data.leadId]
            );

            await db.query(
                "UPDATE staff SET role = 'Department Lead' WHERE discord_id = ? AND active = 1",
                [data.leadId]
            );

            await db.query(
                "UPDATE departments SET lead_id = ? WHERE id = ?",
                [data.leadId, result.insertId]
            );
        }

        return sendJson(res, 201, { ok: true, id: result.insertId });
    }

    const departmentMatch = route.match(/^\/departments\/(\d+)$/);

    if (departmentMatch && method === "DELETE") {
        if (staff.role !== "Administrator") return deny();
        const id = Number(departmentMatch[1]);
        const [[department]] = await db.query("SELECT name FROM departments WHERE id = ?", [id]);
        if (!department) return sendError(res, 404, "Department not found.");
        await db.query("UPDATE positions SET department_id = NULL WHERE department_id = ?", [id]);
        await db.query("UPDATE applications SET dept = 'Unassigned' WHERE dept = ?", [department.name]);
        await db.query("UPDATE staff SET dept = NULL, role = 'Reviewer' WHERE dept = ? AND role = 'Department Lead'", [department.name]);
        await db.query("UPDATE departments SET lead_id = NULL WHERE id = ?", [id]);
        await db.query("DELETE FROM departments WHERE id = ?", [id]);
        return sendJson(res, 200, { ok: true });
    }

    if (departmentMatch && method === "PUT") {
        if (staff.role !== "Administrator") return deny();

        const data = await bodyJson(req);
        if (!data) return sendError(res, 400, "Invalid request.");

        const id = Number(departmentMatch[1]);
        const name = safeString(data.name, 50);

        if (name.length < 2) return sendError(res, 400, "Department name is too short.");

        const [existing] = await db.query(
            "SELECT name FROM departments WHERE id = ?",
            [id]
        );

        if (!existing.length) return sendError(res, 404, "Department not found.");

        const oldName = existing[0].name;
        const roleAccess = Array.isArray(data.roleAccess)
            ? ROLES.filter(role => role === "Administrator" || data.roleAccess.includes(role))
            : ROLES;
        await db.query(
            "UPDATE departments SET name = ?, description = ?, role_access = ? WHERE id = ?",
            [name, safeString(data.description, 300), JSON.stringify(roleAccess), id]
        );

        if (oldName !== name) {
            await db.query(
                "UPDATE positions SET department_id = ? WHERE department_id = ?",
                [id, id]
            );
            await db.query(
                "UPDATE applications SET dept = ? WHERE dept = ?",
                [name, oldName]
            );
            await db.query(
                "UPDATE staff SET dept = ? WHERE dept = ?",
                [name, oldName]
            );
        }

        if (data.leadId) {
            await db.query(
                "UPDATE departments SET lead_id = ? WHERE id = ?",
                [data.leadId, id]
            );
            await db.query(
                "UPDATE staff SET dept = ?, role = 'Department Lead' WHERE discord_id = ? AND active = 1",
                [name, data.leadId]
            );
        } else {
            await db.query(
                "UPDATE departments SET lead_id = NULL WHERE id = ?",
                [id]
            );
        }

        return sendJson(res, 200, { ok: true });
    }

    if (route === "/members" && method === "GET") {
        if (!can(staff, "staff.view")) return deny();

        const [rows] = await db.query(
            "SELECT * FROM staff WHERE active = 1 ORDER BY username"
        );

        const [departments] = await db.query(
            "SELECT id, name FROM departments ORDER BY name"
        );

        return sendJson(res, 200, {
            me: staff.id,
            members: rows.map(row => ({
                id: row.discord_id,
                discordId: decrypt(row.discord_enc) || "",
                username: decrypt(row.username),
                role: row.role,
                roleLabel: row.role,
                department: row.dept || "",
                departmentId: "",
                responsibilities: decrypt(row.responsibilities),
                joined: iso(row.joined_at),
                source: row.source || "admin",
                avatar: row.avatar || "",
                you: row.discord_id === staff.id
            })),
            roles: ROLES.map(role => ({
                id: role,
                label: role
            })),
            departments: departments.map(row => ({
                id: row.id,
                name: row.name
            })),
            depts: departments.map(row => row.name)
        });
    }

    if (route === "/members" && method === "POST") {
        if (!can(staff, "staff.manage")) return deny();

        const data = await bodyJson(req);
        if (!data) return sendError(res, 400, "Invalid request.");

        const discordId = safeString(data.discordId, 30);
        const role = ROLES.includes(data.role) ? data.role : null;

        if (!/^\d{17,20}$/.test(discordId)) {
            return sendError(res, 400, "Enter a valid Discord user ID.");
        }

        if (!role) return sendError(res, 400, "Choose a valid staff role.");

        const hashed = blind(discordId);
        const dept = safeString(data.department || data.departmentId, 50) || null;
        const responsibilities = safeString(data.responsibilities, 200);

        const [existing] = await db.query(
            "SELECT discord_id FROM staff WHERE discord_id = ?",
            [hashed]
        );

        if (existing.length) {
            await db.query(
                `UPDATE staff SET role = ?, dept = ?, responsibilities = ?, active = 1
                WHERE discord_id = ?`,
                [role, dept, encrypt(responsibilities), hashed]
            );
        } else {
            await db.query(
                `INSERT INTO staff
                (discord_id, discord_enc, username, role, dept, responsibilities, active, source, joined_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, 'admin', UTC_TIMESTAMP())`,
                [
                    hashed,
                    encrypt(discordId),
                    encrypt("Discord user " + discordId),
                    role,
                    dept,
                    encrypt(responsibilities)
                ]
            );
        }

        return sendJson(res, 200, { ok: true });
    }

    const memberMatch = route.match(/^\/members\/([a-f0-9]+)$/i);

    if (memberMatch && method === "DELETE") {
        if (!can(staff, "staff.manage")) return deny();

        if (memberMatch[1] === staff.id) {
            return sendError(res, 400, "You cannot remove yourself.");
        }

        await db.query(
            "UPDATE staff SET active = 0 WHERE discord_id = ?",
            [memberMatch[1]]
        );

        await db.query(
            "UPDATE applications SET assigned_to = NULL, assigned_name = NULL WHERE assigned_to = ?",
            [memberMatch[1]]
        );

        return sendJson(res, 200, { ok: true });
    }

    if (route === "/analytics" && method === "GET") {
        if (!can(staff, "analytics.view")) return deny();

        const scope = staffScope(staff, "a");

        const [statusRows] = await db.query(
            `SELECT a.status, COUNT(*) AS n
            FROM applications a WHERE ${scope.sql}
            GROUP BY a.status`,
            scope.args
        );

        const statuses = Object.fromEntries(STATUSES.map(status => [status, 0]));
        statusRows.forEach(row => statuses[row.status] = Number(row.n));

        const [dailyRows] = await db.query(
            `SELECT DATE_FORMAT(a.created_at, '%Y-%m-%d') AS day, COUNT(*) AS n
            FROM applications a
            WHERE ${scope.sql}
            AND a.created_at >= UTC_DATE() - INTERVAL 29 DAY
            GROUP BY DATE(a.created_at)
            ORDER BY DATE(a.created_at)`,
            scope.args
        );

        const [popularRows] = await db.query(
            `SELECT a.title, COUNT(*) AS n
            FROM applications a WHERE ${scope.sql}
            GROUP BY a.title ORDER BY n DESC LIMIT 8`,
            scope.args
        );

        const [departmentRows] = await db.query(
            `SELECT a.dept AS name, COUNT(*) AS n
            FROM applications a WHERE ${scope.sql}
            GROUP BY a.dept ORDER BY n DESC`,
            scope.args
        );

        const [[averages]] = await db.query(
            `SELECT AVG(a.score) AS average_score,
            AVG(TIMESTAMPDIFF(MINUTE, a.created_at, a.reviewed_at)) / 60 AS review_hours
            FROM applications a WHERE ${scope.sql}`,
            scope.args
        );

        return sendJson(res, 200, {
            statuses,
            perDay: dailyRows.map(row => ({
                day: row.day,
                n: Number(row.n)
            })),
            popular: popularRows.map(row => ({
                title: row.title,
                n: Number(row.n)
            })),
            byDept: departmentRows.map(row => ({
                name: row.name,
                n: Number(row.n)
            })),
            averageScore: averages.average_score === null ? null : Number(averages.average_score),
            averageReviewHours: averages.review_hours === null ? null : Number(averages.review_hours)
        });
    }

    if (route === "/notifications" && method === "GET") {
        const [rows] = await db.query(
            `SELECT n.*, a.id AS application_id
            FROM notifications n
            LEFT JOIN applications a ON a.id = n.app_id
            WHERE n.discord_id = ?
            ORDER BY n.id DESC LIMIT 50`,
            [staff.id]
        );

        return sendJson(res, 200, {
            notifications: rows.map(row => ({
                id: row.id,
                text: decrypt(row.text),
                isRead: !!row.is_read,
                date: iso(row.created_at),
                applicationId: row.application_id || null
            }))
        });
    }

    if (route === "/notifications/read" && method === "POST") {
        await db.query(
            "UPDATE notifications SET is_read = 1 WHERE discord_id = ?",
            [staff.id]
        );
        return sendJson(res, 200, { ok: true });
    }

    if (route === "/notifications" && method === "POST") {
        await db.query(
            "UPDATE notifications SET is_read = 1 WHERE discord_id = ?",
            [staff.id]
        );
        return sendJson(res, 200, { ok: true });
    }

    return sendError(res, 404, "Staff endpoint not found.");
}

async function handleRoute(req, res, url) {
    const route = req.method + " " + url.pathname;

    if (route === "GET /auth/discord") return startLogin(res);
    if (route === "GET /auth/discord/callback") return finishLogin(req, res, url);
    if (route === "GET /auth/logout") return logout(req, res);

    const user = getUser(req);

    if (route === "GET /api/me") {
        if (!user) return sendJson(res, 200, { user: null });

        const staff = await staffOf(user);
        return sendJson(res, 200, {
            user: makeSessionUser(user, staff)
        });
    }

    if (!user) return sendError(res, 401, "Please log in with Discord.");

    if (url.pathname.startsWith("/api/staff/")) {
        return staffRoutes(req, res, url, user);
    }

    const result = await applicantRoutes(req, res, url, user);
    if (result !== false) return result;

    return sendError(res, 404, "Endpoint not found.");
}

function serveFile(res, pathname) {
    let decoded;

    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        res.writeHead(400);
        return res.end("Bad request");
    }

    if (decoded === "/") decoded = "/index.html";

    const filePath = path.resolve(PUBLIC_DIR, "." + decoded);

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        return res.end("Forbidden");
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(error.code === "ENOENT" ? 404 : 500);
            return res.end(error.code === "ENOENT" ? "Not found" : "Server error");
        }

        res.writeHead(200, {
            "Content-Type": FILE_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
            "X-Content-Type-Options": "nosniff"
        });

        res.end(data);
    });
}

async function ensureColumn(table, column, definition) {
    const [rows] = await db.query(
        `SHOW COLUMNS FROM \`${table}\` LIKE ?`,
        [column]
    );

    if (!rows.length) {
        await db.query(
            `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`
        );
    }
}

async function setupDatabase() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS departments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL UNIQUE,
            description VARCHAR(300) NOT NULL DEFAULT '',
            lead_id VARCHAR(64) NULL,
            role_access TEXT NULL,
            created_at DATETIME NOT NULL
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS positions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            department_id INT NULL,
            title VARCHAR(100) NOT NULL,
            type VARCHAR(40) NOT NULL DEFAULT 'Full-time',
            blurb VARCHAR(200) NOT NULL DEFAULT '',
            about TEXT NOT NULL,
            requirements MEDIUMTEXT NOT NULL,
            questions MEDIUMTEXT NOT NULL,
            closes_at DATE NULL,
            min_account_days INT NOT NULL DEFAULT 0,
            notify_at INT NOT NULL DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'draft',
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            INDEX (department_id),
            INDEX (status)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS applications (
            id VARCHAR(16) PRIMARY KEY,
            discord_id VARCHAR(64) NOT NULL,
            discord_enc TEXT NULL,
            username TEXT NOT NULL,
            roblox_username TEXT NULL,
            job_id INT NOT NULL,
            position_id INT NULL,
            title VARCHAR(100) NOT NULL,
            dept VARCHAR(50) NOT NULL,
            answers MEDIUMTEXT NOT NULL,
            question_snapshot MEDIUMTEXT NULL,
            screening MEDIUMTEXT NULL,
            score INT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'Pending',
            assigned_to VARCHAR(64) NULL,
            assigned_name TEXT NULL,
            reviewed_at DATETIME NULL,
            created_at DATETIME NOT NULL,
            INDEX (discord_id),
            INDEX (status),
            INDEX (created_at),
            INDEX (assigned_to),
            INDEX (job_id)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS staff (
            discord_id VARCHAR(64) PRIMARY KEY,
            discord_enc TEXT NULL,
            username TEXT NOT NULL,
            role VARCHAR(40) NOT NULL,
            dept VARCHAR(50) NULL,
            responsibilities TEXT NULL,
            active TINYINT NOT NULL DEFAULT 1,
            source VARCHAR(20) NOT NULL DEFAULT 'discord',
            joined_at DATETIME NULL
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS app_events (
            id INT AUTO_INCREMENT PRIMARY KEY,
            app_id VARCHAR(16) NOT NULL,
            who TEXT NOT NULL,
            kind VARCHAR(20) NOT NULL,
            text TEXT NOT NULL,
            meta VARCHAR(50) NULL,
            created_at DATETIME NOT NULL,
            INDEX (app_id)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            discord_id VARCHAR(64) NOT NULL,
            text TEXT NOT NULL,
            app_id VARCHAR(16) NULL,
            is_read TINYINT NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL,
            INDEX (discord_id),
            INDEX (app_id)
        )
    `);

    const migrations = [
        ["applications", "discord_enc", "TEXT NULL"],
        ["applications", "roblox_username", "TEXT NULL"],
        ["applications", "roblox_id", "VARCHAR(32) NULL"],
        ["applications", "roblox_avatar", "TEXT NULL"],
        ["applications", "position_id", "INT NULL"],
        ["departments", "role_access", "TEXT NULL"],
        ["applications", "question_snapshot", "MEDIUMTEXT NULL"],
        ["applications", "screening", "MEDIUMTEXT NULL"],
        ["applications", "score", "INT NULL"],
        ["applications", "assigned_to", "VARCHAR(64) NULL"],
        ["applications", "assigned_name", "TEXT NULL"],
        ["applications", "reviewed_at", "DATETIME NULL"],
        ["staff", "discord_enc", "TEXT NULL"],
        ["staff", "avatar", "TEXT NULL"],
        ["staff", "dept", "VARCHAR(50) NULL"],
        ["staff", "responsibilities", "TEXT NULL"],
        ["staff", "active", "TINYINT NOT NULL DEFAULT 1"],
        ["staff", "source", "VARCHAR(20) NOT NULL DEFAULT 'discord'"],
        ["staff", "joined_at", "DATETIME NULL"],
        ["app_events", "meta", "VARCHAR(50) NULL"],
        ["app_events", "author_id", "VARCHAR(64) NULL"],
        ["notifications", "app_id", "VARCHAR(16) NULL"],
        ["notifications", "is_read", "TINYINT NOT NULL DEFAULT 0"]
    ];

    for (const [table, column, definition] of migrations) {
        await ensureColumn(table, column, definition);
    }

    await db.query(
        "ALTER TABLE applications MODIFY discord_id VARCHAR(64) NOT NULL, MODIFY username TEXT NOT NULL, MODIFY answers MEDIUMTEXT NOT NULL"
    );

    await db.query(
        "ALTER TABLE staff MODIFY discord_id VARCHAR(64) NOT NULL, MODIFY username TEXT NOT NULL"
    );

    await db.query(
        "ALTER TABLE app_events MODIFY who TEXT NOT NULL, MODIFY text TEXT NOT NULL"
    );

    await db.query(
        "ALTER TABLE notifications MODIFY discord_id VARCHAR(64) NOT NULL, MODIFY text TEXT NOT NULL"
    );

    await migrateLegacyData();
    await seedDepartments();
    await migrateLegacyApplications();
}

async function migrateLegacyData() {
    const [apps] = await db.query(
        "SELECT id, discord_id, discord_enc, username, answers, assigned_to, assigned_name FROM applications"
    );

    for (const row of apps) {
        const updates = [];
        const values = [];

        if (row.discord_id && /^\d{17,20}$/.test(String(row.discord_id))) {
            updates.push("discord_id = ?");
            values.push(blind(row.discord_id));

            if (!row.discord_enc) {
                updates.push("discord_enc = ?");
                values.push(encrypt(row.discord_id));
            }
        }

        if (row.username && !String(row.username).startsWith("enc:")) {
            updates.push("username = ?");
            values.push(encrypt(row.username));
        }

        if (row.answers && !String(row.answers).startsWith("enc:")) {
            updates.push("answers = ?");
            values.push(encrypt(row.answers));
        }

        if (row.assigned_to && /^\d{17,20}$/.test(String(row.assigned_to))) {
            updates.push("assigned_to = ?");
            values.push(blind(row.assigned_to));
        }

        if (row.assigned_name && !String(row.assigned_name).startsWith("enc:")) {
            updates.push("assigned_name = ?");
            values.push(encrypt(row.assigned_name));
        }

        if (updates.length) {
            values.push(row.id);
            await db.query(
                `UPDATE applications SET ${updates.join(", ")} WHERE id = ?`,
                values
            );
        }
    }

    const [members] = await db.query(
        "SELECT discord_id, discord_enc, username, responsibilities FROM staff"
    );

    for (const row of members) {
        if (/^\d{17,20}$/.test(String(row.discord_id))) {
            await db.query(
                `UPDATE staff SET discord_id = ?, discord_enc = ?, username = ?,
                responsibilities = ? WHERE discord_id = ?`,
                [
                    blind(row.discord_id),
                    row.discord_enc || encrypt(row.discord_id),
                    row.username && String(row.username).startsWith("enc:") ? row.username : encrypt(row.username),
                    row.responsibilities && String(row.responsibilities).startsWith("enc:")
                        ? row.responsibilities
                        : encrypt(row.responsibilities || ""),
                    row.discord_id
                ]
            );
        } else {
            const changes = [];
            const values = [];

            if (row.username && !String(row.username).startsWith("enc:")) {
                changes.push("username = ?");
                values.push(encrypt(row.username));
            }

            if (row.responsibilities && !String(row.responsibilities).startsWith("enc:")) {
                changes.push("responsibilities = ?");
                values.push(encrypt(row.responsibilities));
            }

            if (changes.length) {
                values.push(row.discord_id);
                await db.query(
                    `UPDATE staff SET ${changes.join(", ")} WHERE discord_id = ?`,
                    values
                );
            }
        }
    }

    const [events] = await db.query(
        "SELECT id, who, text FROM app_events"
    );

    for (const row of events) {
        const who = row.who && !String(row.who).startsWith("enc:") ? encrypt(row.who) : row.who;
        const text = row.text && !String(row.text).startsWith("enc:") ? encrypt(row.text) : row.text;

        if (who !== row.who || text !== row.text) {
            await db.query(
                "UPDATE app_events SET who = ?, text = ? WHERE id = ?",
                [who, text, row.id]
            );
        }
    }

    const [notifications] = await db.query(
        "SELECT id, discord_id, text FROM notifications"
    );

    for (const row of notifications) {
        const id = /^\d{17,20}$/.test(String(row.discord_id))
            ? blind(row.discord_id)
            : row.discord_id;

        const text = row.text && !String(row.text).startsWith("enc:")
            ? encrypt(row.text)
            : row.text;

        if (id !== row.discord_id || text !== row.text) {
            await db.query(
                "UPDATE notifications SET discord_id = ?, text = ? WHERE id = ?",
                [id, text, row.id]
            );
        }
    }
}

async function seedDepartments() {
    const [rows] = await db.query(
        "SELECT COUNT(*) AS n FROM departments"
    );

    if (Number(rows[0].n) > 0) return;

    const defaults = ["Operations", "Community", "Development", "Moderation"];

    for (const name of defaults) {
        await db.query(
            "INSERT IGNORE INTO departments (name, description, created_at) VALUES (?, '', UTC_TIMESTAMP())",
            [name]
        );
    }
}

async function migrateLegacyApplications() {
    const [rows] = await db.query(
        `SELECT id, job_id, title, dept, answers, position_id, question_snapshot
        FROM applications WHERE position_id IS NULL OR position_id = 0`
    );

    for (const row of rows) {
        const [found] = await db.query(
            "SELECT id FROM positions WHERE id = ?",
            [row.job_id]
        );

        if (found.length) {
            await db.query(
                "UPDATE applications SET position_id = ? WHERE id = ?",
                [row.job_id, row.id]
            );
            continue;
        }

        const [departments] = await db.query(
            "SELECT id FROM departments WHERE name = ? LIMIT 1",
            [row.dept]
        );

        let departmentId;

        if (departments.length) {
            departmentId = departments[0].id;
        } else {
            const [created] = await db.query(
                "INSERT INTO departments (name, description, created_at) VALUES (?, '', UTC_TIMESTAMP())",
                [row.dept || "General"]
            );
            departmentId = created.insertId;
        }

        const answers = jsonValue(row.answers, {});
        const questions = Object.keys(answers).map((key, index) => ({
            id: key,
            label: key,
            category: "general",
            minWords: 0,
            keywords: ""
        }));

        const [createdPosition] = await db.query(
            `INSERT INTO positions
            (department_id, title, type, blurb, about, requirements, questions,
            status, created_at, updated_at)
            VALUES (?, ?, 'Full-time', '', '', ?, ?, 'closed', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
            [
                departmentId,
                row.title,
                encrypt(JSON.stringify([])),
                encrypt(JSON.stringify(questions))
            ]
        );

        await db.query(
            "UPDATE applications SET position_id = ?, question_snapshot = ? WHERE id = ?",
            [
                createdPosition.insertId,
                encrypt(JSON.stringify(questions)),
                row.id
            ]
        );
    }

    const [missingSnapshots] = await db.query(
        "SELECT id, job_id, answers FROM applications WHERE question_snapshot IS NULL"
    );

    for (const row of missingSnapshots) {
        const [positions] = await db.query(
            "SELECT questions FROM positions WHERE id = ?",
            [row.job_id]
        );

        const questions = positions.length
            ? jsonValue(positions[0].questions, [])
            : [];

        await db.query(
            "UPDATE applications SET question_snapshot = ? WHERE id = ?",
            [encrypt(JSON.stringify(questions)), row.id]
        );
    }
}

const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    if (SECURE) {
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }

    let url;

    try {
        url = new URL(req.url, "http://localhost");
    } catch {
        res.writeHead(400);
        return res.end("Bad request");
    }

    try {
        if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) {
            res.setHeader("Cache-Control", "no-store");
            await handleRoute(req, res, url);
        } else {
            serveFile(res, url.pathname);
        }
    } catch (error) {
        console.error(error);

        if (!res.headersSent) {
            res.writeHead(500, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store"
            });
        }

        if (!res.writableEnded) {
            res.end(JSON.stringify({ error: "Server error." }));
        }
    }
});

let tunnel = null;
let stopping = false;
let databaseReady = false;

function startTunnel() {
    if (stopping || !TOKEN || !fs.existsSync(CLOUDFLARED)) return;

    tunnel = spawn(
        CLOUDFLARED,
        ["tunnel", "run", "--token", TOKEN],
        { stdio: ["ignore", "inherit", "inherit"] }
    );

    tunnel.on("error", error => {
        console.error("Could not start cloudflared:", error.message);
    });

    tunnel.on("exit", code => {
        if (stopping) return;
        console.error(`Tunnel stopped with code ${code}. Restarting in 5 seconds.`);
        setTimeout(startTunnel, 5000);
    });
}

async function shutdown() {
    if (stopping) return;
    stopping = true;

    if (tunnel) tunnel.kill();

    server.close(() => {
        db.end().finally(() => process.exit(0));
    });

    setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function start() {
    if (!TOKEN) {
        console.error("TUNNEL_TOKEN is missing from .env");
        process.exit(1);
    }

    if (DATA_KEY.length !== 32) {
        console.error("DATA_KEY must be 64 hexadecimal characters.");
        process.exit(1);
    }

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
        console.error("Discord OAuth configuration is incomplete.");
    }

    if (!ROLE_ID) {
        console.error("STAFF_DISCORD_ID is missing. Staff role access will be disabled.");
    }

    if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
        console.error("Database configuration is incomplete.");
        process.exit(1);
    }

    if (!fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
        console.error("public/index.html is missing.");
        process.exit(1);
    }

    await setupDatabase();
    databaseReady = true;

    console.log("Database ready.");

    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Website running on port ${PORT}`);
        console.log(`Serving ${PUBLIC_DIR}`);
    });

    if (fs.existsSync(CLOUDFLARED)) {
        startTunnel();
    } else {
        console.error(`cloudflared not found at ${CLOUDFLARED}`);
        console.error("The website will run locally without the tunnel.");
    }
}

start().catch(error => {
    console.error("Startup failed:", error);
    process.exit(1);
});
