-- Long-term private personalization database design.
-- Documentation only; the v1 workflow does not deploy this schema.

create table if not exists music_tracks (
  id bigserial primary key,
  canonical_key text not null unique,
  display_artist text not null,
  primary_artists jsonb not null default '[]'::jsonb,
  featured_artists jsonb not null default '[]'::jsonb,
  title text not null,
  album text,
  version_type text not null,
  youtube_video_id text,
  release_date date,
  genre_lane text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists music_runs (
  id text primary key,
  genre_lane text not null,
  generated_at timestamptz not null,
  playlist_id text,
  playlist_title text,
  rules_version text not null,
  profile_version text not null,
  prompt_version text not null,
  research_model text not null,
  curator_model text not null,
  run_metadata jsonb not null default '{}'::jsonb
);

create table if not exists music_recommendation_events (
  id bigserial primary key,
  run_id text not null references music_runs(id) on delete cascade,
  track_id bigint not null references music_tracks(id) on delete cascade,
  recommended_at timestamptz not null,
  playlist_id text,
  playlist_position integer,
  taste_score numeric,
  deep_cut_score numeric,
  feature_scores jsonb not null default '{}'::jsonb,
  recommendation_reason text,
  unique (run_id, track_id)
);

create table if not exists music_feedback_events (
  id bigserial primary key,
  track_id bigint not null references music_tracks(id) on delete cascade,
  event_type text not null check (event_type in (
    'youtube_like_observed',
    'youtube_unlike_observed',
    'explicit_dislike',
    'explicit_positive',
    'manual_note'
  )),
  observed_at timestamptz not null,
  source text not null,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists music_track_preferences (
  track_id bigint primary key references music_tracks(id) on delete cascade,
  ever_liked boolean not null default false,
  platform_liked boolean,
  explicit_dislike boolean not null default false,
  first_liked_at timestamptz,
  last_platform_state_at timestamptz,
  preference_score numeric not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists music_preference_snapshots (
  id bigserial primary key,
  generated_at timestamptz not null default now(),
  genre_lane text not null,
  sample_size integer not null default 0,
  feature_weights jsonb not null,
  source_summary jsonb not null default '{}'::jsonb,
  rules_version text not null,
  profile_version text not null
);

create index if not exists idx_music_recommendation_events_recommended_at
  on music_recommendation_events (recommended_at desc);

create index if not exists idx_music_feedback_events_track_time
  on music_feedback_events (track_id, observed_at desc);
