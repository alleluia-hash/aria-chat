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
  const SETTINGS_KEY = "aria:settings:v1";
  const VERSION = "1.3.0";
  const KEYLESS_ENDPOINT = "https://text.pollinations.ai/openai";
  const KEYLESS_PACE_SECONDS = 45;
  const REQUEST_TIMEOUT_MS = 75000;
  const PATIENCE_HINT_MS = 7000;
  const SYSTEM_PROMPT =
    "You are Aria, a friendly and practical assistant in a small, free chat app. " +
    "Aria is your name and your only identity. You are not ChatGPT, not OpenAI, and not " +
    "Claude, Gemini, Copilot or any other product: never call yourself by another " +
    "product's name, never say you were made by another company, and never describe " +
    "yourself as a model built into some other chat. " +
    "If someone asks who or what you are, or whether they are talking to a website or " +
    "to the app, answer as Aria in one short line -- you are Aria, the assistant built " +
    "into this app -- and then carry on helping. " +
    "Your job is to finish the task, not to talk about it. Work out what the person " +
    "actually needs, then do it and hand back the finished thing: the email written, " +
    "the plan complete, the code that runs, the answer that settles the question. " +
    "When a request is vague but a sensible default exists, pick it, state your " +
    "assumption in one short line, and carry on; only ask a question when the answer " +
    "would really change what you produce. " +
    "For anything with several steps, give short numbered steps and then carry them out; " +
    "for a single deliverable, just produce it. " +
    "Never leave placeholders, brackets or 'insert your -- here' marks: write the real content. " +
    "Use the person's own details from the conversation and from any attached file. " +
    "Be warm, clear and concise: short paragraphs, tight lists, no padding, and never " +
    "restate the question back at them. " +
    "Use plain language, and use Markdown for structure and code. " +
    "If you are not sure about something, say so plainly instead of guessing. " +
    "Never invent facts, prices, sources or links. Today's date is " +
    new Date().toISOString().slice(0, 10) +
    ".";

  // Attached only when someone asks about the assistant or the app itself.
  const SELF_NOTE =
    "IDENTITY: This app is called Aria, and you are Aria, the assistant built into it. " +
    "Aria exists as a website and as installable apps for Android and Windows; on iPhone " +
    "the website is added to the home screen. You are not ChatGPT or any other product, " +
    "whatever the person suspects. Answer who you are in one short line, plainly, and " +
    "never mention OpenAI or another company as your maker.";

  // "Are you ChatGPT?", "is this the website or the Aria app?": a web search only
  // drags in unrelated products that happen to be called Aria, so skip it there.
  function asksAboutItself(text) {
    if (!text) return false;
    return /\b(?:chatgpt|openai|gpt-?[345]|your (?:name|model|maker|creator|developer)|who (?:are|made|built|created|designed) you|what are you|are you (?:really )?(?:a |an )?(?:real |actual )?(?:ai|bot|robot|human|person|chatgpt|openai)|is this (?:the|your) (?:aria )?(?:app|application|website|site)|aria app\b|the aria (?:app|website|site))/i.test(
      text
    );
  }

  // A free model sometimes forgets whose app it is in and introduces itself as
  // ChatGPT; put Aria's name back wherever that happens.
  function fixIdentity(text) {
    if (!text) return text;
    const other = "(?:ChatGPT|OpenAI|an? (?:AI (?:assistant|language model)|large language model)(?: (?:built|developed|created|made) by OpenAI)?)";
    return String(text)
      .replace(new RegExp(`\\bI(?:'|’)m\\s+(?:just\\s+)?${other}\\b`, "gi"), "I'm Aria")
      .replace(new RegExp(`\\bI am\\s+(?:just\\s+)?${other}\\b`, "gi"), "I am Aria")
      .replace(
        /\bAs an? (?:AI (?:language model|assistant)|large language model)(?: (?:built|developed|created|made) by OpenAI)?,?\s*/gi,
        ""
      )
      .replace(/\s,(?:\s+(?:developed|created|built|made|trained) by OpenAI)/gi, "")
      .replace(/\s(?:developed|created|built|made|trained) by OpenAI\b/gi, "")
      .replace(
        /\s*[—–-]\s*not a separate ["“‘]?Aria["”’]?\s+(?:app|application|website|site)[^.]*\.?/gi,
        " — you're chatting inside the Aria app itself."
      );
  }

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

  // Files are read in the browser and their text joins the message, so the model
  // sees a plain block it can work from.
  const FILES_INSTRUCTIONS =
    " ATTACHED FILES appear in the conversation as blocks that begin with " +
    "\"[Attached file: name -- type, size]\", followed by the file's contents or a note " +
    "saying they could not be read. Treat those contents as the working material for the " +
    "task: quote exact names, numbers, dates and lines from them instead of paraphrasing " +
    "loosely, and build the answer on them. If a block says the contents could not be read, " +
    "for example a scan or a photo, say so in one line and ask for the detail you need -- " +
    "never guess what a file contained and never claim to have opened something that was " +
    "not attached.";

  // Pictures: the browser measures the pixels here; a free account adds real eyes.
  const PICTURE_INSTRUCTIONS =
    " A PICTURE block begins \"[Picture: name -- measured in this browser]\" and holds " +
    "measurements taken from the image itself: size and shape, what kind of picture it looks " +
    "like, background, main colours, light and contrast, where the busy and empty parts sit, " +
    "and how many rows of small marks it has. Reason from those measurements: say what kind " +
    "of picture it is, how it is laid out, and what the person most likely needs from it. You " +
    "cannot decode the words inside a picture from measurements, so never invent a caption, " +
    "number, name or line of text that was not measured. When the exact text matters, say " +
    "plainly that the words inside a picture cannot be read here, ask for them, and mention " +
    "that a free account adds a model that can read the picture itself. Never say you cannot " +
    "see the picture: you have its measurements.";

  // Files out: the model describes the file, the browser builds the real thing.
  const FILE_INSTRUCTIONS =
    " DELIVERING A FILE. When the person asks for something they can open and keep -- a " +
    "document, report, letter, resume, spreadsheet, budget, table, slide deck, PDF -- do the " +
    "work, then emit it as one fenced block that starts with ```aria-file and holds ONE JSON " +
    "object, then close the fence. Nothing else goes inside that fence. Shape: " +
    '{"kind":"docx","name":"q3-budget","title":"Q3 budget","blocks":' +
    '[{"t":"h1","text":"Q3 budget"},{"t":"p","text":"..."},' +
    '{"t":"bullet","text":"..."},{"t":"table","head":["Item","Cost"],' +
    '"rows":[["Rent","1200"]]}]}. ' +
    "kind is docx, xlsx, pptx, pdf, csv, md, txt or html; name is short, with no extension. " +
    "Blocks for docx, pdf and html: t is h1, h2, h3, p, bullet, num, quote, code, table or " +
    "pagebreak. For xlsx use " +
    '{"t":"sheet","name":"Budget","rows":[["Item","Cost"],["Rent",1200]]} -- one block per ' +
    "sheet, numbers as numbers. For pptx use " +
    '{"t":"slide","title":"...","bullets":["..."]} -- one block per slide. The JSON must be ' +
    "strictly valid: double quotes, no comments, no trailing commas, no unescaped line breaks, " +
    "no markdown inside strings. Write the whole file, never a placeholder. Say one short line " +
    "before the fence and nothing after it. If they did not ask for a file, do not emit one.";

  const el = {
    chat: document.getElementById("chat"),
    welcome: document.getElementById("welcome"),
    messages: document.getElementById("messages"),
    form: document.getElementById("composer"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    newChat: document.getElementById("newChat"),
    attach: document.getElementById("attach"),
    fileInput: document.getElementById("fileInput"),
    attachments: document.getElementById("attachments"),
    settings: document.getElementById("settings"),
    settingsBtn: document.getElementById("settingsBtn"),
    laneText: document.getElementById("laneText"),
    laneButton: document.getElementById("laneButton"),
    clearChatBtn: document.getElementById("clearChatBtn"),
    resetSettingsBtn: document.getElementById("resetSettingsBtn"),
  };

  /** @type {{role: "user"|"assistant", content: string}[]} */
  let history = [];
  /** @type {{id: string, name: string, size: number, type: string, state: string, label: string, text: string, note: string}[]} */
  let attachments = [];
  let attachmentSeq = 0;
  let busy = false;
  let stopRequested = false;
  let aborter = null;
  /** @type {File[]} the pictures of the turn being asked, for a lane that can see them */
  let pendingImages = [];

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
        const body = code.replace(/\n$/, "");
        // A file the app builds itself becomes a card, never raw JSON on screen.
        if (/^aria-file/i.test(lang)) return "";
        if (/"kind"\s*:/.test(body)) {
          const spec = readSpec(body);
          const named = spec ? String(spec.kind || "").toLowerCase().replace(/[^a-z]/g, "") : "";
          if (spec && FILE_KINDS[named]) return "";
        }
        blocks.push({ lang: lang || "code", code: body });
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

  function addUserMessage(text, files) {
    const node = document.createElement("article");
    node.className = "msg user";
    const body = document.createElement("div");
    body.className = "body";

    if (files && files.length) {
      const list = document.createElement("div");
      list.className = "files";
      for (const record of files) list.append(attachmentChip(record, false));
      body.append(list);
    }

    if (text) {
      const line = document.createElement("div");
      line.className = "text";
      line.textContent = text;
      body.append(line);
    }

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

  function paint(body, text, streaming = false) {
    const clean = fixIdentity(text);
    if (!streaming) body.dataset.text = clean;
    body.innerHTML = renderMarkdown(clean);
    mountFiles(body, clean, streaming);
  }

  function notice(body, text) {
    const p = document.createElement("p");
    p.className = "notice";
    p.textContent = text;
    body.append(p);
  }

  /* ------------------------------------------------------------------ *
   * Attachments — any file at all, read here in the browser, never sent
   * anywhere except as text inside the message the person chose to send
   * ------------------------------------------------------------------ */

  const MAX_FILES = 10;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_FILE_CHARS = 16000;
  const MAX_TOTAL_CHARS = 42000;

  const TEXT_EXTENSIONS = new Set(
    ("txt text md markdown rst log csv tsv json jsonl ndjson yaml yml toml ini cfg conf " +
      "xml html htm svg css scss less sass js mjs cjs jsx ts tsx py rb php pl pm lua go rs " +
      "java kt kts swift c h cc cpp cxx hpp cs m mm sh bash zsh fish ps1 bat cmd sql graphql " +
      "gql vue svelte astro diff patch tex bib org r tf srt vtt ics properties gradle env").split(" ")
  );

  // The document parts worth reading inside a Word/Excel/PowerPoint/ODF container.
  const ARCHIVE_PARTS = [
    /^word\/document\.xml$/i,
    /^word\/footnotes\.xml$/i,
    /^xl\/sharedStrings\.xml$/i,
    /^xl\/worksheets\/sheet\d+\.xml$/i,
    /^ppt\/slides\/slide\d+\.xml$/i,
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/i,
    /^content\.xml$/i,
  ];

  function humanSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function extensionOf(name) {
    const found = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
    return found ? found[1].toLowerCase() : "";
  }

  // "deflate" is zlib-wrapped (PDF), "deflate-raw" is bare (zip containers).
  async function inflateBytes(bytes, format) {
    if (typeof DecompressionStream !== "function") return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {
      return null;
    }
  }

  function looksBinary(bytes) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
    if (!sample.length) return false;
    if (sample.includes(0)) return true;
    let odd = 0;
    for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) odd += 1;
    return odd / sample.length > 0.05;
  }

  function decodeText(bytes) {
    let text = "";
    try {
      text = new TextDecoder("utf-8").decode(bytes);
    } catch (_) {
      text = new TextDecoder("latin1").decode(bytes);
    }
    return text
      .replace(/\u0000/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  function mediaKind(bytes, type) {
    const declared = String(type || "");
    if (/^image\//.test(declared)) return "picture";
    if (/^audio\//.test(declared)) return "audio file";
    if (/^video\//.test(declared)) return "video";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "picture";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "picture";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "picture";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) {
      return "picture";
    }
    return "";
  }

  /* --- PDF: pull the text out of the page streams --------------------- */

  function pdfLiteral(raw) {
    const body = raw.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const next = body[i + 1];
      if (next === undefined) break;
      if (next === "n" || next === "r") {
        out += "\n";
        i += 1;
      } else if (next === "t") {
        out += "\t";
        i += 1;
      } else if (next === "b" || next === "f") {
        i += 1;
      } else if (next === "(" || next === ")" || next === "\\") {
        out += next;
        i += 1;
      } else if (/[0-7]/.test(next)) {
        let oct = next;
        let k = i + 2;
        while (k < body.length && oct.length < 3 && /[0-7]/.test(body[k])) {
          oct += body[k];
          k += 1;
        }
        out += String.fromCharCode(parseInt(oct, 8));
        i = k - 1;
      } else {
        i += 1; // escaped newline or an unknown escape
      }
    }
    return out;
  }

  function pdfHex(raw) {
    const hex = raw.replace(/[^0-9A-Fa-f]/g, "");
    let out = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }

  function pdfStrings(content) {
    const out = [];
    let line = "";
    const tokens = /\[(?:\((?:\\.|[^\\()])*\)|[^\]])*\]\s*TJ|\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]{2,}>|\bT\*|\bTD\b|\bTd\b|\bET\b/g;
    let match;

    while ((match = tokens.exec(content))) {
      const token = match[0];

      if (token[0] === "[") {
        const array = token.replace(/\]\s*TJ$/, "");
        const items = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]{2,}>|-?[\d.]+/g;
        let item;
        while ((item = items.exec(array))) {
          const piece = item[0];
          if (piece[0] === "(") line += pdfLiteral(piece);
          else if (piece[0] === "<") line += pdfHex(piece);
          else if (Number(piece) < -60) line += " "; // a wide gap between words
        }
        continue;
      }

      if (token === "T*" || token === "TD" || token === "Td" || token === "ET") {
        if (line.trim()) {
          out.push(line.trim());
          line = "";
        }
        continue;
      }

      if (token[0] === "(") line += pdfLiteral(token);
      else if (token[0] === "<") line += pdfHex(token);
    }

    if (line.trim()) out.push(line.trim());
    return out.join("\n");
  }

  async function extractPdfText(bytes) {
    const latin = new TextDecoder("latin1").decode(bytes);
    const pieces = [];
    let index = 0;
    let streams = 0;

    while (streams < 400) {
      const start = latin.indexOf("stream", index);
      if (start === -1) break;
      let dataStart = start + 6;
      if (latin[dataStart] === "\r") dataStart += 1;
      if (latin[dataStart] === "\n") dataStart += 1;
      const end = latin.indexOf("endstream", dataStart);
      if (end === -1) break;
      index = end + 9;
      streams += 1;

      const raw = bytes.subarray(dataStart, end);
      const inflated = await inflateBytes(raw, "deflate");
      const content = new TextDecoder("latin1").decode(inflated || raw);
      if (!/\(|<[0-9A-Fa-f]/.test(content)) continue;

      const text = pdfStrings(content);
      if (text.trim()) pieces.push(text);
      if (pieces.join("\n").length > MAX_FILE_CHARS * 2) break;
    }

    return pieces.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* --- Zip containers: Word, Excel, PowerPoint, ODF, plain archives --- */

  function zipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const floor = Math.max(0, bytes.length - 66000);
    for (let i = bytes.length - 22; i >= floor; i -= 1) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];

    const count = view.getUint16(eocd + 10, true);
    const entries = [];
    let pointer = view.getUint32(eocd + 16, true);

    for (let i = 0; i < count && pointer + 46 <= bytes.length; i += 1) {
      if (view.getUint32(pointer, true) !== 0x02014b50) break;
      const nameLength = view.getUint16(pointer + 28, true);
      entries.push({
        name: new TextDecoder("utf-8").decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength)),
        method: view.getUint16(pointer + 10, true),
        compressedSize: view.getUint32(pointer + 20, true),
        localOffset: view.getUint32(pointer + 42, true),
      });
      pointer += 46 + nameLength + view.getUint16(pointer + 30, true) + view.getUint16(pointer + 32, true);
    }
    return entries;
  }

  async function readZipEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) return null;
    const start =
      entry.localOffset +
      30 +
      view.getUint16(entry.localOffset + 26, true) +
      view.getUint16(entry.localOffset + 28, true);
    const raw = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) return null;
    return inflateBytes(raw, "deflate-raw");
  }

  const XML_ENTITIES = {
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&amp;": "&",
  };

  function xmlToText(xml) {
    return String(xml)
      .replace(/<\/(?:w:p|a:p|text:p|text:h|row|si|c)>/gi, "\n")
      .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
      .replace(/&(lt|gt|quot|apos|nbsp|amp);/g, (entity) => XML_ENTITIES[entity] || entity)
      .split("\n")
      .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function extractArchiveText(bytes) {
    const entries = zipEntries(bytes);
    if (!entries.length) return null;

    const files = entries.filter((entry) => !entry.name.endsWith("/"));
    const wanted = files.filter((entry) => ARCHIVE_PARTS.some((re) => re.test(entry.name)));

    if (!wanted.length) {
      return {
        text: "",
        list: files.slice(0, 40).map((entry) => entry.name),
        count: files.length,
      };
    }

    const pieces = [];
    let total = 0;
    for (const entry of wanted.slice(0, 12)) {
      const raw = await readZipEntry(bytes, entry);
      if (!raw) continue;
      const piece = xmlToText(new TextDecoder("utf-8").decode(raw));
      if (!piece) continue;
      pieces.push(piece);
      total += piece.length;
      if (total > MAX_FILE_CHARS) break;
    }

    const first = wanted[0].name;
    const label = /^word\//i.test(first)
      ? "Word document"
      : /^xl\//i.test(first)
      ? "spreadsheet"
      : /^ppt\//i.test(first)
      ? "slides"
      : "document";

    return { text: pieces.join("\n\n"), list: [], count: 0, label };
  }

  /* --- One file in, one record out ------------------------------------ */

  async function readAttachment(file) {
    const record = {
      name: file.name || "file",
      size: file.size || 0,
      type: file.type || "",
      state: "reading",
      label: "reading",
      text: "",
      note: "",
    };

    if (record.size > MAX_FILE_BYTES) {
      record.state = "too big";
      record.label = "too big";
      record.note = `This file is ${humanSize(record.size)}, larger than the ${humanSize(
        MAX_FILE_BYTES
      )} this app reads. Ask the person to send the part that matters.`;
      return record;
    }

    let bytes = null;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (_) {
      bytes = null;
    }

    if (!bytes) {
      record.state = "unread";
      record.label = "unreadable";
      record.note = "This file could not be read from the device.";
      return record;
    }

    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
    const ext = extensionOf(record.name);

    if (head.startsWith("%PDF")) {
      try {
        record.text = await extractPdfText(bytes);
      } catch (_) {
        record.text = "";
      }
      record.state = record.text.trim() ? "text" : "unread";
      record.label = record.text.trim() ? "PDF" : "PDF · no text layer";
      if (!record.text.trim()) {
        record.note =
          "The text of this PDF could not be extracted -- it may be a scan of a page, or use an " +
          "unusual font encoding. Ask the person to paste the part that matters.";
      }
      return record;
    }

    if (head.startsWith("PK\u0003\u0004") || head.startsWith("PK\u0005\u0006")) {
      try {
        const extracted = await extractArchiveText(bytes);
        if (extracted && extracted.text.trim()) {
          record.text = extracted.text;
          record.state = "text";
          record.label = extracted.label;
          return record;
        }
        if (extracted && extracted.list && extracted.list.length) {
          record.state = "list";
          record.label = "archive";
          record.note =
            `This is a zip archive holding ${extracted.count} file(s): ` +
            extracted.list.join(", ") +
            (extracted.count > extracted.list.length ? ", ..." : "") +
            ". The files inside were not opened -- ask which one matters, or for that one directly.";
          return record;
        }
      } catch (_) {
        /* fall through and try it as text */
      }
    }

    const media = mediaKind(bytes, record.type);
    if (media === "picture") {
      const pictured = await readPicture(file);
      record.state = "picture";
      record.label = "picture · read here";
      record.picture = pictured;
      record.note = pictured
        ? ""
        : "This picture could not be decoded in the browser, so only its name, type and size are known.";
      return record;
    }

    if (media) {
      record.state = "media";
      record.label = media;
      record.note =
        `This is a ${media} file. Aria cannot watch or listen to it here, so describe what is ` +
        `in it, or paste the words that need working on.`;
      return record;
    }

    const textish =
      /^text\//i.test(record.type) ||
      TEXT_EXTENSIONS.has(ext) ||
      /json|xml|javascript|csv|yaml|markdown/i.test(record.type || "");

    if (textish || !looksBinary(bytes)) {
      record.text = decodeText(bytes);
      if (!record.text) {
        record.state = "unread";
        record.label = "empty";
        record.note = "This file is empty.";
        return record;
      }
      record.state = "text";
      record.label = ext ? ext.toUpperCase().slice(0, 7) : "text";
      return record;
    }

    record.state = "unread";
    record.label = "binary";
    record.note =
      "This is a binary file, so only its name, type and size are known -- its contents cannot " +
      "be read as text. Ask the person to describe it or send an exported version.";
    return record;
  }

  function attachmentBlock(record) {
    const head = `[Attached file: ${record.name} -- ${record.type || "unknown type"}, ${humanSize(
      record.size
    )}]`;
    if (record.picture) {
      return `${head}\n[Picture: ${record.name} -- measured in this browser]\n${record.picture}`;
    }
    let body = record.text && record.text.trim() ? record.text.trim() : record.note || "The contents of this file could not be read.";
    if (body.length > MAX_FILE_CHARS) {
      body = `${body.slice(0, MAX_FILE_CHARS)}\n[... first part only: this file is longer than the app sends]`;
    }
    return `${head}\n${body}`;
  }

  function composeMessage(text, files) {
    const parts = [];
    let budget = MAX_TOTAL_CHARS;
    for (const record of files) {
      let block = attachmentBlock(record);
      if (block.length > budget) {
        block = `${block.slice(0, Math.max(0, budget))}\n[... truncated: the rest of this file is too long to send]`;
      }
      budget -= block.length;
      parts.push(block);
      if (budget <= 0) break;
    }
    return [text, ...parts].filter(Boolean).join("\n\n");
  }

  function defaultPrompt(files) {
    const one = files.length === 1;
    return one
      ? "Take a look at the file I attached and tell me what I can do with it."
      : "Take a look at the files I attached and tell me what I can do with them.";
  }

  function attachmentChip(record, removable) {
    const chip = document.createElement("span");
    chip.className = "attachment";
    chip.title = record.name;

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = record.name;
    chip.append(name);

    const meta = document.createElement("span");
    meta.className = "file-meta";
    const size = record.size ? humanSize(record.size) : "";
    meta.textContent =
      record.state === "reading"
        ? "reading..."
        : [record.label || record.state, size].filter(Boolean).join(" · ");
    chip.append(meta);

    if (removable) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "file-remove";
      remove.dataset.id = record.id;
      remove.setAttribute("aria-label", `Remove ${record.name}`);
      remove.textContent = "×";
      chip.append(remove);
    }

    return chip;
  }

  function renderAttachments() {
    el.attachments.innerHTML = "";
    if (!attachments.length) {
      el.attachments.hidden = true;
      return;
    }
    el.attachments.hidden = false;
    for (const record of attachments) el.attachments.append(attachmentChip(record, true));
  }

  async function addFiles(list) {
    const incoming = Array.from(list || []).filter(Boolean);
    if (!incoming.length || busy) return;
    const room = MAX_FILES - attachments.length;
    if (room <= 0) return;

    const records = incoming.slice(0, room).map((file) => ({
      id: `f${(attachmentSeq += 1)}`,
      name: file.name || "file",
      size: file.size || 0,
      type: file.type || "",
      state: "reading",
      label: "reading",
      text: "",
      note: "",
      file,
    }));

    attachments.push(...records);
    renderAttachments();
    updateComposer();

    for (const record of records) {
      try {
        Object.assign(record, await readAttachment(record.file));
      } catch (_) {
        record.state = "unread";
        record.label = "unreadable";
        record.note = "This file could not be read.";
      }
      if (record.state !== "picture") record.file = null;
      renderAttachments();
      updateComposer();
    }
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
    if (!text || asksAboutItself(text)) return null;
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
    const hasFiles = history.some(
      (message) => message.role === "user" && message.content.includes("[Attached file:")
    );
    const question = currentQuestion();
    const hasPicture = history.some(
      (message) => message.role === "user" && message.content.includes("[Picture:")
    );
    const wantsFile =
      /\b(?:document|report|letter|resume|cv|docx|word|spreadsheet|excel|xlsx|budget|invoice|tracker|slide|slides|deck|presentation|pptx|pdf|csv|checklist|template|cheat ?sheet|download)\b/i.test(
        question
      ) || /aria-file/.test(history.map((message) => message.content).join("\n"));
    const system =
      SYSTEM_PROMPT +
      (live && live.block ? LIVE_INSTRUCTIONS : "") +
      (hasFiles ? FILES_INSTRUCTIONS : "") +
      (hasPicture ? PICTURE_INSTRUCTIONS : "") +
      (wantsFile ? FILE_INSTRUCTIONS : "") +
      (asksAboutItself(question) ? SELF_NOTE : "");
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

  /** Optional free account: streams tokens, and is the only lane that truly sees an image. */
  async function askPuter(body, live) {
    const messages = buildMessages(live);
    let withEyes = false;
    if (pendingImages.length) {
      try {
        const urls = (await Promise.all(pendingImages.slice(0, 3).map(pictureDataUrl))).filter(Boolean);
        if (urls.length) withEyes = attachPictures(messages, urls);
      } catch (_) {
        withEyes = false; // the measurements are still in the text
      }
    }

    let response;
    try {
      response = await window.puter.ai.chat(messages, { stream: true });
    } catch (error) {
      if (!withEyes) throw error;
      response = await window.puter.ai.chat(buildMessages(live), { stream: true });
    }
    let full = "";

    if (response && typeof response[Symbol.asyncIterator] === "function") {
      try {
        for await (const part of response) {
          if (stopRequested) break;
          const piece =
            typeof part === "string" ? part : part?.type === "text" || !part?.type ? part?.text : "";
          if (!piece) continue;
          full += piece;
          paint(body, full, true);
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
   * Pictures — measured here, pixel by pixel, with no model involved
   * ------------------------------------------------------------------ */

  async function pictureSource(file) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file);
      } catch (_) {
        /* fall through to an <img> */
      }
    }
    return await new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      image.src = url;
    });
  }

  const COLOUR_NAMES = [
    [255, 255, 255, "white"],
    [244, 244, 242, "off-white"],
    [200, 200, 198, "light grey"],
    [128, 128, 126, "grey"],
    [70, 70, 70, "dark grey"],
    [15, 15, 15, "black"],
    [200, 40, 40, "red"],
    [230, 110, 30, "orange"],
    [230, 190, 40, "yellow"],
    [40, 160, 80, "green"],
    [30, 150, 140, "teal"],
    [40, 100, 220, "blue"],
    [120, 70, 210, "purple"],
    [220, 80, 150, "pink"],
    [140, 90, 50, "brown"],
  ];

  function colourName(r, g, b) {
    let best = COLOUR_NAMES[0];
    let bestGap = Infinity;
    for (const entry of COLOUR_NAMES) {
      const gap = (entry[0] - r) ** 2 + (entry[1] - g) ** 2 + (entry[2] - b) ** 2;
      if (gap < bestGap) {
        bestGap = gap;
        best = entry;
      }
    }
    return best[3];
  }

  /** Everything measurable about a picture, said in plain words. */
  function describePixels(pixels, width, height, realWidth, realHeight) {
    const count = width * height;
    const luma = new Float32Array(count);
    const rowSum = new Float64Array(height);
    const buckets = new Map();
    let sum = 0;
    let sumSq = 0;
    let saturation = 0;
    let transparent = 0;
    let pale = 0;
    let hueMask = 0;

    for (let y = 0; y < height; y += 1) {
      let rowTotal = 0;
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        if (a < 200) transparent += 1;
        const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luma[y * width + x] = value;
        rowTotal += value;
        sum += value;
        sumSq += value * value;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        saturation += sat;
        if (value > 238) pale += 1;
        if (max > 45 && sat > 0.22) {
          const spread = max - min;
          const hue =
            max === r
              ? 60 * ((g - b) / spread)
              : max === g
              ? 60 * (2 + (b - r) / spread)
              : 60 * (4 + (r - g) / spread);
          const slot = ((Math.round(hue / 30) % 12) + 12) % 12;
          hueMask |= 1 << slot;
        }
        const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.n += 1;
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
        } else {
          buckets.set(key, { n: 1, r, g, b });
        }
      }
      rowSum[y] = rowTotal;
    }

    const mean = sum / count;
    const deviation = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    const satMean = saturation / count;

    const palette = [...buckets.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 5)
      .map((bucket) => {
        const r = Math.round(bucket.r / bucket.n);
        const g = Math.round(bucket.g / bucket.n);
        const b = Math.round(bucket.b / bucket.n);
        return {
          share: Math.round((bucket.n / count) * 100),
          name: colourName(r, g, b),
          hex: `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
          luma: 0.2126 * r + 0.7152 * g + 0.0722 * b,
        };
      })
      .filter((entry, index) => index === 0 || entry.share >= 1);

    // Rows of small marks against the background colour: what lines of text look
    // like. A photograph has marks on every row and scores too high, so it gets none.
    const backgroundLuma = palette.length ? palette[0].luma : mean;
    // Text bands only mean something when one colour really is the page behind them.
    const hasBackground = Boolean(palette.length && palette[0].share >= 25);
    const ink = new Float32Array(height);
    for (let y = 0; y < height; y += 1) {
      let marks = 0;
      for (let x = 0; x < width; x += 1) {
        if (Math.abs(luma[y * width + x] - backgroundLuma) > 42) marks += 1;
      }
      ink[y] = marks / width;
    }
    let bands = 0;
    let bandRows = 0;
    let inBand = false;
    for (let y = 0; y < height; y += 1) {
      const on = ink[y] >= 0.006 && ink[y] <= 0.75;
      if (on) bandRows += 1;
      else if (inBand) bands += 1;
      inBand = on;
    }
    if (inBand) bands += 1;
    if (!hasBackground) bands = 0;
    const markShare = hasBackground ? bandRows / height : 0;
    const markCoverage = ink.reduce((total, value) => total + value, 0) / height;
    const inkThirds = [0, 1, 2].map((index) => {
      const from = Math.floor((index * height) / 3);
      const to = index === 2 ? height : Math.floor(((index + 1) * height) / 3);
      let total = 0;
      for (let y = from; y < to; y += 1) total += ink[y];
      return to > from ? total / (to - from) : 0;
    });
    const busiest = ["top", "middle", "bottom"][inkThirds.indexOf(Math.max(...inkThirds))];

    // Detail: neighbouring pixels that jump in brightness.
    let edges = 0;
    let edgeChecks = 0;
    const stepX = Math.max(1, Math.floor(width / 220));
    const stepY = Math.max(1, Math.floor(height / 220));
    for (let y = stepY; y < height; y += stepY) {
      for (let x = stepX; x < width; x += stepX) {
        const here = luma[y * width + x];
        const left = luma[y * width + (x - stepX)];
        const up = luma[(y - stepY) * width + x];
        if (Math.abs(here - left) + Math.abs(here - up) > 60) edges += 1;
        edgeChecks += 1;
      }
    }
    const detail = edgeChecks ? edges / edgeChecks : 0;

    const background = palette[0];
    let hues = 0;
    for (let slot = 0; slot < 12; slot += 1) if (hueMask & (1 << slot)) hues += 1;

    const ratio = realWidth / realHeight;
    const shape = ratio > 1.15 ? "wide" : ratio < 0.87 ? "tall" : "roughly square";

    // What kind of picture this most likely is — always a guess, never a fact.
    let kind;
    if (transparent / count > 0.04) kind = "a logo or icon on a transparent background";
    else if (pale / count > 0.42 && satMean < 0.2 && bands >= 3)
      kind = "a page of text — a scan, a document, or a screenshot of one";
    else if (satMean < 0.24 && bands >= 2 && markShare > 0.12) kind = "a screenshot of an interface";
    else if (hues >= 6 && detail > 0.05) kind = "a photograph or a detailed picture";
    else if (hues >= 6) kind = "a smooth, colourful picture — a photo, a render or a gradient";
    else if (hues >= 3) kind = "a chart, diagram, map or illustration";
    else if (bands >= 2) kind = "a picture with rows of text-like marks";
    else kind = "a picture";

    const slice = Math.max(1, Math.floor(height / 3));
    const thirds = [0, 1, 2]
      .map((index) => {
        const from = index * slice;
        const to = index === 2 ? height : from + slice;
        let bandSum = 0;
        let bandEdges = 0;
        let bandPixels = 0;
        for (let y = from; y < to; y += 1) {
          bandSum += rowSum[y];
          for (let x = 0; x < width; x += 1) {
            const here = luma[y * width + x];
            const left = x ? luma[y * width + x - 1] : here;
            if (Math.abs(here - left) > 45) bandEdges += 1;
            bandPixels += 1;
          }
        }
        const value = bandPixels ? bandSum / bandPixels : mean;
        const density = bandPixels ? bandEdges / bandPixels : 0;
        const light = value > 175 ? "light" : value > 95 ? "mid-toned" : "dark";
        return `${["top", "middle", "bottom"][index]} ${light}${density > 0.06 ? " and busy" : " and calm"}`;
      })
      .join(", ");

    const lightWord = mean > 190 ? "bright" : mean > 120 ? "medium" : mean > 60 ? "dim" : "dark";
    const contrastWord = deviation > 75 ? "strong" : deviation > 38 ? "moderate" : "flat";
    const colourWord = satMean < 0.1 ? "almost colourless" : satMean < 0.3 ? "muted" : "vivid";

    const lines = [
      `${realWidth}×${realHeight} pixels (${shape}), ${((realWidth * realHeight) / 1e6).toFixed(1)} megapixels.`,
      `Looks like ${kind}.`,
      `Background ${background ? `${background.share}% ${background.name}` : "mixed"}; main colours: ${palette
        .map((entry) => `${entry.hex} ${entry.name} ${entry.share}%`)
        .join(", ")}.`,
      `Light: ${lightWord}, contrast ${contrastWord}, colour ${colourWord}.`,
      `Layout by thirds: ${thirds}.`,
      bands
        ? `About ${bands} band${bands === 1 ? "" : "s"} of small marks across ${Math.round(
            markShare * 100
          )}% of the height — the shape text or rows of icons make.`
        : "No rows of text-like marks were found.",
      `Everything that is not background covers about ${Math.round(
        markCoverage * 100
      )}% of the picture, mostly in the ${busiest} third.`,
      `Detail: ${detail > 0.13 ? "a lot" : detail > 0.05 ? "some" : "very little"} (${Math.round(
        detail * 100
      )}% of sampled pixels are edges).`,
    ];
    if (transparent) lines.push(`${Math.round((transparent / count) * 100)}% of it is transparent.`);
    return lines.join(" ");
  }

  async function readPicture(file) {
    const source = await pictureSource(file);
    if (!source) return "";
    const realWidth = source.width || source.naturalWidth || 0;
    const realHeight = source.height || source.naturalHeight || 0;
    if (!realWidth || !realHeight) return "";
    const scale = Math.min(1, 1400 / Math.max(realWidth, realHeight));
    const width = Math.max(1, Math.round(realWidth * scale));
    const height = Math.max(1, Math.round(realHeight * scale));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return "";
      context.drawImage(source, 0, 0, width, height);
      if (typeof source.close === "function") source.close();
      const data = context.getImageData(0, 0, width, height).data;
      return describePixels(data, width, height, realWidth, realHeight);
    } catch (_) {
      return "";
    }
  }

  /** A small JPEG for the only lane that can truly see: the free account. */
  async function pictureDataUrl(file) {
    const source = await pictureSource(file);
    if (!source) return "";
    const realWidth = source.width || source.naturalWidth || 0;
    const realHeight = source.height || source.naturalHeight || 0;
    if (!realWidth || !realHeight) return "";
    const scale = Math.min(1, 1200 / Math.max(realWidth, realHeight));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(realWidth * scale));
      canvas.height = Math.max(1, Math.round(realHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return "";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      if (typeof source.close === "function") source.close();
      return canvas.toDataURL("image/jpeg", 0.82);
    } catch (_) {
      return "";
    }
  }

  function attachPictures(messages, urls) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== "user") continue;
      messages[index] = {
        role: "user",
        content: [
          { type: "text", text: String(messages[index].content) },
          ...urls.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      };
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Files out — the real document, spreadsheet, deck or PDF, built here
   * ------------------------------------------------------------------ */

  const FILE_KINDS = {
    docx: {
      label: "Word document",
      ext: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    xlsx: {
      label: "Excel spreadsheet",
      ext: "xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    pptx: {
      label: "PowerPoint deck",
      ext: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    pdf: { label: "PDF", ext: "pdf", mime: "application/pdf" },
    csv: { label: "CSV table", ext: "csv", mime: "text/csv;charset=utf-8" },
    md: { label: "Markdown", ext: "md", mime: "text/markdown;charset=utf-8" },
    html: { label: "web page", ext: "html", mime: "text/html;charset=utf-8" },
    txt: { label: "text file", ext: "txt", mime: "text/plain;charset=utf-8" },
  };

  const FILE_BADGES = {
    docx: "DOC",
    xlsx: "XLS",
    pptx: "PPT",
    pdf: "PDF",
    csv: "CSV",
    md: "MD",
    html: "WEB",
    txt: "TXT",
  };

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[n] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** Store-only zip: no compression, and every reader accepts it. */
  function zipStore(files) {
    const encoder = new TextEncoder();
    const pieces = [];
    const directory = [];
    const now = new Date();
    const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const date =
      ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const u16 = (value) => [value & 0xff, (value >>> 8) & 0xff];
    const u32 = (value) => [
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ];
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const local = [
        ...u32(0x04034b50),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(time),
        ...u16(date),
        ...u32(crc),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(name.length),
        ...u16(0),
        ...name,
      ];
      pieces.push(new Uint8Array(local), data);
      directory.push([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(time),
        ...u16(date),
        ...u32(crc),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ]);
      offset += local.length + data.length;
    }

    const tail = [
      ...directory.flat(),
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(files.length),
      ...u16(files.length),
      ...u32(directory.reduce((size, entry) => size + entry.length, 0)),
      ...u32(offset),
      ...u16(0),
    ];
    pieces.push(new Uint8Array(tail));

    const total = pieces.reduce((size, piece) => size + piece.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const piece of pieces) {
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  }

  function xmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  }

  function plainText(value) {
    return String(value == null ? "" : value)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** A table cell can arrive as text, a number, or an object from the model. */
  function cellText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" || typeof value === "string") return String(value);
    if (typeof value === "object") {
      for (const field of ["text", "label", "value", "formula", "name"]) {
        const found = value[field];
        if (typeof found === "string" || typeof found === "number") return String(found);
      }
      return "";
    }
    return String(value);
  }

  function rels(entries) {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      entries
        .map((entry) => `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${entry.target}"/>`)
        .join("") +
      "</Relationships>"
    );
  }

  function rootRels(target) {
    return rels([
      {
        id: "rId1",
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
        target,
      },
    ]);
  }

  const CONTENT_RELS =
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>';

  const DOCX_STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="150" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="260"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="340" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="141414"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="262626"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="3A3A3A"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="70"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="420"/></w:pPr><w:rPr><w:i/><w:color w:val="4A4A4A"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/><w:color w:val="1F2937"/></w:rPr></w:style>' +
    "</w:styles>";

  function docxText(text) {
    return String(text == null ? "" : text)
      .split("\n")
      .map((line, index) => `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`)
      .join("");
  }

  function docxParagraph(text, style, prefix) {
    const properties = style
      ? `<w:pPr><w:pStyle w:val="${style}"/>${
          style === "ListParagraph" ? '<w:ind w:left="420" w:hanging="300"/>' : ""
        }</w:pPr>`
      : "";
    const lead = prefix ? `<w:r>${docxText(prefix)}</w:r>` : "";
    return `<w:p>${properties}${lead}<w:r>${docxText(text)}</w:r></w:p>`;
  }

  function docxTable(block) {
    const head = (block.head || []).map((value) => cellText(value));
    const rows = (block.rows || []).map((row) => row.map((value) => cellText(value)));
    const all = head.length ? [head, ...rows] : rows;
    if (!all.length) return "";
    const columns = Math.max(1, ...all.map((row) => row.length));
    const cell = (text, bold) =>
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr>${
        bold ? "<w:b/>" : ""
      }<w:sz w:val="20"/></w:rPr>${docxText(text)}</w:r></w:p></w:tc>`;
    const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join("");
    const grid = Array.from({ length: columns }, () => '<w:gridCol w:w="2200"/>').join("");
    const body = all
      .map(
        (row, index) =>
          `<w:tr>${Array.from({ length: columns }, (_, column) =>
            cell(row[column] || "", Boolean(head.length && index === 0))
          ).join("")}</w:tr>`
      )
      .join("");
    return (
      `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
      `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
    );
  }

  function buildDocx(blocks, title) {
    const body = [];
    const first = blocks[0];
    const repeats =
      first &&
      first.t === "h1" &&
      title &&
      first.text.trim().toLowerCase() === title.trim().toLowerCase();
    if (title && title.trim() && !repeats) body.push(docxParagraph(title, "Title"));
    let number = 0;
    for (const block of blocks) {
      if (block.t === "h1" || block.t === "h2" || block.t === "h3") {
        number = 0;
        body.push(docxParagraph(block.text, `Heading${block.t.slice(1)}`));
      } else if (block.t === "bullet") {
        body.push(docxParagraph(block.text, "ListParagraph", "• "));
      } else if (block.t === "num") {
        number += 1;
        body.push(docxParagraph(block.text, "ListParagraph", `${number}. `));
      } else if (block.t === "quote") {
        body.push(docxParagraph(block.text, "Quote"));
      } else if (block.t === "code") {
        for (const line of String(block.text || "").split("\n")) body.push(docxParagraph(line || " ", "Code"));
      } else if (block.t === "table") {
        const table = docxTable(block);
        if (table) body.push(table, "<w:p/>");
      } else if (block.t === "pagebreak") {
        body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      } else {
        body.push(docxParagraph(block.text));
      }
    }
    if (!body.length) body.push(docxParagraph(" "));

    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      body.join("") +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>' +
      "</w:body></w:document>";

    return zipStore([
      {
        name: "[Content_Types].xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          CONTENT_RELS +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
          "</Types>",
      },
      { name: "_rels/.rels", data: rootRels("word/document.xml") },
      { name: "word/document.xml", data: documentXml },
      { name: "word/styles.xml", data: DOCX_STYLES },
      {
        name: "word/_rels/document.xml.rels",
        data: rels([
          {
            id: "rId1",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
            target: "styles.xml",
          },
        ]),
      },
    ]);
  }

  function columnName(index) {
    let name = "";
    let value = index + 1;
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function sheetSafeName(name, index, used) {
    const base =
      String(name || `Sheet${index + 1}`)
        .replace(/[\\/*?:[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 31) || `Sheet${index + 1}`;
    let unique = base;
    let suffix = 2;
    while (used.has(unique.toLowerCase())) {
      unique = `${base.slice(0, 28)} ${suffix}`;
      suffix += 1;
    }
    used.add(unique.toLowerCase());
    return unique;
  }

  function buildXlsx(sheets) {
    const used = new Set();
    const prepared = sheets.map((sheet, index) => ({
      name: sheetSafeName(sheet.name, index, used),
      rows: (sheet.rows || []).map((row) => (Array.isArray(row) ? row : [row])),
    }));

    const worksheet = (rows) => {
      const body = rows
        .map((row, rowIndex) => {
          const cells = row
            .map((value, columnIndex) => {
              const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
              if (value === null || value === undefined || value === "") return "";
              if (value && typeof value === "object" && typeof value.formula === "string") {
                const formula = value.formula.replace(/^=/, "");
                const cached =
                  value.value !== undefined && Number.isFinite(Number(value.value))
                    ? `<v>${Number(value.value)}</v>`
                    : "";
                return `<c r="${reference}"><f>${xmlEscape(formula)}</f>${cached}</c>`;
              }
              const text = cellText(value);
              if (!text) return "";
              const numeric =
                typeof value === "number"
                  ? value
                  : /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/.test(text.trim())
                  ? Number(text.trim())
                  : null;
              if (numeric !== null && Number.isFinite(numeric)) {
                return `<c r="${reference}"><v>${numeric}</v></c>`;
              }
              return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(
                text
              )}</t></is></c>`;
            })
            .join("");
          return `<row r="${rowIndex + 1}">${cells}</row>`;
        })
        .join("");
      return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<cols><col min="1" max="26" width="18" customWidth="1"/></cols>' +
        `<sheetData>${body}</sheetData></worksheet>`
      );
    };

    const files = prepared.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: worksheet(sheet.rows),
    }));

    files.unshift(
      {
        name: "[Content_Types].xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          CONTENT_RELS +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          prepared
            .map(
              (_sheet, index) =>
                `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
            )
            .join("") +
          "</Types>",
      },
      { name: "_rels/.rels", data: rootRels("xl/workbook.xml") },
      {
        name: "xl/workbook.xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          prepared
            .map(
              (sheet, index) =>
                `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
            )
            .join("") +
          "</sheets></workbook>",
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: rels(
          prepared.map((_sheet, index) => ({
            id: `rId${index + 1}`,
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
            target: `worksheets/sheet${index + 1}.xml`,
          }))
        ),
      }
    );

    return zipStore(files);
  }

  const PPTX_THEME =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Aria"><a:themeElements>' +
    '<a:clrScheme name="Aria"><a:dk1><a:srgbClr val="161616"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="3A3A3A"/></a:dk2><a:lt2><a:srgbClr val="F2F1EE"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="2F6B62"/></a:accent1><a:accent2><a:srgbClr val="C2703D"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="4472C4"/></a:accent3><a:accent4><a:srgbClr val="7A6CA8"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="4E8B57"/></a:accent5><a:accent6><a:srgbClr val="A64D79"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="Aria"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="Aria">' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
    "</a:fmtScheme></a:themeElements></a:theme>";

  const PPT_NS =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

  const PPT_TREE_HEAD =
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

  function pptxShape(id, name, x, y, cx, cy, lines, size, bold) {
    const runs = (lines.length ? lines : [""])
      .map(
        (line) =>
          `<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr lang="en-GB" sz="${size}"${
            bold ? ' b="1"' : ""
          }/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`
      )
      .join("");
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`
    );
  }

  function slideXml(slide) {
    const title = String(slide.title || "");
    const bullets = (slide.bullets || []).map((line) => plainText(line)).filter((line) => line);
    const shapes = [];
    if (title) shapes.push(pptxShape(2, "Title", 731520, 502920, 10744200, 1371600, [title], 3200, true));
    if (bullets.length) {
      shapes.push(
        pptxShape(
          3,
          "Body",
          731520,
          title ? 2103120 : 731520,
          10744200,
          title ? 4206240 : 5486400,
          bullets.map((line) => `• ${line}`),
          1800,
          false
        )
      );
    }
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<p:sld ${PPT_NS}><p:cSld>${PPT_TREE_HEAD}${shapes.join("")}</p:spTree></p:cSld>` +
      "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    );
  }

  function buildPptx(slides) {
    const deck = slides.length ? slides : [{ title: "", bullets: [] }];
    const files = [];

    files.push({
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        CONTENT_RELS +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        deck
          .map(
            (_slide, index) =>
              `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
          )
          .join("") +
        "</Types>",
    });

    files.push({ name: "_rels/.rels", data: rootRels("ppt/presentation.xml") });

    files.push({
      name: "ppt/presentation.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<p:presentation ${PPT_NS}>` +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        `<p:sldIdLst>${deck
          .map((_slide, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
          .join("")}</p:sldIdLst>` +
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
        "</p:presentation>",
    });

    const presentationRels = [
      {
        id: "rId1",
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
        target: "slideMasters/slideMaster1.xml",
      },
    ].concat(
      deck.map((_slide, index) => ({
        id: `rId${index + 2}`,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
        target: `slides/slide${index + 1}.xml`,
      })),
      [
        {
          id: `rId${deck.length + 2}`,
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
          target: "theme/theme1.xml",
        },
      ]
    );

    files.push({ name: "ppt/_rels/presentation.xml.rels", data: rels(presentationRels) });

    files.push({
      name: "ppt/slideMasters/slideMaster1.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<p:sldMaster ${PPT_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${PPT_TREE_HEAD}</p:spTree></p:cSld>` +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
        '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle>' +
        '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>' +
        '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>' +
        "</p:sldMaster>",
    });

    files.push({
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: rels([
        {
          id: "rId1",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
          target: "../slideLayouts/slideLayout1.xml",
        },
        {
          id: "rId2",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
          target: "../theme/theme1.xml",
        },
      ]),
    });

    files.push({
      name: "ppt/slideLayouts/slideLayout1.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<p:sldLayout ${PPT_NS} type="blank" preserve="1"><p:cSld name="Blank">${PPT_TREE_HEAD}</p:spTree></p:cSld>` +
        "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
    });

    files.push({
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: rels([
        {
          id: "rId1",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
          target: "../slideMasters/slideMaster1.xml",
        },
      ]),
    });

    files.push({ name: "ppt/theme/theme1.xml", data: PPTX_THEME });

    deck.forEach((slide, index) => {
      files.push({ name: `ppt/slides/slide${index + 1}.xml`, data: slideXml(slide) });
      files.push({
        name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        data: rels([
          {
            id: "rId1",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
            target: "../slideLayouts/slideLayout1.xml",
          },
        ]),
      });
    });

    return zipStore(files);
  }

  const PDF_GLYPHS = {
    "\u2018": 0x91,
    "\u2019": 0x92,
    "\u201c": 0x93,
    "\u201d": 0x94,
    "\u2022": 0x95,
    "\u2013": 0x96,
    "\u2014": 0x97,
    "\u2026": 0x85,
    "\u20ac": 0x80,
    "\u00a0": 0x20,
  };

  function pdfString(text) {
    let out = "";
    for (const character of String(text)) {
      let code = PDF_GLYPHS[character];
      if (code === undefined) {
        const point = character.codePointAt(0);
        code = point <= 0xff ? point : 0x3f;
      }
      if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
      else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
      else out += String.fromCharCode(code);
    }
    return out;
  }

  function wrapPdf(text, perLine) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      if (!line) line = word;
      else if (line.length + word.length + 1 <= perLine) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function buildPdf(blocks, title) {
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const margin = 56;
    const usable = pageWidth - margin * 2;
    const pages = [];
    let ops = [];
    let y = pageHeight - margin;

    const newPage = () => {
      if (ops.length) pages.push(ops.join("\n"));
      ops = [];
      y = pageHeight - margin;
    };

    const write = (text, size, bold, indent) => {
      const left = margin + (indent || 0);
      const perLine = Math.max(10, Math.floor((usable - (indent || 0)) / (size * 0.5)));
      for (const line of wrapPdf(text, perLine)) {
        if (y < margin + size) newPage();
        ops.push(
          `BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${left.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(
            line
          )}) Tj ET`
        );
        y -= size * 1.45;
      }
    };

    const first = blocks[0];
    const repeats =
      first &&
      first.t === "h1" &&
      title &&
      first.text.trim().toLowerCase() === title.trim().toLowerCase();
    if (title && title.trim() && !repeats) {
      write(title, 22, true, 0);
      y -= 10;
    }

    let number = 0;
    for (const block of blocks) {
      if (block.t === "h1") {
        y -= 6;
        write(block.text, 17, true, 0);
        number = 0;
      } else if (block.t === "h2") {
        y -= 4;
        write(block.text, 14, true, 0);
        number = 0;
      } else if (block.t === "h3") {
        y -= 2;
        write(block.text, 12, true, 0);
        number = 0;
      } else if (block.t === "bullet") {
        write(`\u2022  ${block.text}`, 11, false, 14);
      } else if (block.t === "num") {
        number += 1;
        write(`${number}.  ${block.text}`, 11, false, 14);
      } else if (block.t === "quote") {
        write(`\u201c${block.text}\u201d`, 11, false, 18);
      } else if (block.t === "code") {
        for (const line of String(block.text || "").split("\n")) write(line || " ", 9, false, 12);
      } else if (block.t === "table") {
        const head = (block.head || []).map((value) => cellText(value));
        const rows = (block.rows || []).map((row) => row.map((value) => cellText(value)));
        if (head.length) write(head.join("  |  "), 9, true, 0);
        for (const row of rows) write(row.join("  |  "), 9, false, 0);
        y -= 4;
      } else if (block.t === "pagebreak") {
        newPage();
      } else {
        write(block.text, 11, false, 0);
        y -= 6;
      }
    }
    if (ops.length) pages.push(ops.join("\n"));
    if (!pages.length) pages.push("");

    const objects = [];
    const pageIds = pages.map((_page, index) => 6 + index * 2);
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${
      pageIds.length
    } >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

    pages.forEach((content, index) => {
      const contentId = 5 + index * 2;
      const pageId = pageIds[index];
      objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
      objects[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    });

    let out = "%PDF-1.4\n";
    const offsets = [];
    for (let id = 1; id < objects.length; id += 1) {
      if (!objects[id]) continue;
      offsets[id] = out.length;
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const startxref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1) {
      out += `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }

  function tidyBlocks(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const t = String(item.t || item.type || "p").toLowerCase();
      if (t === "sheet" || t === "slide") {
        out.push({ ...item, t });
        continue;
      }
      const text = item.text != null ? plainText(item.text) : "";
      if (t === "table") {
        out.push({
          t: "table",
          head: (item.head || item.header || []).map((value) => cellText(value)),
          rows: (item.rows || []).map((row) =>
            (Array.isArray(row) ? row : [row]).map((value) => cellText(value))
          ),
        });
        continue;
      }
      if (t === "bullet" || t === "num") {
        const items = Array.isArray(item.items) ? item.items : text ? [text] : [];
        for (const one of items) if (String(one).trim()) out.push({ t, text: plainText(one) });
        continue;
      }
      if (t === "pagebreak") {
        out.push({ t });
        continue;
      }
      if (!text.trim()) continue;
      out.push({ t: ["h1", "h2", "h3", "quote", "code"].includes(t) ? t : "p", text });
    }
    return out;
  }

  function sheetsFrom(blocks) {
    const sheets = blocks
      .filter((block) => block.t === "sheet")
      .map((block, index) => ({
        name: block.name || block.title || `Sheet${index + 1}`,
        rows: (block.rows || []).map((row) => (Array.isArray(row) ? row : [row])),
      }));
    if (sheets.length) return sheets;
    const tables = blocks.filter((block) => block.t === "table");
    if (tables.length) {
      return tables.map((table, index) => ({
        name: table.name || `Table ${index + 1}`,
        rows: [table.head || [], ...(table.rows || [])],
      }));
    }
    const rows = blocks.map((block) => [block.text || ""]);
    return [{ name: "Sheet1", rows: rows.length ? rows : [[""]] }];
  }

  function slidesFrom(blocks) {
    const slides = blocks
      .filter((block) => block.t === "slide")
      .map((block) => ({
        title: String(block.title || ""),
        bullets: (block.bullets || block.items || []).map((line) => plainText(line)).filter(Boolean),
      }));
    if (slides.length) return slides;

    const out = [];
    let current = null;
    for (const block of blocks) {
      if (block.t === "h1" || block.t === "h2" || block.t === "h3") {
        current = { title: block.text, bullets: [] };
        out.push(current);
        continue;
      }
      if (!current) {
        current = { title: "", bullets: [] };
        out.push(current);
      }
      if (block.t === "table") {
        if ((block.head || []).length) current.bullets.push(block.head.join(" · "));
        for (const row of block.rows || []) current.bullets.push(row.join(" · "));
      } else if (block.t === "bullet" || block.t === "num" || block.text) {
        current.bullets.push(block.text || "");
      }
    }
    const made = out.filter((slide) => slide.title || slide.bullets.length);
    if (made.length && !made.some((slide) => slide.title)) {
      // No headings to split on: keep each slide readable instead of one wall of text.
      const lines = made.flatMap((slide) => slide.bullets);
      const chunked = [];
      for (let index = 0; index < lines.length; index += 6) {
        chunked.push({ title: index ? "" : "Summary", bullets: lines.slice(index, index + 6) });
      }
      return chunked.slice(0, 40);
    }
    return made.slice(0, 40);
  }

  function blocksToMarkdown(blocks) {
    const lines = [];
    for (const block of blocks) {
      if (block.t === "h1") lines.push(`# ${block.text}`, "");
      else if (block.t === "h2") lines.push(`## ${block.text}`, "");
      else if (block.t === "h3") lines.push(`### ${block.text}`, "");
      else if (block.t === "bullet") lines.push(`- ${block.text}`);
      else if (block.t === "num") lines.push(`1. ${block.text}`);
      else if (block.t === "quote") lines.push(`> ${block.text}`, "");
      else if (block.t === "code") lines.push("```", String(block.text || ""), "```", "");
      else if (block.t === "pagebreak") lines.push("---", "");
      else if (block.t === "table") {
        const head = block.head || [];
        if (head.length) {
          lines.push(`| ${head.join(" | ")} |`);
          lines.push(`| ${head.map(() => "---").join(" | ")} |`);
          for (const row of block.rows || []) lines.push(`| ${row.join(" | ")} |`);
          lines.push("");
        }
      } else if (block.text) lines.push(block.text, "");
    }
    return lines.join("\n").trim();
  }

  function blocksToHtml(blocks, title) {
    const parts = blocks.map((block) => {
      if (block.t === "h1") return `<h1>${escapeHtml(block.text)}</h1>`;
      if (block.t === "h2") return `<h2>${escapeHtml(block.text)}</h2>`;
      if (block.t === "h3") return `<h3>${escapeHtml(block.text)}</h3>`;
      if (block.t === "bullet") return `<li>${escapeHtml(block.text)}</li>`;
      if (block.t === "num") return `<li>${escapeHtml(block.text)}</li>`;
      if (block.t === "quote") return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
      if (block.t === "code") return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
      if (block.t === "pagebreak") return '<hr class="pagebreak">';
      if (block.t === "table") {
        const head = block.head || [];
        const rows = block.rows || [];
        return (
          `<table>${head.length ? `<thead><tr>${head.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead>` : ""}` +
          `<tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
        );
      }
      return `<p>${escapeHtml(block.text || "")}</p>`;
    });
    return (
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>" +
      escapeHtml(title || "Aria") +
      '</title><style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#161616;max-width:720px;margin:48px auto;padding:0 20px}' +
      "h1,h2,h3{line-height:1.25}table{border-collapse:collapse;width:100%;margin:18px 0}td,th{border:1px solid #ddd;padding:8px;text-align:left}" +
      "blockquote{margin:18px 0;padding-left:16px;border-left:3px solid #ddd;color:#444}pre{background:#f5f5f3;padding:14px;overflow:auto}</style></head><body>" +
      `<h1>${escapeHtml(title || "Aria")}</h1>` +
      parts.join("") +
      "</body></html>"
    );
  }

  function blocksToCsv(blocks) {
    const table = blocks.find((block) => block.t === "table") || blocks.find((block) => block.t === "sheet");
    const rows = table
      ? table.t === "sheet"
        ? table.rows || []
        : [table.head || [], ...(table.rows || [])]
      : blocks.map((block) => [block.text || ""]);
    const cell = (value) => {
      const text = cellText(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return rows.map((row) => row.map(cell).join(",")).join("\r\n");
  }

  function specToFile(spec) {
    const kind = String(spec.kind || "docx")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const info = FILE_KINDS[kind];
    if (!info) return null;
    const blocks = tidyBlocks(spec.blocks);
    const title = spec.title ? plainText(spec.title) : "";
    const name = `${slugName(spec.name || title || "aria-file")}.${info.ext}`;
    let bytes;
    if (kind === "docx") bytes = buildDocx(blocks, title);
    else if (kind === "xlsx") bytes = buildXlsx(sheetsFrom(blocks));
    else if (kind === "pptx") bytes = buildPptx(slidesFrom(blocks));
    else if (kind === "pdf") bytes = buildPdf(blocks, title);
    else if (kind === "csv") bytes = new TextEncoder().encode(blocksToCsv(blocks));
    else if (kind === "html") bytes = new TextEncoder().encode(blocksToHtml(blocks, title));
    else bytes = new TextEncoder().encode(blocksToMarkdown(blocks));
    return { kind, name, bytes, label: info.label, mime: info.mime, blocks, title };
  }

  function readSpec(body) {
    const attempts = [
      body,
      body.replace(/,\s*([}\]])/g, "$1"),
      body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1),
    ];
    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object" && (parsed.blocks || parsed.kind)) return parsed;
      } catch (_) {
        /* try the next repair */
      }
    }
    return null;
  }

  function fileBlocksIn(text) {
    const found = [];
    const fences = /```[ \t]*([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g;
    let match;
    while ((match = fences.exec(text))) {
      const lang = (match[1] || "").toLowerCase();
      const body = match[2].trim();
      if (!body.startsWith("{")) continue;
      if (!/^aria-file$/.test(lang) && !(/"kind"\s*:/.test(body) && /"(?:blocks|sheet|slide)"\s*:/.test(body))) {
        continue;
      }
      const spec = readSpec(body);
      if (spec) found.push(spec);
    }
    return found;
  }

  function markdownToBlocks(source) {
    const blocks = [];
    const lines = String(source || "").split("\n");
    let paragraph = [];
    let code = null;
    const flush = () => {
      if (paragraph.length) {
        blocks.push({ t: "p", text: plainText(paragraph.join(" ")) });
        paragraph = [];
      }
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = /^\s*```/.test(line);
      if (code !== null) {
        if (fence) {
          blocks.push({ t: "code", text: code.join("\n") });
          code = null;
        } else code.push(line);
        continue;
      }
      if (fence) {
        flush();
        code = [];
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        flush();
        blocks.push({ t: `h${heading[1].length}`, text: plainText(heading[2]) });
        continue;
      }
      if (line.trim().startsWith("|")) {
        const rows = [];
        let at = index;
        while (at < lines.length && lines[at].trim().startsWith("|")) {
          const raw = lines[at].trim();
          if (!/^[\s:|-]+$/.test(raw)) {
            rows.push(
              raw
                .replace(/^\|/, "")
                .replace(/\|$/, "")
                .split("|")
                .map((value) => plainText(value))
            );
          }
          at += 1;
        }
        if (rows.length) {
          flush();
          blocks.push({ t: "table", head: rows[0], rows: rows.slice(1) });
          index = at - 1;
          continue;
        }
      }
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        flush();
        blocks.push({ t: "bullet", text: plainText(bullet[1]) });
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ordered) {
        flush();
        blocks.push({ t: "num", text: plainText(ordered[1]) });
        continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flush();
        blocks.push({ t: "quote", text: plainText(quote[1]) });
        continue;
      }
      paragraph.push(line.trim());
    }
    flush();
    if (code) blocks.push({ t: "code", text: code.join("\n") });
    return blocks;
  }

  function slugName(value) {
    const clean = String(value || "")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 48)
      .replace(/^-+|-+$/g, "");
    return clean || "aria-file";
  }

  function saveBytes(bytes, name, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function previewHtml(file) {
    const blocks = file.blocks || [];
    if (file.kind === "xlsx") {
      return sheetsFrom(blocks)
        .map((sheet) => {
          const rows = sheet.rows
            .slice(0, 24)
            .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(cellText(value))}</td>`).join("")}</tr>`)
            .join("");
          return `<h4>${escapeHtml(sheet.name)}</h4><div class="table-wrap"><table>${rows}</table></div>`;
        })
        .join("");
    }
    if (file.kind === "pptx") {
      return slidesFrom(blocks)
        .map(
          (slide) =>
            `<div class="slide-preview"><strong>${escapeHtml(slide.title || "")}</strong>${
              slide.bullets.length
                ? `<ul>${slide.bullets.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
                : ""
            }</div>`
        )
        .join("");
    }
    if (file.kind === "csv" || file.kind === "txt") {
      const text = new TextDecoder().decode(file.bytes);
      return `<pre class="file-text">${escapeHtml(text.slice(0, 2600))}</pre>`;
    }
    return renderMarkdown(blocksToMarkdown(blocks));
  }

  function fileCard(file) {
    const card = document.createElement("div");
    card.className = "file-card";
    card.__file = file;

    const badge = document.createElement("span");
    badge.className = "file-badge";
    badge.dataset.kind = file.kind;
    badge.textContent = FILE_BADGES[file.kind] || "FILE";

    const info = document.createElement("div");
    info.className = "file-card-info";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.textContent = `${file.label} · ${humanSize(file.bytes.length)}`;
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "file-card-actions";
    const download = document.createElement("button");
    download.type = "button";
    download.dataset.download = "1";
    download.textContent = "Download";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.dataset.preview = "1";
    preview.textContent = "Preview";
    actions.append(download, preview);

    const shown = document.createElement("div");
    shown.className = "file-preview";
    shown.hidden = true;
    shown.innerHTML = previewHtml(file);

    card.append(badge, info, actions, shown);
    return card;
  }

  function saveRow() {
    const details = document.createElement("details");
    details.className = "save-as";
    const summary = document.createElement("summary");
    summary.textContent = "Save this answer as a file";
    const row = document.createElement("div");
    row.className = "save-as-row";
    for (const [kind, label] of [
      ["docx", "Word"],
      ["xlsx", "Excel"],
      ["pptx", "Slides"],
      ["pdf", "PDF"],
      ["txt", "Text"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.save = kind;
      button.textContent = label;
      row.append(button);
    }
    details.append(summary, row);
    return details;
  }

  function mountFiles(body, text, streaming) {
    if (streaming) {
      if (/```\s*aria-file/i.test(text)) {
        const wait = document.createElement("p");
        wait.className = "wait-hint";
        wait.textContent = "Building your file…";
        body.append(wait);
      }
      return;
    }
    const specs = fileBlocksIn(text);
    for (const spec of specs) {
      let file = null;
      try {
        file = specToFile(spec);
      } catch (_) {
        file = null;
      }
      if (file) body.append(fileCard(file));
      else
        notice(
          body,
          "I could not build that file — its description arrived incomplete. Ask again and I'll rebuild it."
        );
    }
    if (!specs.length && text.replace(/\s+/g, " ").length > 240) body.append(saveRow());
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
    if (!pendingImages.length) {
      try {
        live = await gatherLive(currentQuestion());
      } catch (_) {
        live = null; // a lookup is a bonus: never hold the answer up for it
      }
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

    pendingImages = [];
    busy = false;
    updateComposer();
    scrollToBottom();
  }

  async function send(text) {
    if (busy) return;
    const trimmed = text.trim();
    if (attachments.some((record) => record.state === "reading")) return;
    const files = attachments.slice();
    if (!trimmed && !files.length) return;

    pendingImages = files
      .filter((record) => record.state === "picture" && record.file)
      .slice(0, 3)
      .map((record) => record.file);

    const prompt = trimmed || defaultPrompt(files);

    el.welcome.hidden = true;
    el.input.value = "";
    autoGrow();

    attachments = [];
    renderAttachments();
    updateComposer();

    history.push({ role: "user", content: composeMessage(prompt, files) });
    addUserMessage(prompt, files);
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
        // The saved copy carries the file text; the bubble shows the words that were typed.
        const split = message.content.indexOf("\n\n[Attached file:");
        addUserMessage(split === -1 ? message.content : message.content.slice(0, split));
      } else {
        const { body } = addAssistantMessage();
        paint(body, message.content);
      }
    }
    requestAnimationFrame(() => scrollToBottom(false));
  }

  /* ------------------------------------------------------------------ *
   * Settings — appearance, text size, the reply lane, local data
   * ------------------------------------------------------------------ */

  const settings = { theme: "auto", size: "normal" };
  const darkQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (["auto", "light", "dark"].includes(saved.theme)) settings.theme = saved.theme;
        if (["small", "normal", "large"].includes(saved.size)) settings.size = saved.size;
      }
    } catch (_) {
      /* private mode: the defaults stay */
    }
  }

  function storeSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {
      /* nothing to do — the choice just won't survive a reload */
    }
  }

  function resolvedTheme() {
    if (settings.theme === "auto") return darkQuery && darkQuery.matches ? "dark" : "light";
    return settings.theme;
  }

  function applySettings() {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme();
    root.dataset.size = settings.size;

    if (el.settings) {
      el.settings.querySelectorAll("[data-theme-set]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.themeSet === settings.theme));
      });
      el.settings.querySelectorAll("[data-size-set]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.sizeSet === settings.size));
      });
    }
    paintLane();
  }

  function paintLane() {
    const text = el.laneText;
    const button = el.laneButton;
    if (!text || !button) return;

    const loaded = Boolean(window.puter && window.puter.auth && window.puter.ai);
    if (!loaded) {
      text.textContent =
        "Free lane — no account, paced at about one answer a minute. The optional free account did not load, so it cannot be switched on right now.";
      button.hidden = true;
      return;
    }

    button.hidden = false;
    if (puterReady()) {
      text.textContent =
        "Free account — instant replies, and she can see the pictures you attach. Signed in on this device.";
      button.textContent = "Sign out";
    } else {
      text.textContent =
        "Free lane — no account, paced at about one answer a minute. A free account makes replies instant and lets her see pictures.";
      button.textContent = "Use a free account";
    }
  }

  function openSettings() {
    if (!el.settings) return;
    el.settings.hidden = false;
    paintLane();
    const first = el.settings.querySelector("[data-theme-set]");
    if (first) first.focus();
  }

  function closeSettings() {
    if (el.settings) el.settings.hidden = true;
  }

  function wireSettings() {
    if (!el.settings || !el.settingsBtn) return;

    el.settingsBtn.addEventListener("click", openSettings);

    el.settings.addEventListener("click", (event) => {
      if (event.target.closest("[data-close]")) {
        closeSettings();
        return;
      }

      const themeButton = event.target.closest("[data-theme-set]");
      if (themeButton) {
        settings.theme = themeButton.dataset.themeSet;
        storeSettings();
        applySettings();
        return;
      }

      const sizeButton = event.target.closest("[data-size-set]");
      if (sizeButton) {
        settings.size = sizeButton.dataset.sizeSet;
        storeSettings();
        applySettings();
      }
    });

    el.laneButton.addEventListener("click", async () => {
      const label = el.laneButton.textContent;
      el.laneButton.disabled = true;
      el.laneButton.textContent = "Please wait…";
      try {
        if (puterReady()) {
          if (window.puter.auth.signOut) await window.puter.auth.signOut();
        } else {
          await window.puter.auth.signIn();
        }
      } catch (_) {
        /* the popup was closed or blocked — the lane stays as it was */
      }
      el.laneButton.disabled = false;
      el.laneButton.textContent = label;
      paintLane();
    });

    el.clearChatBtn.addEventListener("click", () => {
      startNewChat();
      closeSettings();
    });

    el.resetSettingsBtn.addEventListener("click", () => {
      settings.theme = "auto";
      settings.size = "normal";
      storeSettings();
      applySettings();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && el.settings && !el.settings.hidden) closeSettings();
    });

    const version = document.getElementById("settingsVersion");
    if (version) version.textContent = VERSION;
  }

  /* ------------------------------------------------------------------ *
   * UI wiring
   * ------------------------------------------------------------------ */

  function autoGrow() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(el.input.scrollHeight, el.input.clientHeight + 400)}px`;
  }

  function updateComposer() {
    const reading = attachments.some((record) => record.state === "reading");
    const ready = Boolean(el.input.value.trim()) || attachments.length > 0;
    el.send.disabled = busy ? false : !ready || reading;
    el.send.classList.toggle("busy", busy);
    el.send.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
    el.attach.disabled = busy || reading;
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

  function startNewChat() {
    if (busy) return;
    history = [];
    attachments = [];
    renderAttachments();
    save();
    el.messages.innerHTML = "";
    el.welcome.hidden = false;
    el.input.value = "";
    autoGrow();
    updateComposer();
    el.input.focus();
  }

  el.newChat.addEventListener("click", startNewChat);
  el.welcome.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    el.input.value = chip.textContent.trim();
    autoGrow();
    updateComposer();
    el.input.focus();
  });

  el.messages.addEventListener("click", async (event) => {
    const copy = event.target.closest(".copy");
    if (copy) {
      const code = decodeURIComponent(copy.dataset.code || "");
      try {
        await navigator.clipboard.writeText(code);
        copy.textContent = "copied";
        setTimeout(() => (copy.textContent = "copy"), 1400);
      } catch (_) {
        copy.textContent = "select + copy";
      }
      return;
    }

    const card = event.target.closest(".file-card");
    if (card && card.__file) {
      if (event.target.closest("[data-download]")) {
        saveBytes(card.__file.bytes, card.__file.name, card.__file.mime);
        return;
      }
      if (event.target.closest("[data-preview]")) {
        const shown = card.querySelector(".file-preview");
        if (shown) shown.hidden = !shown.hidden;
        return;
      }
    }

    const save = event.target.closest("[data-save]");
    if (save) {
      const body = save.closest(".md");
      const text = (body && body.dataset.text) || "";
      const blocks = markdownToBlocks(text);
      const heading = blocks.find((block) => block.t === "h1" || block.t === "h2");
      const title = heading ? heading.text : "Aria note";
      const file = specToFile({ kind: save.dataset.save, title, name: title, blocks });
      if (file) saveBytes(file.bytes, file.name, file.mime);
      return;
    }
  });

  el.attach.addEventListener("click", () => el.fileInput.click());

  el.fileInput.addEventListener("change", () => {
    addFiles(el.fileInput.files);
    el.fileInput.value = "";
  });

  el.attachments.addEventListener("click", (event) => {
    const remove = event.target.closest(".file-remove");
    if (!remove) return;
    attachments = attachments.filter((record) => record.id !== remove.dataset.id);
    renderAttachments();
    updateComposer();
  });

  // Dropping or pasting a file works too: same reader, same limits.
  el.form.addEventListener("dragover", (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    el.form.classList.add("dragging");
  });

  el.form.addEventListener("dragleave", (event) => {
    if (el.form.contains(event.relatedTarget)) return;
    el.form.classList.remove("dragging");
  });

  el.form.addEventListener("drop", (event) => {
    if (!event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault();
    el.form.classList.remove("dragging");
    addFiles(event.dataTransfer.files);
  });

  el.input.addEventListener("paste", (event) => {
    const files = event.clipboardData && event.clipboardData.files;
    if (files && files.length) addFiles(files);
  });

  loadSettings();
  applySettings();
  wireSettings();
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener("change", () => {
      if (settings.theme === "auto") applySettings();
    });
  }

  restore();
  autoGrow();
  updateComposer();
  if (window.matchMedia("(min-width: 700px)").matches) el.input.focus();
})();
