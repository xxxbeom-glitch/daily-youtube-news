import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const PROFILE_PATH = process.env.MUSIC_PROFILE_PATH || "music/profile.v1.json";
const STATE_PATH = process.env.MUSIC_STATE_PATH || ".music-state/history.json";
const OUTPUT_DIR = process.env.MUSIC_OUTPUT_DIR || "music-output";
const RESEARCH_MODEL = process.env.OPENAI_RESEARCH_MODEL || "gpt-5.6-terra";
const CURATOR_MODEL = process.env.OPENAI_CURATOR_MODEL || "gpt-5.6-sol";
const RESEARCH_COUNT = Math.max(50, Math.min(100, Number(process.env.MUSIC_RESEARCH_COUNT || 80)));
const RESOLVE_LIMIT = Math.max(25, Math.min(45, Number(process.env.MUSIC_RESOLVE_LIMIT || 40)));
const DAY = 86400000;
const YT = "https://www.googleapis.com/youtube/v3";
const OPENAI = "https://api.openai.com/v1/responses";
const RULES_VERSION = "music-rules-v1";
const PROMPT_VERSION = "music-prompts-v1";

const norm = (v = "") => String(v).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/\b(feat|featuring|ft)\.?\b.*$/i, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const titleNorm = (v = "") => norm(v).replace(/\b(clean|explicit|radio edit|album version|single version)\b/g, " ").trim().replace(/\s+/g, " ");
const trackKey = (t) => `${(t.primary_artists || [t.display_artist || ""]).map(norm).sort().join("+")}|${titleNorm(t.title)}|${t.version_type === "official_remix" ? "official_remix" : "original"}`;
const albumKey = (t) => `${norm((t.primary_artists || [t.display_artist || ""])[0])}|${norm(t.album || "unknown")}`;
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if (e?.code === "ENOENT") return fallback; throw e; } }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`); }
function requiredEnv(name) { const v = process.env[name]; if (!v) throw new Error(`Missing required environment variable: ${name}`); return v; }
function extractOutput(data) { if (typeof data.output_text === "string") return data.output_text; for (const item of data.output || []) for (const c of item.content || []) if (c.type === "output_text") return c.text || ""; return ""; }

async function callOpenAI({ model, instructions, input, schemaName, schema, webSearch = false, effort = "medium", max = 14000 }) {
  const body = { model, store: false, instructions, input: JSON.stringify(input), reasoning: { effort }, max_output_tokens: max, text: { format: { type: "json_schema", name: schemaName, strict: true, schema } } };
  if (webSearch) body.tools = [{ type: "web_search", search_context_size: "medium" }];
  const res = await fetch(OPENAI, { method: "POST", headers: { authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI ${model} failed (${res.status}): ${(await res.text()).slice(0,1200)}`);
  const data = await res.json();
  const text = extractOutput(data);
  if (!text) throw new Error(`OpenAI ${model} returned no structured output`);
  return { parsed: JSON.parse(text), response_id: data.id || null, usage: data.usage || null };
}

