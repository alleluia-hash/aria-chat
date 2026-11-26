<p align="center">
  <a href="https://alleluia-hash.github.io/aria-chat/">
    <img src="assets/banner.svg" alt="Aria — a calm, free AI assistant for Android, Windows, iPhone and the web" width="100%">
  </a>
</p>

[**Open Aria in your browser**](https://alleluia-hash.github.io/aria-chat/) &nbsp;·&nbsp; [Android (.apk)](https://github.com/alleluia-hash/aria-chat/releases/latest) &nbsp;·&nbsp; [Windows (.zip)](https://github.com/alleluia-hash/aria-chat/releases/latest) &nbsp;·&nbsp; [itch.io](https://doggieeee.itch.io/aria-ai)

A small, free AI assistant for everyday questions. One page, no build step, no API keys of your own, no backend, no tracking.

![Aria](https://img.shields.io/badge/cost-free-161616) ![No build step](https://img.shields.io/badge/build-none-161616) ![License](https://img.shields.io/badge/license-MIT-161616)

## What it is

Aria is a normal chat window, the kind you'd use for the small things in a day: talking through a plan, turning notes into an email, fixing a sentence, working out a recipe, understanding a letter from the bank. It is deliberately plain — a text field, a timeline of replies, and nothing to configure.

It answers with Markdown: lists, **bold**, tables, and code blocks with a copy button. Your conversation stays in your browser and is there when you come back.

When a question needs a fact or a number, she searches the web first — real search results, Wikipedia in your language, live weather, exchange rates and crypto prices — and puts the sources under the reply.

## Using it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 3000
```

Then visit <http://localhost:3000>.

There is nothing to install, no account, no key.

### The Android and Windows apps

The same page is also packaged as an Android APK and a Windows zip. GitHub
Actions builds both on every push that touches the page and publishes them as
a release named after `package/VERSION`:

1. change something, then bump `package/VERSION` (`1.0.1` -> `1.0.2`)
2. push to `main`

The workflow then builds the APK (versionName `1.0.2`, versionCode `10002`),
the Windows zip and the combined zip, and creates the release `v1.0.2`, which
becomes the latest download at
<https://github.com/alleluia-hash/aria-chat/releases/latest>.

An installed app carries its own copy of `index.html`, `app.js` and
`styles.css`, so it never changes by itself: it keeps running the code it was
installed with until a newer APK is installed.

### The itch.io page

itch.io has no "watch this repository" switch, so a page filled in by hand has
to be uploaded again by hand. The way around that is `butler`, itch.io's own
command-line uploader: the same workflow that publishes the GitHub release
pushes the finished build to the page right after it, so a new version reaches
itch.io without anyone clicking anything.

The upload stays off until two things exist in this repository:

| Where to add it | Name | Value |
| --- | --- | --- |
| Settings -> Secrets and variables -> Actions -> **Secrets** | `BUTLER_API_KEY` | your itch.io API key, from <https://itch.io/user/settings/api-keys> |
| Settings -> Secrets and variables -> Actions -> **Variables** | `ITCH_PROJECT` | your page address without `https://` and `.itch.io`, e.g. `yourname/aria-chat` |

With both in place, every run pushes two channels, and both are downloads —
nothing on the page is played in the browser:

- `windows` - `Aria.exe` with the page files next to it
- `android` - `Aria.apk`

Each push is stamped with the version from `package/VERSION`, so the itch.io
page and the GitHub release always show the same number.

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

## Live lookups

Before answering a factual question, the page itself fetches a public source straight from your browser and hands it to the model as evidence:

| You ask | She reads |
| --- | --- |
| Almost anything factual | A live DuckDuckGo web search, read through the public r.jina.ai reader — titles, snippets and links from real sites |
| Who, what, when, how many, how tall | Wikipedia, in your language and in English |
| Weather | Open-Meteo, the same open data most weather apps use |
| Currency | open.er-api.com exchange rates |
| Crypto prices | CoinGecko |

Each reply that used them ends with a small "Looked up:" line linking what she read, so you can check it yourself. The search is what makes specific answers possible: ask how many copies a book sold in Italy and the snippets carry the figure, where an encyclopaedia alone would not have it. When the exact number you asked for really is not published anywhere in the results — or the sites disagree — she says so, gives the figures she found clearly labelled, and does not invent one.

## Privacy

- No analytics, no cookies, no accounts required, no server of ours in the middle.
- Conversations are stored only in this browser's `localStorage`.
- The text you type is sent to the model provider that answers. The words you look up go to DuckDuckGo and the r.jina.ai reader, then to Wikipedia, Open-Meteo, the exchange-rate API and CoinGecko; nothing else leaves the page. Like every hosted AI, treat it as a third party: don't paste passwords, card numbers or anything you wouldn't put in a search box.
- "New chat" clears the conversation from this browser.

## Files

```
index.html   the page
styles.css   the look: one column, light and dark, mobile-first
app.js       chat logic, Markdown rendering, storage, providers, live lookups
```

No frameworks, no bundler, no dependencies to audit. The only external script is the optional Puter sign-in library.

## Changing the model

The default lane uses the keyless `openai-fast` endpoint. If you'd rather use your own free key (Groq, Gemini, OpenRouter all have free tiers), replace `KEYLESS_ENDPOINT` and the request body in `askKeyless()` in `app.js` — the rest of the app is provider-agnostic.

## Limits, honestly

- It is not GPT-5-class at long reasoning or maths. She reads the search results and the public sources listed above, so she can answer with real, current figures, but she reads snippets rather than full articles, and she cannot get past a paywall or a site that blocks readers.
- Search runs through a free public reader, which allows a handful of searches a minute; when it is busy she falls back to Wikipedia and says what she used.
- Compressed conversations can lose detail; start a new chat for a new topic.
- Free public endpoints can be slow or briefly unavailable. The app tells you instead of pretending.
- Replies can be wrong. Check anything that matters — medical, legal, money.

## License

MIT — see [LICENSE](LICENSE).
