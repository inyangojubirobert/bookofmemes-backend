const DAY_MS = 24 * 60 * 60 * 1000;

// In-memory sliding-window counter, same tradeoff as aiRoutes.js's original
// dailyResearchQuota -- fine for a single Node process, resets on
// restart/redeploy. Used for the "Generate Bascardo AI Content" writing quota
// (aiRoutes.js /write), which stays daily since text generations are cheap --
// image/video/voice caps are monthly instead (see utils/monthlyQuota.js),
// where an in-memory reset on every deploy would be a real cost-control gap.
export function makeDailyCounter() {
  const hits = new Map(); // key -> [timestamps]

  function usedToday(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < DAY_MS);
    hits.set(key, list);
    return list.length;
  }

  function record(key) {
    usedToday(key); // prune first so the map entry exists and is fresh
    hits.get(key).push(Date.now());
  }

  return { usedToday, record };
}