const candidateSchema = { type:"object", additionalProperties:false, properties:{ candidates:{ type:"array", items:{ type:"object", additionalProperties:false, properties:{ display_artist:{type:"string"}, primary_artists:{type:"array",items:{type:"string"}}, featured_artists:{type:"array",items:{type:"string"}}, title:{type:"string"}, album:{type:"string"}, release_date:{type:"string"}, release_year:{type:"integer"}, release_type:{type:"string",enum:["album","ep","mixtape","unknown"]}, version_type:{type:"string",enum:["original","official_remix"]}, remix_materially_distinct:{type:"boolean"}, scene_eligible:{type:"boolean"}, single_status:{type:"string",enum:["album_cut","single","pre_release","unknown"]}, title_track:{type:"boolean"}, genre_lane:{type:"string"}, evidence_urls:{type:"array",items:{type:"string"},maxItems:4}, research_note:{type:"string"} }, required:["display_artist","primary_artists","featured_artists","title","album","release_date","release_year","release_type","version_type","remix_materially_distinct","scene_eligible","single_status","title_track","genre_lane","evidence_urls","research_note"] } } }, required:["candidates"] };
const curatorSchema = { type:"object", additionalProperties:false, properties:{ results:{ type:"array", items:{ type:"object", additionalProperties:false, properties:{ candidate_id:{type:"string"}, reject:{type:"boolean"}, reject_reason:{type:"string"}, taste_score:{type:"integer",minimum:0,maximum:100}, deep_cut_score:{type:"integer",minimum:0,maximum:100}, confidence:{type:"integer",minimum:0,maximum:100}, fame_tier:{type:"string",enum:["famous","less_known"]}, traits:{ type:"object", additionalProperties:false, properties:{dark:{type:"integer",minimum:0,maximum:100},aggressive:{type:"integer",minimum:0,maximum:100},bounce:{type:"integer",minimum:0,maximum:100},groove:{type:"integer",minimum:0,maximum:100},bass:{type:"integer",minimum:0,maximum:100},melodic:{type:"integer",minimum:0,maximum:100},hiphop_base:{type:"integer",minimum:0,maximum:100},rage_risk:{type:"integer",minimum:0,maximum:100},electronic_risk:{type:"integer",minimum:0,maximum:100}}, required:["dark","aggressive","bounce","groove","bass","melodic","hiphop_base","rage_risk","electronic_risk"] }, rationale:{type:"string"} }, required:["candidate_id","reject","reject_reason","taste_score","deep_cut_score","confidence","fame_tier","traits","rationale"] } } }, required:["results"] };

function seedBlocked(t, profile, genre) { if (t.version_type === "official_remix") return false; return (profile.seed_tracks?.[genre] || []).some((s) => titleNorm(t.title) === titleNorm(s.title) && (t.primary_artists || [t.display_artist]).some((a) => norm(a).includes(norm(s.artist)) || norm(s.artist).includes(norm(a)))); }
function eraBucket(t, now = new Date()) { const d = t.release_date ? new Date(t.release_date) : new Date(Date.UTC(t.release_year,6,1)); if (Number.isNaN(d.getTime())) return "unknown"; const years = Math.max(0,(now-d)/(365.25*DAY)); if (years <= 1) return "recent_12_months"; if (years <= 5) return "one_to_five_years"; if (years <= 10) return "six_to_ten_years"; return "older_than_ten_years"; }
function hardFilter(candidates, profile, genre, state) {
  const accepted = new Set(profile.playlist.accepted_release_types);
  const cutoff = Date.now() - profile.playlist.cooldown_days * DAY;
  const recentKeys = new Set((state.recommended || []).filter((x) => new Date(x.recommended_at).getTime() >= cutoff).map((x) => x.track_key));
  const kept=[], rejected=[];
  for (const [i, raw] of candidates.entries()) {
    const t={...raw,candidate_id:`c${i+1}`}; const why=[];
    if (!t.scene_eligible) why.push("scene_ineligible");
    if (!accepted.has(t.release_type)) why.push("release_type");
    if (t.title_track) why.push("title_track");
    if (t.version_type === "official_remix" && !t.remix_materially_distinct) why.push("non_distinct_remix");
    if (t.version_type === "original" && ["single","pre_release"].includes(t.single_status)) why.push("single_or_prerelease");
    if (genre === "hiphop" && t.release_year < profile.hiphop.minimum_release_year) why.push("pre_2010_hiphop");
    if (seedBlocked(t, profile, genre)) why.push("seed_track");
    if (recentKeys.has(trackKey(t))) why.push("90_day_cooldown");
    if (/\b(slowed|reverb|sped up|nightcore|remaster|live|acoustic|karaoke)\b/i.test(t.title)) why.push("bad_version_marker");
    if (why.length) rejected.push({...t,reject_reasons:why}); else kept.push(t);
  }
  return {kept,rejected};
}

