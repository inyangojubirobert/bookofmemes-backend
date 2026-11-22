-- 079: Video Studio cast library — Characters, Locations and Props.
--
-- Instead of one loose reference picture per shot, a creator builds reusable
-- assets once (cropped reference pictures + locked text) and each shot picks
-- them: one location (+ lighting), characters (+ wardrobe, position), props
-- (+ state, who holds it). The server assembles the prompt in a fixed order
-- and sends up to 9 cropped reference pictures to the model
-- (config/videoCast.js).
--
-- One table for all three kinds; what differs lives in jsonb:
--   refs    [{ slot, url }]                 character: front | three_quarter | full_body | profile | expression | hair
--                                           location:  wide | angle ; prop: cutout
--   states  [{ name, description, url }]    character: wardrobe ; location: lighting ; prop: full / empty ...
--   traits  { age, skin, eyes, hair, build, marks }   (characters)
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.video_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('character', 'location', 'prop')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  parent_id uuid REFERENCES public.video_assets(id) ON DELETE SET NULL,  -- a location inside a district
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 600),
  traits jsonb NOT NULL DEFAULT '{}'::jsonb,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  states jsonb NOT NULL DEFAULT '[]'::jsonb,
  fixed_items text[] NOT NULL DEFAULT '{}',   -- location: always visible there
  layout text NOT NULL DEFAULT '' CHECK (length(layout) <= 600), -- location: where things are (window wall, door, mattress under the window ...)
  never_show text[] NOT NULL DEFAULT '{}',    -- merged into every shot's "avoid" list
  tags text[] NOT NULL DEFAULT '{}',          -- prop: how it can be used (held, worn, poured ...)
  size_class text CHECK (size_class IS NULL OR size_class IN ('tiny', 'hand', 'large')),
  owns_rights boolean NOT NULL DEFAULT false, -- "I own this image or have the right to use it"
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_assets_user_idx ON public.video_assets (user_id, kind, updated_at DESC);

ALTER TABLE public.video_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_assets FROM anon, authenticated;
GRANT ALL ON public.video_assets TO service_role;

ALTER TABLE public.video_assets ADD COLUMN IF NOT EXISTS layout text NOT NULL DEFAULT '';

-- A shot's slots. Identity (the character), wardrobe, pose and expression are
-- separate layers, so changing one never re-creates the others:
--   { location: { id, state, facing },
--     characters: [{ id, state (wardrobe), pose, expression, position }],
--     props: [{ id, state, holder }] }
ALTER TABLE public.video_shots ADD COLUMN IF NOT EXISTS cast_slots jsonb NOT NULL DEFAULT '{}'::jsonb;
-- The still picture made from the slots (approved, it becomes start_image_url).
ALTER TABLE public.video_shots ADD COLUMN IF NOT EXISTS still_url text;
-- Non-destructive: every clip made for the shot is kept with what made it
-- [{ url, public_id, prompt, references, credits, model, job_id, at }]; the
-- creator can switch back to any earlier version.
ALTER TABLE public.video_shots ADD COLUMN IF NOT EXISTS clip_history jsonb NOT NULL DEFAULT '[]'::jsonb;
