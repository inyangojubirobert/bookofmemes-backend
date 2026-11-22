// ?q= search text from the app, made safe to put inside a PostgREST ilike
// pattern or an .or() filter (no wildcards, commas, brackets, quotes or dots
// that would change the filter). Empty string = no search.
export const searchText = (v) => String(v || '').slice(0, 80)
  .replace(/[%_,()*.:"'\\]/g, ' ').replace(/\s+/g, ' ').trim();

/** .or() filter matching the text in any of the columns, e.g. ilikeAny('cat', ['title', 'plan->>title']). */
export const ilikeAny = (text, columns) => columns.map((c) => `${c}.ilike.*${text}*`).join(',');