async function researchCandidates(profile, genre) {
  const lane = genre === "hiphop" ? profile.hiphop : profile.rnb;
  const instructions = `Research real released ${genre === "hiphop" ? "hip-hop" : "R&B"} tracks for one user's discovery playlist. Use web search. Metadata is FACT and must not be invented. Return about ${RESEARCH_COUNT} diverse candidates from formal albums, EPs or mixtapes. Favor album/deep cuts, lower-to-mid popularity and underheard tracks; include famous-artist deep cuts too. Primary artists must belong primarily to the U.S./North-American hip-hop/R&B market; exclude K-pop/Korean-industry primary artists. Seed tracks are taste signals only, not recommendations. Official remixes with added verses/features are allowed and distinct from originals. Avoid obvious representative singles/mega-hits, title tracks, pre-release singles, compilations, remasters and novelty edits. Evidence URLs should support track existence/release metadata. Taste target: ${lane.positive.join("; ")}. Avoid: ${lane.negative.join("; ")}.`;
  return callOpenAI({model:RESEARCH_MODEL,instructions,input:{profile_version:profile.version,genre,favorite_artists:profile.favorite_artists,seeds:profile.seed_tracks[genre],production_only_seeds:profile.seed_tracks.production_only,secondary_signals:profile.secondary_snapshot_signals},schemaName:"music_candidates_v1",schema:candidateSchema,webSearch:true,effort:"medium",max:18000});
}
async function curate(profile, genre, candidates) {
  const lane = genre === "hiphop" ? profile.hiphop : profile.rnb;
  const instructions = `Act only as a subjective music curator. Do NOT invent or correct factual metadata and do not claim you listened to audio. Score supplied real candidates from known musical knowledge and supplied metadata. The user's strongest signals are the explicit seed tracks, favorite artists, positive/negative traits. Prefer discoveries over obvious hits. For hip-hop, strongly reject rage/hyperpop/electronic-first aesthetics. For R&B, require a meaningful hip-hop rhythmic/production base and avoid sleepy ballad/acoustic/neo-soul-dominant material. A bright song can fit hip-hop if drums, bass and bounce hit hard. Return one result for every candidate_id. Positive: ${lane.positive.join("; ")}. Negative: ${lane.negative.join("; ")}.`;
  return callOpenAI({model:CURATOR_MODEL,instructions,input:{genre,seeds:profile.seed_tracks[genre],favorites:profile.favorite_artists,candidates},schemaName:"music_curation_v1",schema:curatorSchema,effort:"high",max:18000});
}

