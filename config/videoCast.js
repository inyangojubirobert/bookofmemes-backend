// Video Studio cast library (migration 079): Characters, Locations, Props, and
// the assembler that turns a shot's slot choices into one fixed-order prompt
// plus the reference pictures the model gets.
//
// Same slots in → same input out. Order is always:
//   references → character → location → props → action → camera → style → avoid
//
// Model limits this is built around (Runware schemas, read 2026-11-22):
//   * Seedance 2.0 video: inputs.referenceImages up to 9 plain URLs, OR
//     inputs.frameImages (a start picture) — never both. No negative prompt
//     field, so never-show items go in as an "Avoid:" line.
//   * FLUX.2 [pro] still: inputs.referenceImages up to 9, width/height required.
// So a shot either animates an approved still (start picture: best
// consistency, cheapest to iterate), or is made straight from the references.
export const MAX_REFS = 9;

export const CHARACTER_SLOTS = [
  { slot: 'front', label: 'Front face', recommended: true, hint: 'Head and shoulders, neutral expression' },
  { slot: 'three_quarter', label: 'Three-quarter', recommended: true, hint: 'Head turned about 45 degrees' },
  { slot: 'full_body', label: 'Full body', recommended: true, hint: 'Standing, default outfit' },
  { slot: 'profile', label: 'Profile', recommended: false, hint: 'Side view' },
  { slot: 'expression', label: 'Expression', recommended: false, hint: 'Fear, anger, a smile…' },
  { slot: 'hair', label: 'Hair detail', recommended: false, hint: 'Close-up of the hairstyle' },
];
export const LOCATION_SLOTS = [
  { slot: 'wide', label: 'Wide view', recommended: true, hint: 'The whole space, establishing shot' },
  { slot: 'angle', label: 'Another angle', recommended: false, hint: 'Door side, window side…' },
];
export const PROP_SLOTS = [{ slot: 'cutout', label: 'Cut-out', recommended: true, hint: 'The object alone, background removed' }];
export const SLOTS = { character: CHARACTER_SLOTS, location: LOCATION_SLOTS, prop: PROP_SLOTS };
export const POSITIONS = ['foreground', 'background', 'left', 'right', 'centre'];
export const POSES = ['standing', 'sitting', 'lying down', 'walking', 'running', 'kneeling'];
export const EXPRESSIONS = ['neutral', 'tired', 'afraid', 'angry', 'sad', 'happy', 'determined', 'surprised'];

/**
 * How ready an asset is. References are recommended, never required: one
 * picture already works, it's just less consistent.
 *   character: 0 none | 1 one picture (works, may drift) | 2 two | 3 ready (front, 3/4, full body) | 4 advanced (4+)
 */
export function readiness(a) {
  const refs = a?.refs || [];
  if (a?.kind !== 'character') {
    const ok = refs.length > 0;
    return { level: ok ? 3 : 0, label: ok ? 'Ready' : 'Add a picture', note: ok ? '' : 'Without a picture only the description is used.' };
  }
  const have = new Set(refs.map((r) => r.slot));
  const core = ['front', 'three_quarter', 'full_body'].filter((x) => have.has(x)).length;
  if (!refs.length) return { level: 0, label: 'No pictures', note: 'Only the description is used; the face will change between shots.' };
  if (refs.length >= 4 && core === 3) return { level: 4, label: 'Advanced', note: '' };
  if (core === 3) return { level: 3, label: 'Ready', note: '' };
  if (refs.length === 1) return { level: 1, label: 'One picture', note: 'Works, but the face can drift. Add a three-quarter and a full-body picture.' };
  const missing = ['front', 'three_quarter', 'full_body'].filter((x) => !have.has(x)).map((x) => x.replace('_', '-'));
  return { level: 2, label: 'Almost', note: `Add ${missing.join(' and ')} for steady results.` };
}

export const TRAIT_KEYS = ['age', 'skin', 'eyes', 'hair', 'build', 'marks'];
export const LIMITS = { characters: 4, props: 4, refsPerAsset: 8, states: 6, listItems: 12, assets: 200 };

const HTTPS = /^https:\/\/[^\s]+$/;
const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max = LIMITS.listItems, len = 60) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => s(String(x ?? ''), len)).filter(Boolean).slice(0, max);

