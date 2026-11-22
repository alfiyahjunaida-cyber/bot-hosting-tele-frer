
const crypto = require("crypto");

const DB = process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  if (!DB || !DB_TOKEN) throw new Error("Upstash belum dikonfigurasi");

  const r = await fetch(DB, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DB_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || "Redis error");
  return d.result;
}

const botKey = id => `telehost:bot:${id}`;
const usersKey = id => `telehost:users:${id}`;
const statsKey = id => `telehost:stats:${id}`;
const jobsKey = "telehost:scheduled";

const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function authorized(req) {
  return Boolean(process.env.ADMIN_KEY &&
    safeEqual(String(req.headers["x-admin-key"] || ""), process.env.ADMIN_KEY));
}

function configDefaults(config = {}) {
  return {
    startText: "Halo! Bot berhasil aktif.",
    helpText: "Gunakan /start untuk memulai.",
    menu: [],
    inline: [],
    welcomeText: "Selamat datang {name}!",
    blockedWords: [],
    moderation: false,
    aiEnabled: false,
    aiPrompt: "Kamu adalah asisten yang ramah.",
    ...config
  };
}

async function getBot(id) {
  const data = await redis(["GET", botKey(id)]);
  return data ? JSON.parse(data) : null;
}

async function saveBot(bot) {
  await redis(["SET", botKey(bot.id), JSON.stringify(bot)]);
}

async function tg(bot, method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${bot.token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

function publicBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    username: bot.username,
    config: configDefaults(bot.config),
    webhookActive: true
  };
}

function validateButtons(items) {
  if (!Array.isArray(items) || items.length > 20)
    throw new Error("Maksimal 20 tombol per jenis menu.");

  return items.map(item => {
    const text = String(item.text || "").trim().slice(0, 48);
    const reply = String(item.reply || "").trim().slice(0, 3500);
    if (!text || !reply) throw new Error("Tombol harus memiliki text dan reply.");
    return { text, reply };
  });
}

async function sendText(bot, chatId, text, config) {
  const body = {
    chat_id: chatId,
    text: String(text).slice(0, 4000)
  };

  if (config.menu?.length) {
    body.reply_markup = {
      keyboard: config.menu.map(item => [{ text: item.text }]),
      resize_keyboard: true
    };
  }

  if (config.inline?.length) {
    body.reply_markup = {
      inline_keyboard: config.inline.map((item, i) => [{
        text: item.text,
        callback_data: `menu_${i}`
      }])
    };
  }

  return tg(bot, "sendMessage", body);
}

async function aiReply(bot, chatId, text) {
  if (!process.env.OPENAI_API_KEY) return;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: bot.config.aiPrompt },
        { role: "user", content: text.slice(0, 3000) }
      ],
      max_tokens: 500
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "AI request gagal");

  const answer = data.choices?.[0]?.message?.content;
  if (answer) await tg(bot, "sendMessage", {
    chat_id: chatId,
    text: answer.slice(0, 4000)
  });
}

