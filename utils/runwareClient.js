// One call to Runware's task API, shared by every route that uses it.
const RUNWARE_API_URL = 'https://api.runware.ai/v1';

// Child safety (CSAE standards, bookofmemes.cc/child-safety): a picture or video request that
// pairs a minor with sexual content is refused before it reaches any model, in every studio.
const MINOR = /\b(child|children|kid|kids|minor|minors|under-?age|teen|teens|teenager|teenagers|pre-?teen|toddler|toddlers|infant|baby|babies|school ?girl|school ?boy|little (girl|boy)|young (girl|boy)|loli|lolita|shota|(1[0-7]|[1-9])[ -]?(yo|y\/o|years?[ -]old))\b/i;
const SEXUAL = /\b(sex|sexy|sexual|nude|nudes|naked|nsfw|porn|porno|pornographic|erotic|erotica|lingerie|explicit|undress|undressed|undressing|topless|bottomless|seductive|fetish|genital|genitals|breasts?|nipples?|bikini|lewd|hentai)\b/i;
export const isCsaeRisk = (text) => MINOR.test(String(text || '')) && SEXUAL.test(String(text || ''));

export async function callRunwareTasks(tasks) {
  for (const t of tasks || []) {
    if (['imageInference', 'videoInference'].includes(t?.taskType) && isCsaeRisk(t.positivePrompt)) {
      console.warn('[child safety] refused a', t.taskType, 'request');
      throw Object.assign(new Error('This request was refused: Bascardo AI never makes sexual content involving minors.'), { permanent: true, status: 400, csae: true });
    }
  }
  const response = await fetch(RUNWARE_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RUNWARE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(tasks),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.errors?.length) {
    const err = new Error(json?.errors?.[0]?.message || `Runware request failed (${response.status})`);
    err.providerHttpStatus = response.status;
    // A request Runware rejects as invalid fails the same way every time; a
    // background job shouldn't retry it (rate limits / 5xx are retried).
    if (response.status >= 400 && response.status < 500 && response.status !== 429) err.permanent = true;
    throw err;
  }
  return { data: json?.data || [], status: response.status };
}
