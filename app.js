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
  };

  /** @type {{role: "user"|"assistant", content: string}[]} */
  let history = [];
  /** @type {{id: string, name: string, size: number, type: string, state: string, label: string, text: string, note: string}[]} */
  let attachments = [];
  let attachmentSeq = 0;
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

  function paint(body, text) {
    body.innerHTML = renderMarkdown(fixIdentity(text));
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
    if (media) {
      record.state = "media";
      record.label = media;
      record.note =
        `This is a ${media} file. The free text lane cannot see pictures or watch video, so ` +
        `describe what is in it, or paste the text that needs working on.`;
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
      record.file = null;
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
    const system =
      SYSTEM_PROMPT +
      (live && live.block ? LIVE_INSTRUCTIONS : "") +
      (hasFiles ? FILES_INSTRUCTIONS : "") +
      (asksAboutItself(currentQuestion()) ? SELF_NOTE : "");
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
    if (busy) return;
    const trimmed = text.trim();
    if (attachments.some((record) => record.state === "reading")) return;
    const files = attachments.slice();
    if (!trimmed && !files.length) return;

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

  el.newChat.addEventListener("click", () => {
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

  restore();
  autoGrow();
  updateComposer();
  if (window.matchMedia("(min-width: 700px)").matches) el.input.focus();
})();