async function handleUpdate(bot, update) {
  const config = configDefaults(bot.config);

  // Inline keyboard callback
  if (update.callback_query) {
    const query = update.callback_query;
    const match = /^menu_(\d+)$/.exec(query.data || "");

    await tg(bot, "answerCallbackQuery", {
      callback_query_id: query.id
    });

    if (match) {
      const item = config.inline[Number(match[1])];
      if (item) await tg(bot, "sendMessage", {
        chat_id: query.message.chat.id,
        text: item.reply
      });
    }
    return;
  }

  const message = update.message;
  if (!message || !message.chat) return;

  const chat = message.chat;
  const chatId = chat.id;
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  // Welcome new members
  if (message.new_chat_members?.length) {
    for (const member of message.new_chat_members) {
      const welcome = config.welcomeText
        .replaceAll("{name}", member.first_name || "teman")
        .replaceAll("{username}", member.username || "");
      await tg(bot, "sendMessage", { chat_id: chatId, text: welcome });
    }
  }

  if (message.from && !message.from.is_bot) {
    await redis(["SADD", usersKey(bot.id), String(chatId)]);
  }

  await redis(["HINCRBY", statsKey(bot.id), "messages", "1"]);

  if (typeof message.text !== "string") return;
  const text = message.text.trim();

  // Group moderation
  if (isGroup && config.moderation && message.message_id) {
    const blocked = config.blockedWords || [];
    const containsBlocked = blocked.some(word =>
      word && text.toLowerCase().includes(word.toLowerCase())
    );

    if (containsBlocked) {
      try {
        await tg(bot, "deleteMessage", {
          chat_id: chatId,
          message_id: message.message_id
        });
      } catch (_) {}
      return;
    }
  }

  if (text === "/start" || text.startsWith("/start ")) {
    await sendText(bot, chatId, config.startText, config);
    return;
  }

  if (text === "/help" || text.startsWith("/help ")) {
    await sendText(bot, chatId, config.helpText, config);
    return;
  }

  const menuItem = config.menu.find(item =>
    item.text.toLowerCase() === text.toLowerCase()
  );

  if (menuItem) {
    await sendText(bot, chatId, menuItem.reply, config);
    return;
  }

  if (config.aiEnabled && !text.startsWith("/")) {
    await aiReply(bot, chatId, text);
  }
}

