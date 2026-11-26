/* Aria — chat logic.
 *
 * Two free brains, no API keys on your side and no backend:
 *   1. A keyless public model endpoint, used by default. It is paced
 *      (roughly one answer a minute per network) to stay free for everyone.
 *   2. Puter.js, an optional free account. When the visitor is signed in,
 *      replies stream instantly and the pacing doesn't apply.
 *
 * Live lookups: before answering a factual or "right now" question, the app
 * searches the web from the browser (DuckDuckGo results read through the public
 * r.jina.ai reader) and fetches public sources (Wikipedia in the visitor's
 * language, Open-Meteo weather, exchange rates, CoinGecko prices), then hands
 * the result to the model as evidence, with links shown under the reply.
 *
 * Chats live only in this browser (localStorage). Messages are sent to
 * whichever model provider answers; there is no analytics or tracking here.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "aria:chat:v1";
  const KEYLESS_ENDPOINT = "https://text.pollinations.ai/openai";
  const KEYLESS_PACE_SECONDS = 45;
  const REQUEST_TIMEOUT_MS = 75000;
  const PATIENCE_HINT_MS = 7000;
  const SYSTEM_PROMPT =
    "You are Aria, a friendly and practical assistant in a small, free chat app. " +
    "Help people with everyday things: quick questions, planning, writing, " +
    "explaining ideas, cooking, travel, study and light technical help. " +
    "Be warm, clear and concise. Prefer short paragraphs and short lists over long essays. " +
    "Use plain language, and use Markdown for structure and code. " +
    "If you are not sure about something, say so plainly instead of guessing. " +
    "Never invent facts, prices, sources or links. Today's date is " +
    new Date().toISOString().slice(0, 10) +
    ".";

  // Appended to the outgoing request only, never shown to the person.
  const LIVE_INSTRUCTIONS =
    " A LIVE INFO block may be attached after the conversation. When it is: base every " +
    "factual claim on it, quote its numbers as given, and link the sources you used. " +
    "When it holds WEB SEARCH RESULTS, those are fresh snippets from real sites: prefer a " +
    "figure stated there over memory, name the site it came from, and use them to make " +
    "the answer specific rather than general. " +
    "Start with the direct answer in one short line, then at most two or three sentences of " +
    "support. When several results give different numbers for the same thing, do not average " +
    "or merge them: give the newest figure first with its site and date, then note that an " +
    "older source says something different. " +
    "If the exact figure or detail the person asked for is not in it, say plainly that " +
    "it is not publicly published — never invent, round or guess a number. Never say " +
    "you cannot access the internet: this app looks things up for you. If the block " +
    "holds a related figure (a worldwide total, another year's figure) but not the exact " +
    "one asked for, state that figure first, clearly labelled for what it is, and only " +
    "then say the requested one is not published — do not leave a usable number out.";

  const el = {
    chat: document.getElementById("chat"),
    welcome: document.getElementById("welcome"),
    messages: document.getElementById("messages"),
    form: document.getElementById("composer"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    newChat: document.getElementById("newChat"),
  };

  /** @type {{role: "user"|"assistant", content: string}[]} */
  let history = [];
  let busy = false;
  let stopRequested = false;
  let aborter = null;

  /* ------------------------------------------------------------------ *
   * Markdown — small and safe: everything is escaped before formatting
   * ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    out = out.replace(
      /(^|\s)(https?:\/\/[^\s<]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
    );
    return out;
  }

  function renderMarkdown(source) {
    const blocks = [];
    const fenced = source.replace(
      /```([\w+-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g,
      (_m, lang, code) => {
        blocks.push({ lang: lang || "code", code: code.replace(/\n$/, "") });
        return `\u0000BLOCK${blocks.length - 1}\u0000`;
      }
    );

    const tables = [];
    const withTables = fenced.replace(
      /(^\|[^\n]*\|[ \t]*\n^\|[\s:|-]+\|[ \t]*\n(?:^\|[^\n]*\|[ \t]*(?:\n|$))*)/gm,
      (block) => {
        const cell = (value) => inline(value.replace(/<br\s*\/?>/gi, " · "));
        const rows = block
          .trim()
          .split("\n")
          .map((row) =>
            row
              .trim()
              .replace(/^\|/, "")
              .replace(/\|$/, "")
              .split("|")
              .map((value) => value.trim())
          );
        const head = rows[0] || [];
        const body = rows.slice(2);
        const html =
          '<div class="table-wrap"><table><thead><tr>' +
          head.map((value) => `<th>${cell(value)}</th>`).join("") +
          "</tr></thead><tbody>" +
          body
            .map(
              (row) => `<tr>${row.map((value) => `<td>${cell(value)}</td>`).join("")}</tr>`
            )
            .join("") +
          "</tbody></table></div>";
        tables.push(html);
        return `\u0000TABLE${tables.length - 1}\u0000`;
      }
    );

    const lines = withTables.split("\n");
    const out = [];
    let paragraph = [];
    let list = null;
    let quote = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${inline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
        quote = [];
      }
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const block = line.trim().match(/^\u0000BLOCK(\d+)\u0000$/);
      const table = line.trim().match(/^\u0000TABLE(\d+)\u0000$/);
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const quoteLine = line.match(/^>\s?(.*)$/);

      if (table) {
        flushAll();
        out.push(tables[Number(table[1])]);
        continue;
      }

      if (block) {
        flushAll();
        const b = blocks[Number(block[1])];
        out.push(
          `<div class="code-block"><header><span>${escapeHtml(b.lang)}</span>` +
            `<button class="copy" type="button" data-code="${encodeURIComponent(
              b.code
            )}">copy</button></header><pre><code>${escapeHtml(b.code)}</code></pre></div>`
        );
        continue;
      }

      if (!line.trim()) {
        flushAll();
        continue;
      }

      if (heading) {
        flushAll();
        const level = Math.min(3, heading[1].length);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      if (bullet) {
        flushParagraph();
        flushQuote();
        if (list !== "ul") {
          flushList();
          out.push("<ul>");
          list = "ul";
        }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }

      if (ordered) {
        flushParagraph();
        flushQuote();
        if (list !== "ol") {
          flushList();
          out.push("<ol>");
          list = "ol";
        }
        out.push(`<li>${inline(ordered[1])}</li>`);
        continue;
      }

      if (quoteLine) {
        flushParagraph();
        flushList();
        quote.push(quoteLine[1]);
        continue;
      }

      flushList();
      flushQuote();
      paragraph.push(line);
    }

    flushAll();
    return out.join("");
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  const DOTS =
    '<span class="typing" aria-label="Thinking"><span></span><span></span><span></span></span>';

  function scrollToBottom(smooth = true) {
    el.chat.scrollTo({
      top: el.chat.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }

  function addUserMessage(text) {
    const node = document.createElement("article");
    node.className = "msg user";
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = text;
    node.append(body);
    el.messages.append(node);
    return node;
  }

  function addAssistantMessage() {
    const node = document.createElement("article");
    node.className = "msg assistant";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.innerHTML =
      '<svg viewBox="0 0 32 32" width="16" height="16" fill="none">' +
      '<circle cx="16" cy="16" r="9" stroke="currentColor" stroke-width="2.6"/>' +
      '<circle cx="16" cy="16" r="3" fill="currentColor"/></svg>';

    const body = document.createElement("div");
    body.className = "body md";
    body.innerHTML = DOTS;

    node.append(avatar, body);
    el.messages.append(node);
    return { node, body };
  }

  function paint(body, text) {
    body.innerHTML = renderMarkdown(text);
  }

  function notice(body, text) {
    const p = document.createElement("p");
    p.className = "notice";
    p.textContent = text;
    body.append(p);
  }

  /* ------------------------------------------------------------------ *
   * Live lookups — public sources a browser is allowed to read directly
   * ------------------------------------------------------------------ */

  const LIVE_TIMEOUT_MS = 9000;
  const MAX_CONTEXT_CHARS = 5200;

  function uiLang() {
    const tag = String(navigator.language || "en").slice(0, 2).toLowerCase();
    return /^[a-z]{2}$/.test(tag) ? tag : "en";
  }

  async function getJson(url, ms = LIVE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(url, { signal: controller.signal, mode: "cors" });
      if (!response.ok) throw new Error(`lookup ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function getText(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(url, { signal: controller.signal, mode: "cors" });
      if (!response.ok) throw new Error(`lookup ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  // Question words and filler make Wikipedia rank the wrong article, so they go.
  const QUERY_STOP = new Set(
    ("how many much who what when where why which is are was were do does did can could " +
      "the a an of in on at to for from and or with me my i you it this that there " +
      "copies copy sold sales sell exact number total figure currently " +
      "chi cosa come quando dove perché perche quale quali quanti quante quanto " +
      "copie copia vendute venduto sono è e di del della dei delle un una il lo la gli le " +
      "nel nella mi ti si che hai ha ho").split(" ")
  );

  function tokenize(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function searchTokens(text) {
    return tokenize(text)
      .filter((word) => word.length > 1 && !QUERY_STOP.has(word))
      .slice(0, 10);
  }

  async function wikiTitles(lang, query, limit = 6) {
    const data = await getJson(
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
        `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&srnamespace=0&format=json&origin=*`
    );
    return ((data && data.query && data.query.search) || []).map((row) => row.title);
  }

  // Prefer the article whose title actually contains the words that were asked about,
  // and avoid long spin-off titles that merely repeat them.
  function scoreTitle(title, tokens) {
    const titleTokens = tokenize(title).filter((word) => !QUERY_STOP.has(word));
    const overlap = tokens.filter((token) =>
      titleTokens.some(
        (word) => word === token || word.startsWith(token) || token.startsWith(word)
      )
    ).length;
    return overlap * 2 - Math.max(0, titleTokens.length - overlap) * 0.6;
  }

  async function wikiSearch(lang, text) {
    const tokens = searchTokens(text);
    if (!tokens.length) return [];

    // Extra question words drag the ranking towards spin-offs, so search with the
    // core of the question ("diary wimpy kid", not "…kid sold in italy").
    let titles = await wikiTitles(lang, tokens.slice(0, 3).join(" "));
    if (!titles.length && tokens.length > 2) {
      titles = await wikiTitles(lang, tokens.slice(0, 2).join(" "));
    }
    if (!titles.length) return [];

    const ranked = titles
      .map((title) => ({ title, score: scoreTitle(title, tokens) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((row) => row.title);
    if (!ranked.length) return [];

    const data = await getJson(
      `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
        ranked.join("|")
      )}&prop=extracts|info&inprop=url&explaintext=1&exlimit=max&redirects=1&format=json&origin=*`
    );
    const pages = Object.values((data && data.query && data.query.pages) || {});
    const order = new Map(ranked.map((title, index) => [title, index]));

    return pages
      .sort((a, b) => (order.get(a.title) ?? 9) - (order.get(b.title) ?? 9))
      .map((page) => ({
        lang,
        title: page.title,
        url: page.fullurl,
        text: String(page.extract || "").replace(/\n{3,}/g, "\n\n"),
      }))
      .filter((page) => page.text.length > 80);
  }

  /* --- real web search -------------------------------------------------
   * DuckDuckGo's lite result page, read through r.jina.ai: a public reader that
   * turns a page into plain text and answers browsers directly, so no key, no
   * proxy of ours and no backend. Its free tier allows a few searches a minute;
   * when it paces us the answer simply falls back to Wikipedia.
   * ------------------------------------------------------------------- */

  const WEB_SEARCH_URL = "https://r.jina.ai/https://lite.duckduckgo.com/lite/?q=";
  const WEB_TIMEOUT_MS = 16000;
  const webCache = new Map();

  // The reader marks the words that matched as **bold**, sometimes glued together.
  function cleanSnippet(line) {
    return String(line)
      .replace(/\*{4,}/g, " ")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function realUrl(wrapped) {
    try {
      return new URL(wrapped).searchParams.get("uddg") || wrapped;
    } catch (_) {
      return wrapped;
    }
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (_) {
      return "web";
    }
  }

  // Lines look like: 1.[Title](https://duckduckgo.com/l/?uddg=…) / snippet / domain.
  function parseResults(markdown) {
    const lines = String(markdown).split("\n");
    const results = [];

    for (let i = 0; i < lines.length; i += 1) {
      const head = lines[i].match(/^\s*\d+\.\s*\[(.+?)\]\((https?:\/\/[^)\s]+)\)/);
      if (!head) continue;

      const snippet = [];
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j += 1) {
        const line = lines[j].trim();
        if (!line) {
          if (snippet.length) break;
          continue;
        }
        if (/^\d+\.\s*\[/.test(line)) break;
        if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(line)) break; // the bare domain line
        snippet.push(line);
      }

      results.push({
        title: cleanSnippet(head[1]),
        url: realUrl(head[2]),
        snippet: cleanSnippet(snippet.join(" ")).slice(0, 520),
      });
    }
    return results;
  }

  async function webSearch(text) {
    const query = text.replace(/[?!.\s]+$/, "").trim().slice(0, 180);
    if (query.length < 4) return [];

    const key = query.toLowerCase();
    const hit = webCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;

    const markdown = await getText(WEB_SEARCH_URL + encodeURIComponent(query), WEB_TIMEOUT_MS);
    const results = parseResults(markdown)
      .filter((row) => row.title && row.snippet.length > 50)
      .slice(0, 6);
    if (results.length) webCache.set(key, { at: Date.now(), value: results });
    return results;
  }

  async function safeWebSearch(text) {
    try {
      return await webSearch(text);
    } catch (_) {
      return []; // paced or offline: the reply just goes unhelped
    }
  }

  const MONEY = [
    { code: "EUR", re: /(\beur\b|\beuros?\b|€)/i },
    { code: "USD", re: /(\busd\b|\bdollars?\b|\bdollari\b|\bdollaro\b|\$)/i },
    { code: "GBP", re: /(\bgbp\b|\bpounds?\b|\bsterline\b|\bsterlina\b|£)/i },
    { code: "JPY", re: /(\bjpy\b|\byen\b)/i },
    { code: "CHF", re: /(\bchf\b|\bfranc[hi]\b)/i },
  ];

  function parseConversion(text) {
    const amount = text.match(/(\d[\d.,]*)/);
    if (!amount) return null;
    const value = Number(amount[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
    if (!isFinite(value) || value <= 0) return null;

    const hits = [];
    for (const money of MONEY) {
      const found = text.match(money.re);
      if (found) hits.push({ code: money.code, at: found.index || 0 });
    }
    hits.sort((a, b) => a.at - b.at);

    const codes = [];
    for (const hit of hits) if (!codes.includes(hit.code)) codes.push(hit.code);
    if (codes.length < 2) return null;

    return { value, from: codes[0], to: codes[1] };
  }

  async function liveCurrency(text) {
    const conv = parseConversion(text);
    if (!conv) return null;
    const data = await getJson(`https://open.er-api.com/v6/latest/${conv.from}`);
    const rate = data && data.rates && data.rates[conv.to];
    if (!rate) return null;
    return {
      line:
        `Live exchange rate (published ${data.time_last_update_utc || "recently"}): ` +
        `${conv.value} ${conv.from} = ${(conv.value * rate).toFixed(2)} ${conv.to}; ` +
        `1 ${conv.from} = ${rate.toFixed(4)} ${conv.to}.`,
      source: { title: "Live exchange rates", url: "https://www.exchangerate-api.com/" },
    };
  }

  const CRYPTO = {
    bitcoin: "bitcoin",
    btc: "bitcoin",
    ethereum: "ethereum",
    eth: "ethereum",
    solana: "solana",
    dogecoin: "dogecoin",
    doge: "dogecoin",
    ripple: "ripple",
    xrp: "ripple",
    cardano: "cardano",
    litecoin: "litecoin",
  };

  async function liveCrypto(text) {
    if (!/(price|worth|cost|value|prezzo|vale|quanto costa)/i.test(text)) return null;
    const ids = [];
    for (const [word, id] of Object.entries(CRYPTO)) {
      if (new RegExp(`\\b${word}\\b`, "i").test(text) && !ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return null;

    const data = await getJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(
        ","
      )}&vs_currencies=eur,usd&include_last_updated_at=true`
    );

    const lines = [];
    for (const id of ids) {
      const row = data && data[id];
      if (!row) continue;
      lines.push(`${id[0].toUpperCase() + id.slice(1)}: €${row.eur} / $${row.usd}`);
    }
    if (!lines.length) return null;

    const stamp = data[ids[0]] && data[ids[0]].last_updated_at;
    return {
      line:
        `Live crypto prices${stamp ? `, ${new Date(stamp * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}: ` +
        lines.join("; ") +
        ".",
      source: { title: "CoinGecko prices", url: "https://www.coingecko.com/" },
    };
  }

  const PLACE_STOP = new Set(
    ("the my a an il la lo le gli i di del della oggi domani today tomorrow now adesso " +
      "right just exactly currently current moment tonight morning evening afternoon " +
      "weekend week questa questo this next there here qui qua please per favore fuori " +
      "outside oggi domani stasera stamattina proprio").split(" ")
  );

  function placeCandidates(text) {
    const found = text.match(/\b(?:in|at|near|a|di|per)\s+([\p{L}'’.-]{3,}(?:\s+[\p{L}'’.-]{2,}){0,2})/u);
    if (!found) return [];

    const words = found[1]
      .split(/\s+/)
      .filter((word) => word.length > 1 && !PLACE_STOP.has(word.toLowerCase()));

    const candidates = [];
    if (words.length > 1) candidates.push(words.slice(0, 2).join(" "));
    if (words.length) candidates.push(words[0]);

    return candidates.map((place) => place.replace(/[.,;:!?]+$/, "")).filter(Boolean);
  }

  async function geocode(place) {
    const geo = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        place
      )}&count=5&language=${uiLang()}&format=json`
    );
    const results = (geo && geo.results) || [];
    if (!results.length) return null;
    // Several places can share a name; the busy one is almost always meant.
    return results.reduce((best, row) =>
      (row.population || 0) > (best.population || 0) ? row : best
    );
  }

  async function liveWeather(text) {
    let loc = null;
    for (const place of placeCandidates(text)) {
      loc = await geocode(place);
      if (loc) break;
    }
    if (!loc) return null;

    const data = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&forecast_days=2&timezone=auto`
    );
    const cur = data && data.current;
    if (!cur) return null;
    const day = data.daily || {};
    const at = (key) => (Array.isArray(day[key]) ? day[key][0] : "?");

    return {
      line:
        `Live weather, ${[loc.name, loc.country].filter(Boolean).join(", ")}: ` +
        `${cur.temperature_2m}°C (feels like ${cur.apparent_temperature}°C), wind ${cur.wind_speed_10m} km/h, ` +
        `humidity ${cur.relative_humidity_2m}%, precipitation ${cur.precipitation} mm, ` +
        `WMO condition ${cur.weather_code}. Today: high ${at("temperature_2m_max")}°C, ` +
        `low ${at("temperature_2m_min")}°C, rain chance ${at("precipitation_probability_max")}%. ` +
        `(WMO codes: 0 clear, 1-3 partly cloudy, 45-48 fog, 51-67 drizzle/rain, 71-77 snow, ` +
        `80-82 showers, 95-99 thunderstorm.)`,
      source: { title: `Weather · ${loc.name}`, url: "https://open-meteo.com/" },
    };
  }

  function looksLikeFactQuestion(text) {
    const trimmed = text.trim();
    if (trimmed.length < 12) return false;
    if (/^(write|draft|rewrite|translate|summarise|summarize|scrivimi|traduci|riassumi)\b/i.test(trimmed)) {
      return false;
    }
    return (
      /\?/.test(trimmed) ||
      /\b(who|what|when|where|why|how|which|is|are|was|were|does|did|can)\b/i.test(trimmed) ||
      /(^|[\s,;])(chi|cosa|come|quando|dove|perch[eé]|quale|quali|quanti|quante|quanto|quanta)([\s,;?!.]|$)/i.test(trimmed) ||
      /\b(today|now|current|latest|recent|oggi|adesso|attuale|ultimi|ultime|2026)\b/i.test(trimmed)
    );
  }

  const wikiCache = new Map();

  async function cachedWikiSearch(lang, text) {
    const key = `${lang}:${searchTokens(text).join(" ")}`;
    const hit = wikiCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const value = await wikiSearch(lang, text);
      wikiCache.set(key, { at: Date.now(), value });
      return value;
    } catch (_) {
      return []; // Wikipedia pacing us, or offline: the answer just goes unhelped
    }
  }

  async function wikiLookup(text) {
    const articles = [];
    for (const lang of [...new Set([uiLang(), "en"])]) {
      const found = await cachedWikiSearch(lang, text);
      for (const page of found) {
        if (!articles.some((article) => article.url === page.url)) articles.push(page);
      }
      if (articles.length >= 2) break;
    }
    return articles.slice(0, 3);
  }

  async function gatherLive(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const wantsWeather = /\b(weather|forecast|temperature|rain|umbrella|meteo|temperatura|pioggia|piove|nevica|caldo|freddo)\b/.test(lower);
    const wantsCrypto = /\b(bitcoin|btc|ethereum|eth|solana|dogecoin|doge|xrp|cardano|litecoin)\b/.test(lower);
    const wantsMoney = /(\d[\d.,]*)\s*(€|\$|£|\beur\b|\beuros?\b|\busd\b|\bdollars?\b|\bdollari\b|\bgbp\b|\bpounds?\b|\bsterline\b|\byen\b|\bjpy\b)/i.test(text);

    const tasks = [];
    if (wantsWeather) tasks.push(liveWeather(text));
    if (wantsCrypto) tasks.push(liveCrypto(text));
    if (wantsMoney) tasks.push(liveCurrency(text));

    const numbers = (await Promise.allSettled(tasks))
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);

    let articles = [];
    let results = [];
    if (looksLikeFactQuestion(text)) {
      // Search and encyclopaedia at the same time, so the lookup stays quick.
      const [found, pages] = await Promise.all([
        safeWebSearch(text),
        numbers.length || wantsWeather ? Promise.resolve([]) : wikiLookup(text),
      ]);
      results = found;
      articles = pages;
    }

    if (!numbers.length && !results.length && !articles.length) return null;

    const parts = [
      `LIVE INFO — fetched ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC ` +
        `from a live web search and public sources (DuckDuckGo, Wikipedia, Open-Meteo, ` +
        `exchange-rate and CoinGecko APIs). These are current, checkable facts; prefer ` +
        `them over memory.`,
    ];
    const sources = [];

    for (const item of numbers) {
      parts.push(item.line);
      if (item.source) sources.push(item.source);
    }

    let budget = MAX_CONTEXT_CHARS;

    if (results.length) {
      const found = [];
      for (const row of results) {
        const entry = `• ${row.title} — ${row.url}\n  ${row.snippet}`;
        if (budget - entry.length < 900) break;
        budget -= entry.length;
        found.push(entry);
        sources.push({ title: domainOf(row.url), url: row.url });
      }
      if (found.length) {
        parts.push(
          "WEB SEARCH RESULTS — live snippets from real sites, most relevant first:\n\n" +
            found.join("\n\n")
        );
      }
    }
    for (const page of articles.slice(0, 3)) {
      if (budget < 300) break;
      const body = page.text.slice(0, Math.min(1800, budget));
      budget -= body.length;
      parts.push(`[Wikipedia · ${page.lang}] ${page.title} — ${page.url}\n${body}`);
      sources.push({ title: `${page.title} · Wikipedia`, url: page.url });
    }

    return { block: parts.join("\n\n"), sources };
  }

  function currentQuestion() {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === "user") return history[i].content;
    }
    return "";
  }

  function attachSources(body, live) {
    if (!live || !live.sources || !live.sources.length) return;
    body.querySelectorAll(".sources").forEach((node) => node.remove());

    const seen = [];
    for (const source of live.sources) {
      if (source && source.url && !seen.some((item) => item.url === source.url)) seen.push(source);
    }
    if (!seen.length) return;

    const line = document.createElement("p");
    line.className = "sources";
    line.append(document.createTextNode("Looked up: "));
    seen.slice(0, 4).forEach((source, index) => {
      if (index) line.append(document.createTextNode(" · "));
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title;
      line.append(link);
    });
    body.append(line);
  }

  /* ------------------------------------------------------------------ *
   * Brains
   * ------------------------------------------------------------------ */

  function buildMessages(live) {
    const system = SYSTEM_PROMPT + (live && live.block ? LIVE_INSTRUCTIONS : "");
    const messages = [{ role: "system", content: system }, ...history];
    if (live && live.block) messages.push({ role: "system", content: live.block });
    return messages;
  }

  function puterReady() {
    try {
      return Boolean(
        window.puter &&
          window.puter.ai &&
          typeof window.puter.ai.chat === "function" &&
          window.puter.auth &&
          window.puter.auth.isSignedIn()
      );
    } catch (_) {
      return false;
    }
  }

  /** Keyless public endpoint. Throws with .rateLimit when it is pacing us. */
  async function askKeyless(body, live) {
    const controller = new AbortController();
    aborter = controller;
    const timer = setTimeout(() => {
      controller.timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(KEYLESS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai-fast", messages: buildMessages(live) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.timedOut) {
        const slow = new Error("The free lane took too long");
        slow.timedOut = true;
        throw slow;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 402 || response.status === 429) {
      const error = new Error("Free lane is pacing requests");
      error.rateLimit = true;
      error.retryAfter =
        Number(response.headers.get("retry-after")) || KEYLESS_PACE_SECONDS;
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Provider responded ${response.status}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response");

    // The free lane sometimes reports its own quota trouble as message text.
    if (/api key used for this request has reached its budget|raise the key budget/i.test(text)) {
      throw new Error("Free provider quota exhausted");
    }

    if (stopRequested) return { text, stopped: true };

    paint(body, text);
    scrollToBottom(false);
    return { text };
  }

  /** Optional free account: streams tokens as they arrive. */
  async function askPuter(body, live) {
    const response = await window.puter.ai.chat(buildMessages(live), { stream: true });
    let full = "";

    if (response && typeof response[Symbol.asyncIterator] === "function") {
      try {
        for await (const part of response) {
          if (stopRequested) break;
          const piece =
            typeof part === "string" ? part : part?.type === "text" || !part?.type ? part?.text : "";
          if (!piece) continue;
          full += piece;
          paint(body, full);
          scrollToBottom(false);
        }
      } catch (error) {
        error.partial = full;
        throw error;
      }
    } else {
      full =
        typeof response === "string"
          ? response
          : response?.message?.content ?? response?.text ?? "";
    }

    if (!full.trim()) throw new Error("Empty response");
    paint(body, full);
    return { text: full };
  }

  function showRateCard(body, retryAfter) {
    let left = Math.max(5, Math.min(120, Math.round(retryAfter || KEYLESS_PACE_SECONDS)));
    body.innerHTML = "";

    const card = document.createElement("div");
    card.className = "notice card";
    card.innerHTML =
      `<p>This lane is paced so it stays free — about one answer a minute, shared by everyone. ` +
      `I can answer again in <strong class="count">${left}s</strong>.</p>` +
      `<div class="notice-actions">` +
      `<button type="button" data-act="account">Instant replies with a free account</button>` +
      `<button type="button" data-act="retry">Try now</button>` +
      `</div>`;
    body.append(card);

    const countdown = card.querySelector(".count");
    const timer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        countdown.textContent = `${left}s`;
        return;
      }
      clearInterval(timer);
      countdown.textContent = "now";
      if (!busy) runTurn(body);
    }, 1000);

    card.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      clearInterval(timer);

      if (button.dataset.act === "account") {
        button.disabled = true;
        button.textContent = "Opening…";
        try {
          await window.puter.auth.signIn();
        } catch (_) {
          /* the popup was closed or blocked */
        }
        if (!puterReady()) {
          button.disabled = false;
          button.textContent = "Instant replies with a free account";
          return;
        }
      }

      if (!busy) runTurn(body);
    });
  }

  function showErrorCard(body, timedOut = false) {
    body.innerHTML =
      `<p class="notice">${
        timedOut
          ? "That took too long, so I stopped waiting. The free lane gets busy sometimes."
          : "I couldn't reach a model just now. Give it a moment and try again."
      }</p>` +
      '<div class="notice-actions"><button type="button" data-act="retry">Try again</button></div>';

    body.querySelector('[data-act="retry"]').addEventListener("click", () => {
      if (!busy) runTurn(body);
    });
  }

  /* ------------------------------------------------------------------ *
   * One turn: ask, render, remember
   * ------------------------------------------------------------------ */

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (_) {
      /* private mode or full storage — the chat just won't persist */
    }
  }

  function rememberTurn(result) {
    const text = (result && result.text) || "";
    if (!text.trim()) return;
    history.push({ role: "assistant", content: text });
    save();
  }

  async function respond(body) {
    const hint = setTimeout(() => {
      if (!busy || stopRequested || !body.querySelector(".typing")) return;
      const line = document.createElement("p");
      line.className = "wait-hint";
      line.textContent = "Free lane is busy — this can take up to a minute.";
      body.append(line);
    }, PATIENCE_HINT_MS);

    let live = null;
    try {
      live = await gatherLive(currentQuestion());
    } catch (_) {
      live = null; // a lookup is a bonus: never hold the answer up for it
    }

    try {
      await attempt(body, live);
    } finally {
      clearTimeout(hint);
    }
  }

  async function attempt(body, live) {
    if (puterReady()) {
      try {
        const streamed = await askPuter(body, live);
        attachSources(body, live);
        return rememberTurn(streamed);
      } catch (error) {
        if (error.partial) {
          // Keep what arrived, and say so instead of silently retrying.
          notice(body, "The connection dropped mid-answer — the reply above may be incomplete.");
          return rememberTurn({ text: error.partial });
        }
        body.innerHTML = DOTS;
      }
    }

    try {
      const answer = await askKeyless(body, live);
      attachSources(body, live);
      return rememberTurn(answer);
    } catch (error) {
      body.innerHTML = "";
      if (error.name === "AbortError" || stopRequested) {
        notice(body, "Stopped.");
        return;
      }
      if (error.rateLimit) {
        showRateCard(body, error.retryAfter);
        return;
      }
      showErrorCard(body, Boolean(error.timedOut));
    }
  }

  async function runTurn(body) {
    if (busy) return;
    busy = true;
    stopRequested = false;
    body.innerHTML = DOTS;
    updateComposer();

    await respond(body);

    busy = false;
    updateComposer();
    scrollToBottom();
  }

  async function send(text) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    el.welcome.hidden = true;
    el.input.value = "";
    autoGrow();
    updateComposer();

    history.push({ role: "user", content: trimmed });
    addUserMessage(trimmed);
    const { body } = addAssistantMessage();
    scrollToBottom();

    await runTurn(body);
  }

  /* ------------------------------------------------------------------ *
   * Restore
   * ------------------------------------------------------------------ */

  function restore() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) {
      saved = null;
    }

    if (!Array.isArray(saved) || saved.length === 0) return;

    history = saved
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string"
      )
      .slice(-80);

    if (!history.length) return;

    el.welcome.hidden = true;
    for (const message of history) {
      if (message.role === "user") {
        addUserMessage(message.content);
      } else {
        const { body } = addAssistantMessage();
        paint(body, message.content);
      }
    }
    requestAnimationFrame(() => scrollToBottom(false));
  }

  /* ------------------------------------------------------------------ *
   * UI wiring
   * ------------------------------------------------------------------ */

  function autoGrow() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(el.input.scrollHeight, el.input.clientHeight + 400)}px`;
  }

  function updateComposer() {
    el.send.disabled = busy ? false : !el.input.value.trim();
    el.send.classList.toggle("busy", busy);
    el.send.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
  }

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) {
      stopRequested = true;
      if (aborter) aborter.abort();
      return;
    }
    send(el.input.value);
  });

  el.input.addEventListener("input", () => {
    autoGrow();
    updateComposer();
  });

  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!busy) send(el.input.value);
    }
  });

  el.newChat.addEventListener("click", () => {
    if (busy) return;
    history = [];
    save();
    el.messages.innerHTML = "";
    el.welcome.hidden = false;
    el.input.value = "";
    autoGrow();
    updateComposer();
    el.input.focus();
  });

  el.welcome.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    el.input.value = chip.textContent.trim();
    autoGrow();
    updateComposer();
    el.input.focus();
  });

  el.messages.addEventListener("click", async (event) => {
    const button = event.target.closest(".copy");
    if (!button) return;
    const code = decodeURIComponent(button.dataset.code || "");
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "copied";
      setTimeout(() => (button.textContent = "copy"), 1400);
    } catch (_) {
      button.textContent = "select + copy";
    }
  });

  restore();
  autoGrow();
  updateComposer();
  if (window.matchMedia("(min-width: 700px)").matches) el.input.focus();
})();