async function googleToken() { const body=new URLSearchParams({client_id:requiredEnv("GOOGLE_CLIENT_ID"),client_secret:requiredEnv("GOOGLE_CLIENT_SECRET"),refresh_token:requiredEnv("YOUTUBE_REFRESH_TOKEN"),grant_type:"refresh_token"}); const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body}); if(!r.ok) throw new Error(`Google token refresh failed (${r.status}): ${(await r.text()).slice(0,500)}`); const d=await r.json(); return d.access_token; }
async function ytGet(pathname, token, params={}) { const u=new URL(`${YT}/${pathname}`); for(const[k,v]of Object.entries(params)) if(v!==undefined&&v!==null&&v!=="")u.searchParams.set(k,String(v)); const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}}); if(!r.ok) throw new Error(`YouTube GET ${pathname} failed (${r.status}): ${(await r.text()).slice(0,700)}`); return r.json(); }
async function ytPost(pathname, token, params, body) { const u=new URL(`${YT}/${pathname}`); for(const[k,v]of Object.entries(params||{}))u.searchParams.set(k,String(v)); const r=await fetch(u,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)}); if(!r.ok) throw new Error(`YouTube POST ${pathname} failed (${r.status}): ${(await r.text()).slice(0,700)}`); return r.json(); }
function isoSeconds(v="") { const m=v.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/); return m?Number(m[1]||0)*86400+Number(m[2]||0)*3600+Number(m[3]||0)*60+Number(m[4]||0):null; }
function artistMatch(t, text) { const n=norm(text); return (t.primary_artists||[t.display_artist]).some((a)=>{const x=norm(a);return x && (n.includes(x)||x.split(" ").filter(Boolean).every((p)=>n.includes(p)));}); }
function classifyOfficialAudio(t, v) {
  const text=`${v.title}\n${v.description}\n${v.channelTitle}`; const low=text.toLowerCase();
  if (/official music video|music video|\bvevo\b|lyric video|visualizer|\blive\b|performance|concert|slowed|reverb|sped.?up|nightcore|karaoke|remaster|reaction/.test(low)) return {ok:false,reason:"non_audio_content"};
  if (t.version_type === "official_remix" && !/remix/i.test(text)) return {ok:false,reason:"remix_not_matched"};
  if (t.version_type === "original" && /\bremix\b/i.test(v.title)) return {ok:false,reason:"unexpected_remix"};
  const titleOk=titleNorm(v.title).includes(titleNorm(t.title)) || titleNorm(t.title).includes(titleNorm(v.title).replace(/ official audio/g,""));
  if (!titleOk || !artistMatch(t,text)) return {ok:false,reason:"title_or_artist_mismatch"};
  if (/ - topic$/i.test(v.channelTitle) || /provided to youtube by/i.test(v.description)) return {ok:true,type:"art_track"};
  if (/official audio/i.test(v.title) && artistMatch(t,v.channelTitle)) return {ok:true,type:"official_audio"};
  return {ok:false,reason:"not_verified_official_audio"};
}
async function resolveYouTube(t, token) {
  const q=`${t.display_artist} ${t.title} ${t.version_type === "official_remix" ? "remix" : ""} official audio`;
  const s=await ytGet("search",token,{part:"snippet",q,type:"video",videoCategoryId:10,maxResults:7}); const ids=(s.items||[]).map(x=>x.id?.videoId).filter(Boolean); if(!ids.length)return null;
  const d=await ytGet("videos",token,{part:"snippet,contentDetails,statistics,status",id:ids.join(",")});
  const ranked=[]; for(const item of d.items||[]){const v={videoId:item.id,title:item.snippet?.title||"",description:item.snippet?.description||"",channelTitle:item.snippet?.channelTitle||"",durationSeconds:isoSeconds(item.contentDetails?.duration),publishedAt:item.snippet?.publishedAt||"",viewCount:Number(item.statistics?.viewCount||0)}; const c=classifyOfficialAudio(t,v); if(c.ok)ranked.push({...v,audioType:c.type});}
  ranked.sort((a,b)=>(a.audioType==="art_track"?-1:0)-(b.audioType==="art_track"?-1:0)||a.viewCount-b.viewCount); return ranked[0]||null;
}
async function createPlaylist(token,title,description){return ytPost("playlists",token,{part:"snippet,status"},{snippet:{title,description},status:{privacyStatus:"private"}});}
async function addVideo(token,playlistId,videoId){for(let i=0;i<3;i++){try{return await ytPost("playlistItems",token,{part:"snippet"},{snippet:{playlistId,resourceId:{kind:"youtube#video",videoId}}});}catch(e){if(i===2)throw e;await sleep(1200*(i+1));}}}

