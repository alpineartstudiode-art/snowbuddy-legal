import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  clusterPlans,
  configuredMapsKey,
  fetchPublicPlans,
  formatPlanDates,
  googleMapsUrl,
  markerGroups,
  parsePublicFeed,
  popupModel,
  publicPlansEndpoint,
} from "../docs/unsolo/plans/plans.mjs";

const root = new URL("../docs/unsolo/plans/", import.meta.url);
const plan = (overrides = {}) => ({
  id: "10000000-0000-4000-8000-000000000001",
  activity_id: "hiking",
  activity_label: "Hiking",
  destination_label: "Munich, Bavaria, Germany",
  latitude: 48.137154,
  longitude: 11.576124,
  date_mode: "exact",
  date_from: "2027-06-10",
  date_to: "2027-06-12",
  month: null,
  created_at: "2026-09-09T10:00:00.000000Z",
  ...overrides,
});

test("accepts the exact public V1 DTO", () => {
  const result = parsePublicFeed({ version: 1, truncated: false, plans: [plan()] });
  assert.equal(result.plans.length, 1);
});

test("rejects unknown API versions and private fields", () => {
  assert.throws(() => parsePublicFeed({ version: 2, truncated: false, plans: [] }), /unsupported_version/);
  assert.throws(() => parsePublicFeed({ version: 1, truncated: false, plans: [plan({ destination_id: "2867714" })] }), /invalid_feed/);
  assert.throws(() => parsePublicFeed({ version: 1, truncated: false, plans: [plan({ email: "no@example.invalid" })] }), /invalid_feed/);
});

test("enforces the 1000 item public contract", () => {
  const plans = Array.from({ length: 1001 }, (_, index) => plan({ id: String(index) }));
  assert.throws(() => parsePublicFeed({ version: 1, truncated: true, plans }), /invalid_feed/);
});

test("formats all three date modes", () => {
  assert.match(formatPlanDates(plan()), /Jun 10, 2027/);
  assert.equal(formatPlanDates(plan({ date_mode: "month", date_from: null, date_to: null, month: "2027-06-01" })), "June 2027");
  assert.equal(formatPlanDates(plan({ date_mode: "flexible", date_from: null, date_to: null })), "Flexible dates");
});

test("clusters nearby plans at wide zoom without changing coordinates", () => {
  const first = plan();
  const second = plan({ id: "10000000-0000-4000-8000-000000000002", latitude: 48.14, longitude: 11.58 });
  assert.deepEqual(clusterPlans([first, second], 5).map((group) => group.length), [2]);
  assert.equal(first.latitude, 48.137154);
  assert.equal(second.longitude, 11.58);
});

test("keeps separate nearby plans at close zoom and groups exact overlaps", () => {
  const close = plan({ id: "10000000-0000-4000-8000-000000000002", latitude: 48.14 });
  assert.equal(clusterPlans([plan(), close], 11).length, 2);
  assert.equal(clusterPlans([plan(), plan({ id: "10000000-0000-4000-8000-000000000003" })], 11).length, 1);
});

test("turns public DTOs into marker models without private data", () => {
  const markers = markerGroups([plan()], 11);
  assert.deepEqual(Object.keys(markers[0]).sort(), ["count", "latitude", "longitude", "plans", "title"]);
  assert.equal(markers[0].count, 1);
  assert.equal(markers[0].title, "Hiking in Munich, Bavaria, Germany");
});

test("popup model contains only activity, destination and dates", () => {
  assert.deepEqual(Object.keys(popupModel([plan()])[0]).sort(), ["activity", "dates", "destination"]);
});

test("fetch uses the public endpoint with a private-free GET", async () => {
  let request;
  const feed = await fetchPublicPlans(async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ version: 1, truncated: false, plans: [] }) };
  });
  assert.equal(feed.plans.length, 0);
  assert.match(request.url, /zgzmixewdrzhwduvhkau\.supabase\.co\/functions\/v1\/public-plans$/);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
});

test("local browser verification uses only the read-only same-origin proxy", () => {
  assert.equal(publicPlansEndpoint({ location: { hostname: "127.0.0.1" } }), "/__public-plans");
  assert.equal(publicPlansEndpoint({ location: { hostname: "localhost" } }), "/__public-plans");
  assert.match(publicPlansEndpoint({ location: { hostname: "alpineart.de" } }), /supabase\.co\/functions\/v1\/public-plans$/);
});

test("Google resources are absent from HTML and created only by the consent loader", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.doesNotMatch(html, /<(?:script|iframe)[^>]+(?:googleapis|gstatic)/i);
  assert.doesNotMatch(html, /rel=["'](?:preconnect|dns-prefetch|preload)["'][^>]+google/i);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/i);
  assert.match(html, /<script src="maps-key\.js"><\/script>/);
  assert.doesNotMatch(html, /maps-key\.(?:dev\.)?local\.js/);
  assert.match(googleMapsUrl("test-key"), /^https:\/\/maps\.googleapis\.com\/maps\/api\/js\?/);
  assert.match(googleMapsUrl("test-key"), /loading=async/);
  assert.equal(configuredMapsKey({}), "");
  assert.equal(configuredMapsKey({ __UNSOLO_PLAN_MAP_CONFIG__: { googleMapsApiKey: " local-key " } }), "local-key");
});

test("route uses approved branding and keeps the add button non-forming", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /Going somewhere\?/);
  assert.match(html, /See who else has plans\./);
  assert.match(html, /aria-hidden="true">\+<\/span> Add your plan/);
  assert.match(html, /\.\.\/download\/assets\/logo\.png/);
  assert.doesNotMatch(html, /<form\b/i);
});
