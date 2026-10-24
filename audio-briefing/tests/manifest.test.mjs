import test from "node:test";
import assert from "node:assert/strict";
import { ManifestError, validateManifest, prepareDraftInput } from "../src/manifest.mjs";
import { buildDraftRequest } from "../src/prompt.mjs";

const valid = () => ({
  date: "2026-10-25",
  playlistId: "test-playlist",
  items: [{
    videoId: "fictional-id",
    title: "FICTIONAL: 가상의 교통 서비스",
    category: "생활",
    evidence: [{
      sourceId: "fictional-source",
      publisher: "Fixture only",
      url: "https://example.org/fictional",
      rights: "owned",
      text: "이 문장은 자동화 검증을 위한 가상의 원문입니다. 실제 보도나 자료를 뜻하지 않습니다. 교통 기관이 실재하는 발표를 했다는 주장이 아니며, 원고 생성 시스템의 입력 형식을 시험하기 위해 제공됩니다."
    }]
  }]
});

test("allows a complete permissioned evidence manifest (test data only)", () => {
  assert.equal(validateManifest(valid()), true);
  const request = buildDraftRequest(valid());
  assert.match(request.instructions, /Korean/);
  assert.equal(JSON.parse(request.input).items[0].evidence[0].sourceId, "fictional-source");
});

test("rejects title-only manifest instead of inventing story", () => {
  const input = valid();
  input.items[0].evidence = [];
  assert.throws(() => prepareDraftInput(input), ManifestError);
});

test("rejects unlicensed or short evidence", () => {
  const input = valid();
  input.items[0].evidence[0].rights = "unknown";
  input.items[0].evidence[0].text = "A";
  assert.throws(() => validateManifest(input), /usage rights/);
});

test("rejects duplicate videos", () => {
  const input = valid();
  input.items.push(structuredClone(input.items[0]));
  assert.throws(() => validateManifest(input), /duplicated/);
});