function mergeCuration(candidates, results, genre) { const by=new Map(results.map(r=>[r.candidate_id,r])); return candidates.map(t=>({...t,curation:by.get(t.candidate_id)})).filter(x=>x.curation&&!x.curation.reject).filter(x=>genre!=="hiphop"||x.curation.traits.rage_risk<55).filter(x=>genre!=="hiphop"||x.curation.traits.electronic_risk<60).filter(x=>genre!=="rnb"||x.curation.traits.hiphop_base>=45).sort((a,b)=>(b.curation.taste_score+b.curation.deep_cut_score*.35+b.curation.confidence*.15)-(a.curation.taste_score+a.curation.deep_cut_score*.35+a.curation.confidence*.15)); }
function balancedShortlist(items, profile, limit=RESOLVE_LIMIT) { const out=[], artists=new Map(), albums=new Set(); for(const t of items){const p=norm(t.primary_artists?.[0]||t.display_artist); if((artists.get(p)||0)>=profile.playlist.max_tracks_per_primary_artist)continue; const a=albumKey(t); if(albums.has(a))continue; out.push(t); artists.set(p,(artists.get(p)||0)+1); albums.add(a); if(out.length>=limit)break;} return out; }
function finalScore(t, profile, current, totalSeconds) { let s=t.curation.taste_score + .3*t.curation.deep_cut_score + .1*t.curation.confidence; const famous=current.filter(x=>x.curation.fame_tier==="famous").length; if(t.curation.fame_tier==="famous" && famous/Math.max(1,current.length+1)>profile.playlist.famous_artist_share+.08)s-=18; const bucket=eraBucket(t); const target=Object.fromEntries(profile.era_mix.map(x=>[x.bucket,x.share])); const count=current.filter(x=>eraBucket(x)===bucket).length; if((count+1)/Math.max(1,current.length+1)>(target[bucket]||0)+.12)s-=12; if(bucket==="recent_12_months"&&(count+1)/Math.max(1,current.length+1)>.10)s-=25; const projected=totalSeconds+t.youtube.durationSeconds;if(projected>profile.playlist.max_duration_minutes*60)s-=1000; return s; }
function optimize(resolved, profile) { const min=profile.playlist.min_duration_minutes*60,max=profile.playlist.max_duration_minutes*60; const pool=[...resolved], selected=[]; let seconds=0; const artists=new Map(),albums=new Set(); while(pool.length&&seconds<min){let best=-1,bestScore=-Infinity; for(let i=0;i<pool.length;i++){const t=pool[i],p=norm(t.primary_artists?.[0]||t.display_artist),a=albumKey(t); if((artists.get(p)||0)>=profile.playlist.max_tracks_per_primary_artist||albums.has(a))continue; const score=finalScore(t,profile,selected,seconds); if(score>bestScore){bestScore=score;best=i;}} if(best<0||bestScore<-500)break; const [t]=pool.splice(best,1); selected.push(t);seconds+=t.youtube.durationSeconds;const p=norm(t.primary_artists?.[0]||t.display_artist);artists.set(p,(artists.get(p)||0)+1);albums.add(albumKey(t)); }
  if(seconds<min) throw new Error(`Verified candidates only reach ${(seconds/60).toFixed(1)} min; refusing to break hard rules to fill 120 min.`); return {selected,total_seconds:seconds,total_minutes:Number((seconds/60).toFixed(1))}; }
function kstStamp(){const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date());const v=Object.fromEntries(p.map(x=>[x.type,x.value]));return `${v.year}.${v.month}.${v.day} ${v.hour}${v.minute}`;}
async function summary(run){if(!process.env.GITHUB_STEP_SUMMARY)return; const lines=[`## Music discovery ${run.genre}`,``,run.playlist_url?`Playlist: ${run.playlist_url}`:"Dry run: playlist not created",`Total: ${run.total_minutes} min / ${run.selected.length} tracks`,``,`| # | Artist | Track | Album | Audio |`,`|---:|---|---|---|---|`,...run.selected.map((t,i)=>`| ${i+1} | ${t.display_artist} | ${t.title} | ${t.album} | ${t.youtube.audioType} |`)];await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join("\n")+"\n");}

async function selfTest(){const p=await readJson(PROFILE_PATH);assert.equal(p.hiphop.minimum_release_year,2010);assert.equal(p.rnb.minimum_release_year,null);assert.equal(p.playlist.famous_artist_share,.30);assert.equal(p.playlist.cooldown_days,90);assert.equal(p.playlist.max_tracks_per_album,1);const base={display_artist:"Ace Hood",primary_artists:["Ace Hood"],title:"Bugatti",version_type:"original"};assert.notEqual(trackKey(base),trackKey({...base,version_type:"official_remix"}));assert.equal(classifyOfficialAudio(base,{title:"Ace Hood - Bugatti (Official Music Video)",description:"",channelTitle:"AceHoodVEVO"}).ok,false);assert.equal(classifyOfficialAudio(base,{title:"Bugatti",description:"Provided to YouTube by Universal Music Group",channelTitle:"Ace Hood - Topic"}).ok,true);console.log("music self-test passed");}

