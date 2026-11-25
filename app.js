/* Aria — chat logic.
 *
 * Two free brains, no API keys on your side and no backend:
 *   1. A keyless public model endpoint, used by default. It is paced
 *      (roughly one answer a minute per network) to stay free for everyone.
 *   2. Puter.js, an optional free account. When the visitor is signed in,
 *      replies stream instantly and the pacing doesn't apply.
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
   * Brains
   * ------------------------------------------------------------------ */

  function buildMessages() {
    return [{ role: "system", content: SYSTEM_PROMPT }, ...history];
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
  async function askKeyless(body) {
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
        body: JSON.stringify({ model: "openai-fast", messages: buildMessages() }),
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
  async function askPuter(body) {
    const response = await window.puter.ai.chat(buildMessages(), { stream: true });
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

    try {
      await attempt(body);
    } finally {
      clearTimeout(hint);
    }
  }

  async function attempt(body) {
    if (puterReady()) {
      try {
        return rememberTurn(await askPuter(body));
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
      return rememberTurn(await askKeyless(body));
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