/** Cleans an asset coming from the app. Returns { row, error }. */
export function cleanAsset(kind, b, existing = {}) {
  if (!SLOTS[kind]) return { error: 'Unknown asset kind' };
  const name = s(b.name ?? existing.name, 60);
  if (!name) return { error: 'Give it a name' };
  const slots = SLOTS[kind].map((x) => x.slot);
  const refs = (Array.isArray(b.refs) ? b.refs : existing.refs || [])
    .filter((r) => slots.includes(r?.slot) && HTTPS.test(String(r?.url || '')))
    .slice(0, LIMITS.refsPerAsset).map((r) => ({ slot: r.slot, url: r.url }));
  const states = (Array.isArray(b.states) ? b.states : existing.states || []).slice(0, LIMITS.states)
    .map((x) => ({ name: s(x?.name, 40), description: s(x?.description, 300), url: HTTPS.test(String(x?.url || '')) ? x.url : null }))
    .filter((x) => x.name);
  const traitsIn = b.traits && typeof b.traits === 'object' ? b.traits : existing.traits || {};
  const traits = kind === 'character' ? Object.fromEntries(TRAIT_KEYS.map((k) => [k, s(traitsIn[k], 120)]).filter(([, v]) => v)) : {};
  return {
    row: {
      kind, name, refs, states, traits,
      description: s(b.description ?? existing.description ?? '', 600),
      parent_id: kind === 'location' && b.parent_id !== undefined ? (b.parent_id || null) : (existing.parent_id ?? null),
      fixed_items: kind === 'location' ? list(b.fixed_items ?? existing.fixed_items) : [],
      layout: kind === 'location' ? s(b.layout ?? existing.layout ?? '', 600) : '',
      never_show: list(b.never_show ?? existing.never_show),
      tags: kind === 'prop' ? list(b.tags ?? existing.tags, 8, 30) : [],
      size_class: kind === 'prop' && ['tiny', 'hand', 'large'].includes(b.size_class ?? existing.size_class) ? (b.size_class ?? existing.size_class) : null,
      owns_rights: b.owns_rights !== undefined ? !!b.owns_rights : !!existing.owns_rights,
    },
  };
}

/** Cleans a shot's slot choices against the user's own assets. */
export function cleanSlots(b, assetsById) {
  const own = (id, kind) => assetsById[id]?.kind === kind;
  const out = {};
  if (b?.location?.id && own(b.location.id, 'location')) out.location = { id: b.location.id, state: s(b.location.state, 40) || null, facing: s(b.location.facing, 120) || null };
  out.characters = (Array.isArray(b?.characters) ? b.characters : []).filter((c) => own(c?.id, 'character')).slice(0, LIMITS.characters)
    .map((c) => ({ id: c.id, state: s(c.state, 40) || null, pose: s(c.pose, 40) || null, expression: s(c.expression, 40) || null, position: POSITIONS.includes(c.position) ? c.position : 'foreground' }));
  out.props = (Array.isArray(b?.props) ? b.props : []).filter((p) => own(p?.id, 'prop')).slice(0, LIMITS.props)
    .map((p) => ({ id: p.id, state: s(p.state, 40) || null, holder: s(p.holder, 60) || null }));
  return out;
}

export const slotAssetIds = (slots = {}) => [slots.location?.id, ...(slots.characters || []).map((c) => c.id), ...(slots.props || []).map((p) => p.id)].filter(Boolean);
export const hasSlots = (slots = {}) => slotAssetIds(slots).length > 0;

const refOf = (a, slot) => a?.refs?.find((r) => r.slot === slot)?.url || null;
const stateOf = (a, name) => (name ? a?.states?.find((x) => x.name === name) : null) || null;

function characterText(a, pick) {
  const t = a.traits || {};
  const st = stateOf(a, pick.state);
  const traits = [t.age, t.skin, t.eyes && `${t.eyes} eyes`, t.hair, t.build, t.marks].filter(Boolean).join(', ');
  return `${a.name}${traits ? ` (${traits})` : ''}${a.description ? `: ${a.description}` : ''}${st ? `. Wearing: ${st.description || st.name}` : ''}${pick.pose ? `. Pose: ${pick.pose}` : ''}${pick.expression ? `. Expression: ${pick.expression}` : ''}. Position: ${pick.position}.`;
}

/**
 * The fixed-order prompt + references for a shot.
 * Returns { prompt, references: [url], labels: [text], avoid: [text] } — prompt
 * already includes the shot's action/camera and the project look.
 */
