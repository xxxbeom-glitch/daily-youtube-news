import { prepareDraftInput } from "./manifest.mjs";

// Pure prompt construction only. Does NOT invoke OpenAI, transcribe audio, publish or schedule.
const INSTRUCTIONS = [
  "You write an original Korean radio/TV-style morning news briefing.",
  "Use only provided permissioned full-text evidence for factual statements.",
  "The title and YouTube metadata are discovery information, not proof of the story.",
  "If a number, attribution, date or quote is unsupported, omit it or mark it uncertain.",
  "Use clear, restrained formal Korean broadcast language; short sentences natural when spoken.",
  "Do not copy source prose, impersonate a named anchor, or mimic an identifiable broadcaster.",
  "Do not invent connective facts or consequences; separate verified statements and forecasts.",
  "Output JSON with segments (videoId, script, sourceIds, uncertainties) and warnings.",
  "Every segment sourceId must match at least one provided evidence source.",
  "No unsupported segment should be generated. Do not pad length."
].join("\n");

export function buildDraftRequest(manifest) {
  return { instructions: INSTRUCTIONS, input: JSON.stringify(prepareDraftInput(manifest)) };
}
