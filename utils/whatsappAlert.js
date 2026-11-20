// Sends a WhatsApp message to the admin's own number through CallMeBot
// (https://www.callmebot.com/blog/free-api-whatsapp-messages/). CallMeBot
// only sends to a number that has allowed it, which suits alerts to yourself:
//   1. Save the number shown on that page in your phone's contacts.
//   2. Send it the WhatsApp message "I allow callmebot to send me messages".
//   3. It replies with your API key. Enter the number and key in the app
//      (Profile → Admin inbox → WhatsApp alerts).
const MAX_TEXT = 1500; // keep the request URL a safe length

export async function sendWhatsApp({ number, apikey }, text) {
  if (!number || !apikey) return { ok: false, error: 'WhatsApp number or CallMeBot key not set' };
  const url = 'https://api.callmebot.com/whatsapp.php'
    + `?phone=${encodeURIComponent(number)}`
    + `&text=${encodeURIComponent(String(text).slice(0, MAX_TEXT))}`
    + `&apikey=${encodeURIComponent(apikey)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // CallMeBot answers 200 even for some errors; the text says which.
    if (!res.ok || /invalid|error|not allowed|wrong|blocked|exceeded/i.test(body)) {
      return { ok: false, error: `CallMeBot ${res.status}: ${body.slice(0, 200) || 'no answer'}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `CallMeBot unreachable: ${err.message}` };
  }
}

export const WHATSAPP_MAX_TEXT = MAX_TEXT;