export function assembleShot(project, shot, assetsById, { maxChars = 1800 } = {}) {
  const slots = shot.cast_slots || {};
  const loc = slots.location?.id ? assetsById[slots.location.id] : null;
  const parent = loc?.parent_id ? assetsById[loc.parent_id] : null;
  const chars = (slots.characters || []).map((c) => ({ pick: c, a: assetsById[c.id] })).filter((x) => x.a);
  const props = (slots.props || []).map((p) => ({ pick: p, a: assetsById[p.id] })).filter((x) => x.a);

  // References, most important first, at most 9: each character's face and
  // outfit, the place (lit as chosen), each prop, then extra angles.
  const refs = [];
  const labels = [];
  const add = (url, label) => { if (url && !refs.includes(url) && refs.length < MAX_REFS) { refs.push(url); labels.push(label); } };
  for (const { a, pick } of chars) add(refOf(a, 'front'), `${a.name}: front`);
  for (const { a, pick } of chars) add(stateOf(a, pick.state)?.url || refOf(a, 'full_body'), `${a.name}: ${pick.state || 'full body'}`);
  if (loc) add(stateOf(loc, slots.location.state)?.url || refOf(loc, 'wide'), `${loc.name}: ${slots.location.state || 'wide'}`);
  for (const { a, pick } of props) add(stateOf(a, pick.state)?.url || refOf(a, 'cutout'), `${a.name}${pick.state ? `: ${pick.state}` : ''}`);
  for (const { a } of chars) add(refOf(a, 'three_quarter'), `${a.name}: three-quarter`);
  if (loc) add(refOf(loc, 'angle'), `${loc.name}: angle`);
  if (parent) add(refOf(parent, 'wide'), `${parent.name}: district`);
  for (const { a } of chars) add(refOf(a, 'profile'), `${a.name}: profile`);

  const avoid = [...new Set([...chars.flatMap((x) => x.a.never_show || []), ...(loc?.never_show || []), ...(parent?.never_show || [])])];
  const look = project.look_card || {};
  const lightState = loc ? stateOf(loc, slots.location.state) : null;
  const parts = [
    refs.length && `[REFERENCES] ${labels.join('; ')}.`,
    chars.length && `[CHARACTER] ${chars.map(({ a, pick }) => characterText(a, pick)).join(' ')}`,
    loc && `[LOCATION] ${loc.name}${parent ? `, in ${parent.name}` : ''}: ${[parent?.description, loc.description].filter(Boolean).join(' ')}${loc.layout ? ` Layout: ${loc.layout}` : ''}${slots.location.facing ? ` Camera faces: ${slots.location.facing}.` : ''}${(loc.fixed_items || []).length ? ` Always visible: ${loc.fixed_items.join(', ')}.` : ''}${lightState ? ` Light: ${lightState.description || lightState.name}.` : shot.lighting ? ` Light: ${shot.lighting}.` : ''}`,
    props.length && `[PROPS] ${props.map(({ a, pick }) => `${a.name}${pick.state ? ` (${pick.state})` : ''}${a.description ? `: ${a.description}` : ''}${pick.holder ? `, held by ${pick.holder}` : ''}`).join('; ')}.`,
    `[ACTION] ${[shot.visual, shot.action].filter(Boolean).join(' ')}`,
    shot.camera && `[CAMERA] ${shot.camera}, ${shot.duration_seconds || 5} seconds.`,
    (look.style || look.palette) && `[STYLE] ${[look.style, look.palette].filter(Boolean).join('. ')}.`,
    avoid.length && `[AVOID] ${avoid.join(', ')}.`,
  ].filter(Boolean);
  return { prompt: parts.join('\n').slice(0, maxChars), references: refs, labels, avoid };
}

/**
 * Continuity between consecutive shots: a wardrobe, prop state, prop holder or
 * place that changes without the shot saying so is flagged (never blocked),
 * e.g. "Silver earrings: worn here, removed in shot 2".
 * Returns { [shotId]: [message] }.
 */
export function continuityNotes(shots, assetsById) {
  const notes = {};
  const name = (id) => assetsById[id]?.name || 'Someone';
  let prev = null;
  for (const shot of shots.filter((x) => x.included)) {
    const sl = shot.cast_slots || {};
    if (!hasSlots(sl)) { prev = null; continue; }
    const said = `${shot.visual || ''} ${shot.action || ''}`.toLowerCase();
    const mentions = (...words) => words.filter(Boolean).some((w) => said.includes(String(w).toLowerCase()));
    const out = [];
    if (prev) {
      const ps = prev.cast_slots || {};
      for (const c of sl.characters || []) {
        const before = (ps.characters || []).find((x) => x.id === c.id);
        if (before && before.state !== c.state && !mentions('change', 'dress', 'put on', 'takes off', c.state)) {
          out.push(`${name(c.id)}: wearing "${c.state || 'default'}" here but "${before.state || 'default'}" in shot ${prev.number}.`);
        }
      }
      for (const p of sl.props || []) {
        const before = (ps.props || []).find((x) => x.id === p.id);
        if (!before) continue;
        // "takes off the earrings" counts for "Silver earrings": any word of the name (4+ letters).
        const nameWords = name(p.id).split(/\s+/).filter((w) => w.length >= 4);
        if (before.state !== p.state && !mentions(p.state, ...nameWords)) {
          out.push(`${name(p.id)}: "${p.state || 'default'}" here but "${before.state || 'default'}" in shot ${prev.number}, and this shot doesn't show it changing.`);
        }
        if (before.holder !== p.holder && !mentions('give', 'hand', 'pass', 'take', p.holder)) {
          out.push(`${name(p.id)}: held by ${p.holder || 'nobody'} here, by ${before.holder || 'nobody'} in shot ${prev.number}.`);
        }
      }
      for (const p of ps.props || []) {
        if (!(sl.props || []).some((x) => x.id === p.id) && p.holder && (sl.characters || []).some((c) => assetsById[c.id]?.name === p.holder)) {
          out.push(`${name(p.id)}: ${p.holder} held it in shot ${prev.number}; it's missing here.`);
        }
      }
      if (ps.location?.id && sl.location?.id && ps.location.id !== sl.location.id && !mentions('enter', 'arrive', 'walk', 'go', 'run', name(sl.location.id))) {
        out.push(`The place changes from ${name(ps.location.id)} to ${name(sl.location.id)} without the shot showing it.`);
      }
    }
    if (out.length) notes[shot.id] = out;
    prev = shot;
  }
  return notes;
}
