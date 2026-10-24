// Pure input guards. This module does not access the network, filesystem or YouTube.
const VALID_RIGHTS = new Set(["owned", "licensed", "permission-granted", "public-domain"]);
const TEXT_MIN_LENGTH = 80;

export class ManifestError extends Error {
  constructor(errors) {
    super("Unsafe briefing manifest: " + errors.join("; "));
    this.name = "ManifestError";
    this.details = errors;
  }
}

export function validateManifest(manifest) {
  const errors = [];
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = (v) => typeof v === "string" ? v.trim() : "";

  if (!isObject(manifest)) throw new ManifestError(["manifest must be an object"]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(manifest.date))) errors.push("date must be YYYY-MM-DD");
  if (!str(manifest.playlistId)) errors.push("playlistId is required");
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    errors.push("items must be a nonempty array");
  } else {
    const seen = new Set();
    manifest.items.forEach((item, idx) => {
      const prefix = "items[" + idx + "]";
      if (!isObject(item)) { errors.push(prefix + " must be an object"); return; }
      if (!str(item.videoId)) errors.push(prefix + ".videoId is required");
      if (seen.has(item.videoId)) errors.push(prefix + ".videoId is duplicated");
      seen.add(item.videoId);
      if (!str(item.title)) errors.push(prefix + ".title is required");
      if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
        errors.push(prefix + " needs licensed full-text evidence; YouTube metadata is insufficient");
        return;
      }
      item.evidence.forEach((e, j) => {
        const p = prefix + ".evidence[" + j + "]";
        if (!isObject(e)) { errors.push(p + " must be an object"); return; }
        if (!str(e.sourceId) || !str(e.publisher)) errors.push(p + " needs sourceId and publisher");
        if (!/^https:\/\//i.test(str(e.url))) errors.push(p + " needs an https source URL");
        if (!VALID_RIGHTS.has(e.rights)) errors.push(p + " lacks declared usage rights");
        if (str(e.text).length < TEXT_MIN_LENGTH) errors.push(p + " needs sufficient authorized full text");
      });
    });
  }
  if (errors.length) throw new ManifestError(errors);
  return true;
}

// Does not determine whether source text is accurate: that needs a separate editorial stage.
export function prepareDraftInput(manifest) {
  validateManifest(manifest);
  return {
    date: manifest.date,
    playlistId: manifest.playlistId,
    items: manifest.items.map((item) => ({
      videoId: item.videoId,
      title: item.title,
      category: item.category || "일반",
      evidence: item.evidence.map((e) => ({
        sourceId: e.sourceId,
        publisher: e.publisher,
        url: e.url,
        text: e.text,
      })),
    })),
  };
}
