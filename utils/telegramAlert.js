// Admin alerts through a Telegram bot: free, official API, instant, no
// approval. Set up once (Profile → Admin inbox → Alerts → Telegram):
//   1. In Telegram, open @BotFather, send /newbot, give it a name; it replies
//      with a bot token like 123456789:AA....
//   2. Open your new bot and press Start (or send it any message).
//   3. Paste the token in the app. The server finds your chat from that
//      message and sends a test.
const MAX_TEXT = 4000; // Telegram's limit is 4096

const api = (token, method) => `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`;

export const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;

/** The chat that last messaged the bot (the admin pressing Start). */
export async function findTelegramChat(token) {
  if (!TOKEN_RE.test(String(token || ''))) return { ok: false, error: 'That doesn\'t look like a bot token from @BotFather' };
  try {
    const me = await (await fetch(api(token, 'getMe'), { signal: AbortSignal.timeout(15_000) })).json();
    if (!me.ok) return { ok: false, error: 'Telegram rejected the bot token. Copy it again from @BotFather.' };
    const up = await (await fetch(api(token, 'getUpdates'), { signal: AbortSignal.timeout(15_000) })).json();
    const msgs = (up.result || []).map((u) => u.message || u.edited_message || u.my_chat_member).filter((m) => m?.chat?.id);
    if (!msgs.length) return { ok: false, error: `Open your bot @${me.result.username} in Telegram and press Start, then try again.`, bot: me.result.username };
    const m = msgs[msgs.length - 1];
    return { ok: true, chatId: String(m.chat.id), name: m.chat.first_name || m.chat.title || m.chat.username || '', bot: me.result.username };
  } catch (err) {
    return { ok: false, error: `Telegram unreachable: ${err.message}` };
  }
}

export async function sendTelegram({ token, chatId }, text) {
  if (!token || !chatId) return { ok: false, error: 'Telegram bot not connected' };
  try {
    const res = await fetch(api(token, 'sendMessage'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, MAX_TEXT), disable_web_page_preview: true }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) return { ok: false, error: `Telegram ${res.status}: ${j.description || 'no answer'}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Telegram unreachable: ${err.message}` };
  }
}
