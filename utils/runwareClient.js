// One call to Runware's task API, shared by every route that uses it.
const RUNWARE_API_URL = 'https://api.runware.ai/v1';

export async function callRunwareTasks(tasks) {
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
