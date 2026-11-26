"""One-time migration: teach Aria to answer as Aria, not as ChatGPT.

The app's free model sometimes introduced itself as ChatGPT and, when asked
"is this the website or the app?", answered from web results about unrelated
products called Aria. This script puts the identity rules into app.js:

  * a firm identity block in SYSTEM_PROMPT,
  * an extra note attached only when the question is about Aria herself,
  * no web lookup for those self-questions,
  * a last-resort rewrite of any "I'm ChatGPT" that still slips through.

It is idempotent: running it on an app.js that already carries the fix does
nothing. The app-packages workflow runs it and commits the result, after which
this file and its workflow step can be deleted.
"""

import pathlib
import sys

SYSTEM_PROMPT_ANCHOR = '''    "You are Aria, a friendly and practical assistant in a small, free chat app. " +
'''

SYSTEM_PROMPT_FIX = '''    "Aria is your name and your only identity. You are not ChatGPT, not OpenAI, and not " +
    "Claude, Gemini, Copilot or any other product: never call yourself by another " +
    "product's name, never say you were made by another company, and never describe " +
    "yourself as a model built into some other chat. " +
    "If someone asks who or what you are, or whether they are talking to a website or " +
    "to the app, answer as Aria in one short line -- you are Aria, the assistant built " +
    "into this app -- and then carry on helping. " +
'''

IDENTITY_BLOCK = '''  // Attached only when someone asks about the assistant or the app itself.
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
    return /\\b(?:chatgpt|openai|gpt-?[345]|your (?:name|model|maker|creator|developer)|who (?:are|made|built|created|designed) you|what are you|are you (?:really )?(?:a |an )?(?:real |actual )?(?:ai|bot|robot|human|person|chatgpt|openai)|is this (?:the|your) (?:aria )?(?:app|application|website|site)|aria app\\b|the aria (?:app|website|site))/i.test(
      text
    );
  }

  // A free model sometimes forgets whose app it is in and introduces itself as
  // ChatGPT; put Aria's name back wherever that happens.
  function fixIdentity(text) {
    if (!text) return text;
    const other = "(?:ChatGPT|OpenAI|an? (?:AI (?:assistant|language model)|large language model)(?: (?:built|developed|created|made) by OpenAI)?)";
    return String(text)
      .replace(new RegExp(`\\\\bI(?:'|’)m\\\\s+(?:just\\\\s+)?${other}\\\\b`, "gi"), "I'm Aria")
      .replace(new RegExp(`\\\\bI am\\\\s+(?:just\\\\s+)?${other}\\\\b`, "gi"), "I am Aria")
      .replace(
        /\\bAs an? (?:AI (?:language model|assistant)|large language model)(?: (?:built|developed|created|made) by OpenAI)?,?\\s*/gi,
        ""
      )
      .replace(/\\s,(?:\\s+(?:developed|created|built|made|trained) by OpenAI)/gi, "")
      .replace(/\\s(?:developed|created|built|made|trained) by OpenAI\\b/gi, "")
      .replace(
        /\\s*[—–-]\\s*not a separate ["“‘]?Aria["”’]?\\s+(?:app|application|website|site)[^.]*\\.?/gi,
        " — you're chatting inside the Aria app itself."
      );
  }

'''

LIVE_ANCHOR = '''  // Appended to the outgoing request only, never shown to the person.
'''

PAINT_OLD = "    body.innerHTML = renderMarkdown(text);\n"
PAINT_NEW = "    body.innerHTML = renderMarkdown(fixIdentity(text));\n"

LIVE_OLD = "  async function gatherLive(text) {\n    if (!text) return null;\n"
LIVE_NEW = "  async function gatherLive(text) {\n    if (!text || asksAboutItself(text)) return null;\n"

BUILD_OLD = '''  function buildMessages(live) {
    const system = SYSTEM_PROMPT + (live && live.block ? LIVE_INSTRUCTIONS : "");
'''
BUILD_NEW = '''  function buildMessages(live) {
    const system =
      SYSTEM_PROMPT +
      (live && live.block ? LIVE_INSTRUCTIONS : "") +
      (asksAboutItself(currentQuestion()) ? SELF_NOTE : "");
'''


def swap(src, old, new, what):
    if src.count(old) != 1:
        raise SystemExit(f"{what}: expected exactly one anchor, found {src.count(old)}")
    return src.replace(old, new)


def apply(src):
    if "asksAboutItself" in src:
        return None
    src = swap(src, SYSTEM_PROMPT_ANCHOR, SYSTEM_PROMPT_ANCHOR + SYSTEM_PROMPT_FIX, "prompt")
    src = swap(src, LIVE_ANCHOR, IDENTITY_BLOCK + LIVE_ANCHOR, "identity block")
    src = swap(src, PAINT_OLD, PAINT_NEW, "paint")
    src = swap(src, LIVE_OLD, LIVE_NEW, "gatherLive")
    src = swap(src, BUILD_OLD, BUILD_NEW, "buildMessages")
    return src


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "app.js"
    src = path.read_text(encoding="utf-8")
    fixed = apply(src)
    if fixed is None:
        print(f"{path}: identity fix already present, nothing to do")
        return
    path.write_text(fixed, encoding="utf-8")
    print(f"{path}: identity fix applied")


if __name__ == "__main__":
    main()
