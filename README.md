# Aria

A small, free AI assistant for everyday questions. One page, no build step, no API keys of your own, no backend, no tracking.

![Aria](https://img.shields.io/badge/cost-free-161616) ![No build step](https://img.shields.io/badge/build-none-161616) ![License](https://img.shields.io/badge/license-MIT-161616)

## What it is

Aria is a normal chat window, the kind you'd use for the small things in a day: talking through a plan, turning notes into an email, fixing a sentence, working out a recipe, understanding a letter from the bank. It is deliberately plain — a text field, a timeline of replies, and nothing to configure.

It answers with Markdown: lists, **bold**, tables, and code blocks with a copy button. Your conversation stays in your browser and is there when you come back.

## Using it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 3000
```

Then visit <http://localhost:3000>.

There is nothing to install, no account, no key.

### Hosting it for other people (GitHub Pages)

1. In this repository: **Settings → Pages**
2. **Source:** Deploy from a branch
3. **Branch:** `main`, folder `/ (root)` → **Save**

A minute later the assistant is live at:

```
https://alleluia-hash.github.io/aria-chat/
```

## How the AI part works

Aria is the interface; the language model is served by someone else. That is what keeps it free and keyless.

| Lane | What it costs | Speed |
| --- | --- | --- |
| Default: public keyless model endpoint | Free, no account | Paced at roughly one answer a minute per network, shared by everyone |
| Optional: free Puter account | Free account, no card | Instant, streaming replies |

The default lane is a generous free service, so it paces requests. When you hit that pace, Aria says so, counts down, and answers on its own — nothing is lost and nothing breaks. If you'd like instant replies, the same card offers a free account sign-in; after that, replies stream word by word.

If a provider is unreachable, Aria keeps the conversation and offers a retry rather than failing silently.

## Privacy

- No analytics, no cookies, no accounts required, no server of ours in the middle.
- Conversations are stored only in this browser's `localStorage`.
- The text you type is sent to the model provider that answers. Like every hosted AI, treat it as a third party: don't paste passwords, card numbers or anything you wouldn't put in a search box.
- "New chat" clears the conversation from this browser.

## Files

```
index.html   the page
styles.css   the look: one column, light and dark, mobile-first
app.js       chat logic, Markdown rendering, storage, providers
```

No frameworks, no bundler, no dependencies to audit. The only external script is the optional Puter sign-in library.

## Changing the model

The default lane uses the keyless `openai-fast` endpoint. If you'd rather use your own free key (Groq, Gemini, OpenRouter all have free tiers), replace `KEYLESS_ENDPOINT` and the request body in `askKeyless()` in `app.js` — the rest of the app is provider-agnostic.

## Limits, honestly

- It is not GPT-5-class at long reasoning, maths or current events, and it does not browse the web.
- Compressed conversations can lose detail; start a new chat for a new topic.
- Free public endpoints can be slow or briefly unavailable. The app tells you instead of pretending.
- Replies can be wrong. Check anything that matters — medical, legal, money.

## License

MIT — see [LICENSE](LICENSE).
