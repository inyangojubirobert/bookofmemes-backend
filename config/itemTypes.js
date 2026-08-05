// Backend/config/itemTypes.js
// Canonical registry of every universal item type. Add a new content type here ONCE
// and search, comments, and profile post-count all pick it up automatically.
// Mirrors src/config/itemTypes.js on the frontend (same type-id strings) -- that file
// is hand-maintained separately (Metro cannot import across the Backend/ package
// boundary), so if you add a type here, add it there too.

export const ITEM_TYPES = {
  stories:          { table: "stories",          select: "id,title,author_id,cover_image_url,story_synopsis,views_count,likes_count,created_at",           search: ["title", "story_synopsis"], img: "cover_image_url", view: "views_count", like: "likes_count", isContent: true },
  memes:            { table: "memes",             select: "id,title,author_id,image_url,description,reads_count,likes_count,created_at",                   search: ["title", "description"],    img: "image_url",       view: "reads_count", like: "likes_count", isContent: true },
  puzzles:          { table: "puzzles",           select: "id,title,author_id,description,reads_count,likes_count,created_at",                             search: ["title", "description"],    img: null,              view: "reads_count", like: "likes_count", isContent: true },
  kids_collections: { table: "kids_collections",  select: "id,title,author_id,description,reads_count,likes_count,created_at",                             search: ["title", "description"],    img: null,              view: "reads_count", like: "likes_count", isContent: true },
  music_box:        { table: "music_box",         select: "id,title,author_id,cover_image_url,description,artist_name,play_count,like_count,created_at",   search: ["title", "artist_name"],    img: "cover_image_url", view: "play_count",  like: "like_count",  isContent: true },
  podcast_box:      { table: "podcast_box",       select: "id,title,author_id,cover_image_url,description,host_name,play_count,like_count,created_at",     search: ["title", "host_name"],      img: "cover_image_url", view: "play_count",  like: "like_count",  isContent: true },
  tv_box:           { table: "tv_box",            select: "id,title,author_id,thumbnail_url,description,genre,view_count,like_count,created_at",           search: ["title", "genre"],          img: "thumbnail_url",   view: "view_count",  like: "like_count",  isContent: true },
  profile:          { table: "profiles",          select: "id,full_name,username,bio,avatar_url,created_at",                                                search: ["username", "full_name", "bio"], img: "avatar_url", view: null, like: null, isContent: false },
};

export const ALL_TYPES = Object.keys(ITEM_TYPES);

// Author-owned content types only -- excludes "profile" (profiles table has no
// author_id column; it *is* the owner). Used by comments + post-count endpoints.
// Assumption: every CONTENT_TYPES table has an "author_id" column (true today for
// all 7 — review this assumption if that ever changes for a new type).
export const CONTENT_TYPES = ALL_TYPES.filter((t) => ITEM_TYPES[t].isContent);
