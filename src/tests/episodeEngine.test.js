// node src/tests/episodeEngine.test.js — Auto Episode Engine rules (config/episodeEngine.js). No network.
import assert from 'assert';
import { cleanBreakdown, shotRange, shotSeconds, pick, estimateCredits, GENRE_PACKS, VISUAL_MODES, ART_STYLES, FORMATS } from '../../config/episodeEngine.js';
import { creditsFor, ACTION_COSTS, ACTION_COST_USD, CREDIT_COST_CEILING_USD } from '../../config/aiPlans.js';
import { TONES, MUSIC_THEMES } from '../../config/soundStudio.js';
import { captionText } from '../../utils/renderVideo.js';

// 1. Shot budget follows the length.
assert.deepStrictEqual(shotRange(60), { min: 9, target: 12, max: 17 });
assert.strictEqual(shotRange(300).max, 60);
assert.ok(FORMATS.every((f) => shotRange(f.seconds).min <= shotRange(f.seconds).target));

// 2. A still lasts as long as its lines (2.5 words/s) + the genre pause, 3-9 s; a clip is always 5 s.
assert.strictEqual(shotSeconds({ lines: [] }, 0.8), 3);
assert.strictEqual(shotSeconds({ lines: [{ text: 'one two three four five six seven eight nine ten' }] }, 0.8), 5.1);
assert.strictEqual(shotSeconds({ lines: [{ text: 'w '.repeat(60) }] }, 1), 9);
assert.strictEqual(shotSeconds({ motion: 'clip', lines: [{ text: 'w '.repeat(60) }] }), 5);

// 3. Close names match the lists; unknown ones are dropped.
assert.strictEqual(pick('suspenseful', TONES), 'suspense');
assert.strictEqual(pick('Mystery Noir', MUSIC_THEMES), 'mystery');
assert.strictEqual(pick('unicorn', TONES), null);

// 4. Breakdown cleaning: unknown speakers → narrator, unknown names dropped, clip count capped, clip lines fit 5 s.
const d = {
  title: 'T', characters: [{ name: 'Ellie', gender: 'female', traits: { age: '17' }, voice_id: 'sarah' }, { name: 'Narrator' }],
  locations: [{ name: "Ellie's Apartment" }], props: [{ name: 'Black Diamond', hero: true }],
  shots: [
    { scene: 1, location: "ellie's apartment", kind: 'dialogue', motion: 'clip', visual: 'Ellie wakes', characters: [{ name: 'ellie' }, { name: 'Ghost' }],
      lines: [{ speaker: 'ELLIE', text: 'Another day in the Narrows, again and again and again.', tone: 'sad' }, { speaker: 'Stranger', text: 'Hush now.' }], sfx: [{ id: 'gunshot', at: 1 }, { id: 'nope' }] },
    { scene: 1, kind: 'insert', motion: 'clip', visual: 'The diamond glows', props: [{ name: 'black diamond', state: 'glowing', holder: 'Ellie' }] },
    { scene: 2, kind: 'weird', visual: 'Market', lighting: 'golden hour' },
  ],
};
const b = cleanBreakdown(d, { range: { min: 3, max: 6 }, clipShots: 1, pack: GENRE_PACKS.drama });
assert.deepStrictEqual(b.characters.map((c) => c.name), ['Ellie'], 'the narrator is never a character');
assert.strictEqual(b.shots[0].location, "Ellie's Apartment");
assert.deepStrictEqual(b.shots[0].characters.map((c) => c.name), ['Ellie']);
assert.deepStrictEqual(b.shots[0].lines.map((l) => l.speaker), ['Ellie', 'NARRATOR'], 'an unknown speaker ("Stranger") becomes the narrator; 10 + 2 words fit a clip');
const long = cleanBreakdown({ characters: [{ name: 'A' }], shots: [{ visual: 'x', motion: 'clip', lines: [{ speaker: 'A', text: 'w '.repeat(10) }, { speaker: 'A', text: 'w '.repeat(5) }] }, { visual: 'y' }] }, { range: { min: 2, max: 4 }, clipShots: 1 });
assert.strictEqual(long.shots[0].lines.length, 1, 'a clip keeps only the lines that fit in 5 seconds (~12 words)');
assert.strictEqual(b.shots[0].motion, 'clip'); assert.strictEqual(b.shots[1].motion, 'still', 'only 1 clip was paid for');
assert.deepStrictEqual(b.shots[0].sfx.map((x) => x.id), ['gunshot']);
assert.strictEqual(b.shots[1].props[0].name, 'Black Diamond');
assert.strictEqual(b.shots[2].kind, 'action'); assert.strictEqual(b.shots[2].light.preset, 'golden');
assert.throws(() => cleanBreakdown({ shots: [{ visual: 'x' }] }, { range: { min: 9, max: 17 } }), /shots/);

// 5. Estimates and prices.
const e1 = estimateCredits({ seconds: 60, visual_mode: 'stills', newCast: 2 }, creditsFor);
assert.strictEqual(e1.clips, 0); assert.strictEqual(e1.parts.keyframes, 12 * 13);
const e2 = estimateCredits({ seconds: 60, visual_mode: 'mixed' }, creditsFor);
assert.strictEqual(e2.clips, 3); assert.ok(e2.total > e1.total);
for (const a of ['episodeBreakdown', 'episodeBreakdownLong', 'keyframe', 'stillMotion', 'episodeRender', 'episodeLedger']) {
  assert.ok(ACTION_COST_USD[a].premium / ACTION_COSTS[a].premium <= CREDIT_COST_CEILING_USD, `${a} pays for itself`);
}
assert.ok(VISUAL_MODES.clips.maxSeconds === 60 && Object.keys(ART_STYLES).length >= 5);

// 6. Captions come from the script lines, shortened.
assert.strictEqual(captionText({ lines: [{ text: 'Rent, girl.' }, { text: 'Today.' }] }), 'Rent, girl. Today.');
assert.ok(captionText({ lines: [{ text: 'w '.repeat(30) }] }).endsWith('…'));

console.log('episodeEngine: all 6 groups passed');

// 7. Pay as you go with the automation premium (owner's decision: 30% on first attempts only).
const { AUTOMATION_PREMIUM, withPremium } = await import('../../config/episodeEngine.js');
assert.strictEqual(AUTOMATION_PREMIUM, 0.3);
assert.strictEqual(withPremium(100), 130); assert.strictEqual(withPremium(13), 17, 'rounded up, never down');
const est = estimateCredits({ seconds: 60, visual_mode: 'stills', newCast: 3 }, creditsFor);
assert.strictEqual(est.range.low, withPremium(est.base), 'low end = every step once, with the premium');
assert.ok(est.range.high > est.range.low && est.total >= est.range.low && est.total <= est.range.high);
assert.strictEqual(est.redraws % creditsFor('keyframe', { premium: true }), 0, 'redraws are at base price (no premium)');
console.log('episodeEngine: pay-as-you-go pricing passed');
