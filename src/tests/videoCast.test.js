// node src/tests/videoCast.test.js — the cast assembler and continuity check (config/videoCast.js).
import assert from 'assert';
import { assembleShot, cleanAsset, cleanSlots, continuityNotes, readiness, MAX_REFS } from '../../config/videoCast.js';

const img = (n) => `https://res.cloudinary.com/x/image/upload/${n}.png`;
const ellie = { id: 'e', kind: 'character', name: 'Ellie', description: '', traits: { age: 'teenage girl', skin: 'deep dark-brown skin', eyes: 'amber-brown', hair: 'braided buns with long box braids', build: 'slim' },
  refs: [{ slot: 'front', url: img('ef') }, { slot: 'three_quarter', url: img('e34') }, { slot: 'full_body', url: img('eb') }],
  states: [{ name: 'Narrows rags', description: 'a faded, mended cotton dress', url: img('erags') }, { name: 'Blue silk dress', description: 'a blue silk dress', url: null }],
  never_show: ['jewelry', 'piercings', 'makeup'] };
const narrows = { id: 'n', kind: 'location', name: 'The Narrows', description: 'Poor, crowded streets.', refs: [{ slot: 'wide', url: img('nw') }], states: [], never_show: ['modern objects'], fixed_items: [] };
const flat = { id: 'f', kind: 'location', name: "Ellie's apartment", parent_id: 'n', description: 'A cramped grey apartment.', layout: 'Window on the far wall; mattress under it; door behind camera; washbasin on the left.',
  refs: [{ slot: 'wide', url: img('fw') }, { slot: 'angle', url: img('fa') }], states: [{ name: 'Dawn grey', description: 'weak dawn light through a small grimy window', url: img('fdawn') }],
  fixed_items: ['thin mattress', 'chipped washbasin', 'small mirror'], never_show: ['bright colours'] };
const earrings = { id: 'r', kind: 'prop', name: 'Silver earrings', description: 'small silver hoops', refs: [{ slot: 'cutout', url: img('r') }], states: [{ name: 'worn' }, { name: 'held' }], never_show: [] };
const assets = { e: ellie, n: narrows, f: flat, r: earrings };
const project = { look_card: { style: 'Muted, desaturated, cinematic realism' } };

// 1. Fixed order, references first, never-show merged into AVOID.
const shot = { id: 's1', number: 1, included: true, visual: 'Ellie lies on the mattress.', action: 'She slowly opens her eyes and stares at the ceiling.', camera: 'Close-up, slow push-in', duration_seconds: 5,
  cast_slots: { location: { id: 'f', state: 'Dawn grey', facing: 'the window' }, characters: [{ id: 'e', state: 'Narrows rags', pose: 'lying down', expression: 'tired', position: 'foreground' }], props: [] } };
const a = assembleShot(project, shot, assets);
const order = ['[REFERENCES]', '[CHARACTER]', '[LOCATION]', '[ACTION]', '[CAMERA]', '[STYLE]', '[AVOID]'].map((t) => a.prompt.indexOf(t));
assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `sections out of order:\n${a.prompt}`);
assert.deepStrictEqual(a.references.slice(0, 3), [img('ef'), img('erags'), img('fdawn')], 'face, outfit, lit place first');
assert.ok(a.references.length <= MAX_REFS);
assert.ok(/jewelry, piercings, makeup, bright colours, modern objects/.test(a.prompt), 'never-show from character, location and district');
assert.ok(a.prompt.includes('Pose: lying down') && a.prompt.includes('Expression: tired') && a.prompt.includes('Wearing: a faded, mended cotton dress'), 'separate layers');
assert.ok(a.prompt.includes('Camera faces: the window') && a.prompt.includes('Layout: Window on the far wall'), 'spatial layout');
assert.ok(a.prompt.includes('in The Narrows'), 'district inherited');
// Same settings → same input.
assert.strictEqual(assembleShot(project, shot, assets).prompt, a.prompt);

// 2. Never more than 9 references.
const many = Object.fromEntries([...Array(6)].map((_, i) => [`c${i}`, { ...ellie, id: `c${i}`, name: `C${i}`, refs: ellie.refs.map((r) => ({ ...r, url: `${r.url}?${i}` })) }]));
const big = assembleShot(project, { ...shot, cast_slots: { characters: Object.keys(many).slice(0, 4).map((id) => ({ id, position: 'left' })) } }, many);
assert.strictEqual(big.references.length, MAX_REFS);

// 3. Continuity: earrings removed in shot 2, worn again in shot 3 without the action saying so.
const s2 = { id: 's2', number: 2, included: true, visual: 'Ellie sits up.', action: 'She takes off the earrings.', cast_slots: { characters: [{ id: 'e', state: 'Narrows rags' }], props: [{ id: 'r', state: 'held', holder: 'Ellie' }] } };
const s3 = { id: 's3', number: 3, included: true, visual: 'Maria enters.', action: 'Maria walks in.', cast_slots: { characters: [{ id: 'e', state: 'Narrows rags' }], props: [{ id: 'r', state: 'worn', holder: 'Ellie' }] } };
const notes = continuityNotes([{ ...shot, cast_slots: { ...shot.cast_slots, props: [{ id: 'r', state: 'worn', holder: 'Ellie' }] } }, s2, s3], assets);
assert.ok(!notes.s2, `shot 2 says it changes: ${notes.s2}`);
assert.ok(notes.s3?.some((n) => n.includes('Silver earrings')), 'shot 3 contradiction flagged');

// 4. Cleaning: slots only point at the user's own assets of the right kind.
const cleaned = cleanSlots({ location: { id: 'e' }, characters: [{ id: 'e', position: 'nowhere' }, { id: 'zzz' }], props: [{ id: 'r', state: 'held' }] }, assets);
assert.strictEqual(cleaned.location, undefined);
assert.deepStrictEqual(cleaned.characters.map((c) => [c.id, c.position]), [['e', 'foreground']]);
assert.strictEqual(cleanAsset('character', { name: '' }).error, 'Give it a name');
assert.ok(cleanAsset('prop', { name: 'x', refs: [{ slot: 'cutout', url: 'http://not-https' }] }).row.refs.length === 0);

// 5. References recommended, not required.
assert.strictEqual(readiness({ kind: 'character', refs: [] }).level, 0);
assert.strictEqual(readiness({ kind: 'character', refs: [{ slot: 'front', url: img(1) }] }).level, 1);
assert.strictEqual(readiness(ellie).level, 3);

console.log('videoCast: all checks passed');
console.log('\nEllie, shot 1:\n' + a.prompt + '\n\nreferences: ' + a.labels.join(' | '));