async function main(){if(process.argv.includes("--self-test")){await selfTest();return;} const profile=await readJson(PROFILE_PATH);const state=await readJson(STATE_PATH,{version:1,recommended:[]});const genre=process.env.GENRE||"hiphop";if(!["hiphop","rnb"].includes(genre))throw new Error("GENRE must be hiphop or rnb");
  const audit={started_at:new Date().toISOString(),genre,profile_version:profile.version,rules_version:RULES_VERSION,prompt_version:PROMPT_VERSION,models:{research:RESEARCH_MODEL,curator:CURATOR_MODEL}};
  const research=await researchCandidates(profile,genre);audit.research={response_id:research.response_id,usage:research.usage,count:research.parsed.candidates.length};const filtered=hardFilter(research.parsed.candidates,profile,genre,state);audit.hard_rejected=filtered.rejected;if(filtered.kept.length<30)throw new Error(`Only ${filtered.kept.length} candidates survived hard filters; refusing low-quality generation.`);
  const cur=await curate(profile,genre,filtered.kept);audit.curation={response_id:cur.response_id,usage:cur.usage};const scored=mergeCuration(filtered.kept,cur.parsed.results,genre);const shortlist=balancedShortlist(scored,profile,RESOLVE_LIMIT);audit.shortlist_count=shortlist.length;
  const token=await googleToken();const resolved=[],resolutionRejected=[];for(const t of shortlist){const y=await resolveYouTube(t,token);if(y)resolved.push({...t,youtube:y});else resolutionRejected.push({candidate_id:t.candidate_id,artist:t.display_artist,title:t.title});}audit.youtube_rejected=resolutionRejected;audit.verified_count=resolved.length;
  const optimized=optimize(resolved,profile);const create=String(process.env.CREATE_PLAYLIST||"true").toLowerCase()==="true";let playlist=null;let title=process.env.PLAYLIST_TITLE?.trim();if(!title)title=`Discovery Test - ${genre==="hiphop"?"Hip-Hop":"R&B"} - ${kstStamp()}`;
  if(create){playlist=await createPlaylist(token,title,`Manual discovery test | profile ${profile.version} | ${RULES_VERSION} | no automatic updates`);await sleep(1200);for(const t of optimized.selected)await addVideo(token,playlist.id,t.youtube.videoId);}
  const run={...audit,finished_at:new Date().toISOString(),playlist_id:playlist?.id||null,playlist_url:playlist?`https://music.youtube.com/playlist?list=${playlist.id}`:null,playlist_title:title,total_seconds:optimized.total_seconds,total_minutes:optimized.total_minutes,selected:optimized.selected};await fs.mkdir(OUTPUT_DIR,{recursive:true});const outPath=path.join(OUTPUT_DIR,`${genre}-${Date.now()}.json`);await writeJson(outPath,run);
  if(create){state.recommended ||= [];for(const t of optimized.selected)state.recommended.push({track_key:trackKey(t),recommended_at:run.finished_at,genre,playlist_id:playlist.id,artist:t.display_artist,title:t.title,album:t.album,version_type:t.version_type,video_id:t.youtube.videoId,model:CURATOR_MODEL,profile_version:profile.version,rules_version:RULES_VERSION,prompt_version:PROMPT_VERSION,traits:t.curation.traits,taste_score:t.curation.taste_score});await writeJson(STATE_PATH,state);} await summary(run);console.log(JSON.stringify({ok:true,genre,playlistUrl:run.playlist_url,totalMinutes:run.total_minutes,tracks:run.selected.length,audit:outPath},null,2));}

main().catch((e)=>{console.error(e?.stack||e);process.exitCode=1;});