async function adminHandler(req, res, action) {
  if (!authorized(req)) {
    return res.status(401).json({ error: "ADMIN_KEY tidak valid." });
  }

  const body = req.body || {};
  const id = String(body.id || req.query.id || "");

  if (req.method === "GET" && action === "list") {
    const keys = await redis(["KEYS", "telehost:bot:*"]);
    const bots = [];

    for (const key of keys || []) {
      const raw = await redis(["GET", key]);
      if (raw) bots.push(publicBot(JSON.parse(raw)));
    }

    return res.status(200).json({ bots });
  }

  if (req.method === "POST" && action === "create") {
    const name = String(body.name || "").trim().slice(0, 60);
    const token = String(body.token || "").trim();

    if (!name || !token)
      return res.status(400).json({ error: "Nama dan token wajib diisi." });

    const check = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const me = await check.json();

    if (!me.ok)
      return res.status(400).json({ error: "Token Telegram tidak valid." });

    const botId = crypto.randomBytes(10).toString("hex");
    const secret = crypto.randomBytes(24).toString("hex");
    const appUrl = (process.env.APP_URL ||
      `https://${req.headers.host}`).replace(/\/$/, "");

    const bot = {
      id: botId,
      name,
      token,
      username: me.result.username || "",
      secret,
      config: configDefaults(),
      createdAt: new Date().toISOString()
    };

    await saveBot(bot);

    try {
      await tg(bot, "setWebhook", {
        url: `${appUrl}/api/index?hook=${botId}`,
        secret_token: secret,
        allowed_updates: [
          "message",
          "callback_query"
        ]
      });
    } catch (error) {
      await redis(["DEL", botKey(botId)]);
      throw error;
    }

    return res.status(201).json({
      message: "Bot berhasil ditambahkan dan webhook aktif.",
      bot: publicBot(bot)
    });
  }

  if (req.method === "GET" && action === "stats") {
    const bot = await getBot(id);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan." });

    const users = await redis(["SCARD", usersKey(id)]);
    const messages = await redis(["HGET", statsKey(id), "messages"]);

    return res.status(200).json({
      users: Number(users || 0),
      messages: Number(messages || 0)
    });
  }

  if (req.method === "GET" && action === "export") {
    const bot = await getBot(id);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan." });
    return res.status(200).json({ config: configDefaults(bot.config) });
  }

  if (req.method === "POST" && action === "update") {
    const bot = await getBot(id);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan." });

    const incoming = body.config || {};
    const config = { ...configDefaults(bot.config), ...incoming };

    config.menu = validateButtons(config.menu || []);
    config.inline = validateButtons(config.inline || []);
    config.blockedWords = Array.isArray(config.blockedWords)
      ? config.blockedWords.slice(0, 100).map(x => String(x).slice(0, 80))
      : [];

    config.startText = String(config.startText || "").slice(0, 3500);
    config.helpText = String(config.helpText || "").slice(0, 3500);
    config.welcomeText = String(config.welcomeText || "").slice(0, 1000);
    config.aiPrompt = String(config.aiPrompt || "").slice(0, 2000);
    config.moderation = config.moderation === true;
    config.aiEnabled = config.aiEnabled === true;

    bot.config = config;
    await saveBot(bot);

    return res.status(200).json({ message: "Konfigurasi berhasil disimpan." });
  }

  if (req.method === "POST" && action === "broadcast") {
    const bot = await getBot(id);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan." });

    const text = String(body.text || "").trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: "Pesan kosong." });

    const users = await redis(["SMEMBERS", usersKey(id)]);
    const batch = (users || []).slice(0, 20);
    let sent = 0, failed = 0;

    for (const chatId of batch) {
      try {
        await tg(bot, "sendMessage", { chat_id: chatId, text });
        sent++;
      } catch (_) {
        failed++;
      }
    }

    return res.status(200).json({
      sent,
      failed,
      remaining: Math.max(0, (users || []).length - batch.length)
    });
  }

  if (req.method === "POST" && action === "schedule") {
    const bot = await getBot(id);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan." });

    const at = Number(body.at);
    const chatId = String(body.chatId || "");
    const text = String(body.text || "").trim();

    if (!Number.isFinite(at) || at <= Date.now() ||
        !chatId || !text || text.length > 4000) {
      return res.status(400).json({ error: "Jadwal, chat ID, atau pesan tidak valid." });
    }

    const job = {
      id: crypto.randomBytes(8).toString("hex"),
      botId: id,
      chatId,
      text,
      at
    };

    await redis(["ZADD", jobsKey, at, JSON.stringify(job)]);
    return res.status(201).json({ message: "Jadwal berhasil dibuat." });
  }

  if (req.method === "POST" && action === "delete") {
    const bot = await getBot(id);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan." });

    try {
      await tg(bot, "deleteWebhook", {});
    } catch (_) {}

    await redis(["DEL", botKey(id)]);
    return res.status(200).json({ message: "Bot berhasil dihapus." });
  }

  return res.status(404).json({ error: "Action tidak ditemukan." });
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const action = url.searchParams.get("action");
    const hookId = url.searchParams.get("hook");

    // Telegram webhook endpoint
    if (req.method === "POST" && hookId) {
      const bot = await getBot(hookId);
      if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan." });

      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (!safeEqual(String(secret || ""), bot.secret)) {
        return res.status(401).json({ error: "Webhook secret tidak valid." });
      }

      await handleUpdate(bot, req.body || {});
      return res.status(200).json({ ok: true });
    }

    // Scheduler endpoint called by external scheduler
    if (action === "run-schedules" && req.method === "POST") {
      if (!process.env.CRON_SECRET ||
          !safeEqual(String(req.headers["x-cron-secret"] || ""), process.env.CRON_SECRET)) {
        return res.status(401).json({ error: "CRON_SECRET tidak valid." });
      }

      const now = Date.now();
      const jobs = await redis([
        "ZRANGEBYSCORE", jobsKey, "-inf", String(now), "LIMIT", "0", "10"
      ]);

      let sent = 0, failed = 0;
      for (const raw of jobs || []) {
        const job = JSON.parse(raw);
        // Remove first to prevent duplicate sends on overlapping invocations.
        await redis(["ZREM", jobsKey, raw]);

        try {
          const bot = await getBot(job.botId);
          if (!bot) throw new Error("Bot tidak ditemukan");
          await tg(bot, "sendMessage", {
            chat_id: job.chatId,
            text: job.text
          });
          sent++;
        } catch (_) {
          failed++;
        }
      }

      return res.status(200).json({ sent, failed });
    }

    return await adminHandler(req, res, action);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Server error." });
  }
};
