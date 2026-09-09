const PUBLIC_PLANS_ENDPOINT =
  "https://zgzmixewdrzhwduvhkau.supabase.co/functions/v1/public-plans";
const CONSENT_KEY = "unsolo-plan-map-google-consent-v1";
const GOOGLE_SCRIPT_ID = "unsolo-google-maps";
const EXPECTED_ROOT_KEYS = ["plans", "truncated", "version"];
const EXPECTED_PLAN_KEYS = [
  "activity_id",
  "activity_label",
  "created_at",
  "date_from",
  "date_mode",
  "date_to",
  "destination_label",
  "id",
  "latitude",
  "longitude",
  "month",
];

const runtime = {
  plans: [],
  truncated: false,
  map: null,
  markers: [],
  infoWindow: null,
  mapsPromise: null,
};

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function isPublicPlan(value) {
  if (!exactKeys(value, EXPECTED_PLAN_KEYS)) return false;
  if (
    typeof value.id !== "string" || typeof value.activity_id !== "string" ||
    typeof value.activity_label !== "string" ||
    typeof value.destination_label !== "string" ||
    !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) ||
    value.latitude < -90 || value.latitude > 90 ||
    value.longitude < -180 || value.longitude > 180 ||
    !["exact", "month", "flexible"].includes(value.date_mode) ||
    typeof value.created_at !== "string"
  ) return false;
  return [value.date_from, value.date_to, value.month].every((item) =>
    item === null || typeof item === "string"
  );
}

export function parsePublicFeed(value) {
  if (!exactKeys(value, EXPECTED_ROOT_KEYS)) throw new Error("invalid_feed");
  if (value.version !== 1) throw new Error("unsupported_version");
  if (typeof value.truncated !== "boolean" || !Array.isArray(value.plans)) {
    throw new Error("invalid_feed");
  }
  if (value.plans.length > 1000 || !value.plans.every(isPublicPlan)) {
    throw new Error("invalid_feed");
  }
  return value;
}

export function publicPlansEndpoint(scope = globalThis) {
  const host = scope.location?.hostname;
  return host === "127.0.0.1" || host === "localhost"
    ? "/__public-plans"
    : PUBLIC_PLANS_ENDPOINT;
}

export async function fetchPublicPlans(
  fetcher = fetch,
  endpoint = publicPlansEndpoint(),
) {
  const response = await fetcher(endpoint, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("feed_unavailable");
  return parsePublicFeed(await response.json());
}

export function formatPlanDates(plan, locale = "en-US") {
  if (plan.date_mode === "flexible") return "Flexible dates";
  if (plan.date_mode === "month") {
    const [year, month] = plan.month.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, month - 1, 1)));
  }
  const from = new Date(`${plan.date_from}T00:00:00Z`);
  const to = new Date(`${plan.date_to}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (plan.date_from === plan.date_to) return formatter.format(from);
  return `${formatter.format(from)} – ${formatter.format(to)}`;
}

export function clusterPlans(plans, zoom) {
  const size = zoom <= 3 ? 12 : zoom <= 5 ? 5 : zoom <= 7 ? 1.7 : zoom < 10 ? 0.55 : 0;
  const groups = new Map();
  for (const plan of plans) {
    const key = size
      ? `${Math.floor(plan.latitude / size)}:${Math.floor(plan.longitude / size)}`
      : `${plan.latitude.toFixed(7)}:${plan.longitude.toFixed(7)}`;
    const group = groups.get(key) || [];
    group.push(plan);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function markerGroups(plans, zoom) {
  return clusterPlans(plans, zoom).map((group) => ({
    count: group.length,
    latitude: group.reduce((sum, plan) => sum + plan.latitude, 0) / group.length,
    longitude: group.reduce((sum, plan) => sum + plan.longitude, 0) / group.length,
    title: group.length === 1
      ? `${group[0].activity_label} in ${group[0].destination_label}`
      : `${group.length} public plans`,
    plans: group,
  }));
}

export function popupModel(plans) {
  return plans.map((plan) => ({
    activity: plan.activity_label,
    destination: plan.destination_label,
    dates: formatPlanDates(plan),
  }));
}

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

export function popupContent(plans) {
  const root = document.createElement("div");
  root.className = "plan-popup";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", plans.length === 1 ? "Plan details" : `${plans.length} plans here`);
  root.append(text("h3", plans.length === 1 ? "Plan details" : `${plans.length} plans here`));
  const list = document.createElement("div");
  list.className = "plan-popup-list";
  for (const item of popupModel(plans)) {
    const entry = document.createElement("div");
    entry.className = "plan-popup-item";
    const details = document.createElement("dl");
    for (const [label, value] of [["Activity", item.activity], ["Place", item.destination], ["Dates", item.dates]]) {
      details.append(text("dt", label), text("dd", value));
    }
    entry.append(details);
    list.append(entry);
  }
  root.append(list);
  return root;
}

function consentGranted(storage = localStorage) {
  try { return storage.getItem(CONSENT_KEY) === "yes"; } catch { return false; }
}

function setConsent(granted, storage = localStorage) {
  try {
    if (granted) storage.setItem(CONSENT_KEY, "yes");
    else storage.removeItem(CONSENT_KEY);
  } catch { /* The page still works for this visit. */ }
}

export function googleMapsUrl(key) {
  const params = new URLSearchParams({
    key,
    v: "weekly",
    loading: "async",
    callback: "__unsoloMapReady",
  });
  return `https://maps.googleapis.com/maps/api/js?${params}`;
}

export function configuredMapsKey(scope = globalThis) {
  const key = scope.__UNSOLO_PLAN_MAP_CONFIG__?.googleMapsApiKey;
  return typeof key === "string" ? key.trim() : "";
}

export function loadGoogleMaps(key, targetDocument = document) {
  if (!key) return Promise.reject(new Error("maps_key_missing"));
  if (globalThis.google?.maps) return Promise.resolve(globalThis.google.maps);
  if (runtime.mapsPromise) return runtime.mapsPromise;
  runtime.mapsPromise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code) => {
      if (settled) return;
      settled = true;
      delete globalThis.__unsoloMapReady;
      delete globalThis.gm_authFailure;
      targetDocument.querySelector(`#${GOOGLE_SCRIPT_ID}`)?.remove();
      runtime.mapsPromise = null;
      reject(new Error(code));
    };
    globalThis.gm_authFailure = () => {
      if (!settled) {
        fail("maps_auth_failed");
        return;
      }
      delete globalThis.gm_authFailure;
      runtime.mapsPromise = null;
      globalThis.dispatchEvent?.(new Event("unsolo:maps-auth-failure"));
    };
    globalThis.__unsoloMapReady = () => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        delete globalThis.__unsoloMapReady;
        resolve(globalThis.google.maps);
      }, 750);
    };
    const script = targetDocument.createElement("script");
    script.id = GOOGLE_SCRIPT_ID;
    script.src = googleMapsUrl(key);
    script.async = true;
    script.defer = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.addEventListener("error", () => fail("maps_load_failed"), { once: true });
    targetDocument.head.append(script);
  });
  return runtime.mapsPromise;
}

function feedState(state, message, note = "") {
  const status = document.querySelector("#feed-status");
  const noteNode = document.querySelector("#feed-note");
  status.dataset.state = state;
  status.lastElementChild.textContent = message;
  noteNode.textContent = note;
  noteNode.hidden = !note;
}

function showMapFailure(message = "Try again in a moment.") {
  document.querySelector("#map-error span").textContent = message;
  document.querySelector("#map-error").hidden = false;
}

function clearMarkers() {
  for (const marker of runtime.markers) marker.setMap(null);
  runtime.markers = [];
  runtime.infoWindow?.close();
}

function markerIcon(count) {
  const cluster = count > 1;
  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: cluster ? "#EC6C9F" : "#FFB84D",
    fillOpacity: 1,
    strokeColor: "#1A1D26",
    strokeOpacity: 0.88,
    strokeWeight: 3,
    scale: cluster ? Math.min(22, 13 + Math.log2(count) * 3) : 10,
  };
}

function renderMarkers() {
  if (!runtime.map || !globalThis.google?.maps) return;
  clearMarkers();
  const zoom = runtime.map.getZoom() || 4;
  for (const group of markerGroups(runtime.plans, zoom)) {
    const { plans, latitude, longitude } = group;
    const marker = new google.maps.Marker({
      map: runtime.map,
      position: { lat: latitude, lng: longitude },
      title: group.title,
      label: plans.length > 1 ? { text: String(plans.length), color: "#1A1D26", fontWeight: "700" } : undefined,
      icon: markerIcon(plans.length),
      optimized: false,
      zIndex: plans.length,
    });
    marker.addListener("click", () => {
      if (plans.length > 1 && zoom < 10) {
        runtime.map.setCenter({ lat: latitude, lng: longitude });
        runtime.map.setZoom(Math.min(10, zoom + 2));
        return;
      }
      runtime.infoWindow.setContent(popupContent(plans));
      runtime.infoWindow.open({ map: runtime.map, anchor: marker, shouldFocus: true });
    });
    runtime.markers.push(marker);
  }
}

function updateMapCount() {
  const count = runtime.plans.length;
  document.querySelector("#map-count").textContent = count === 0
    ? "No public plans yet"
    : `${count} public ${count === 1 ? "plan" : "plans"}`;
}

async function activateMap() {
  const key = configuredMapsKey();
  document.querySelector("#map-error").hidden = true;
  try {
    await loadGoogleMaps(key);
    document.querySelector("#consent-panel").hidden = true;
    document.querySelector("#map-canvas").hidden = false;
    document.querySelector("#map-toolbar").hidden = false;
    runtime.map = new google.maps.Map(document.querySelector("#map-canvas"), {
      center: { lat: 49.4, lng: 10.4 },
      zoom: 4,
      minZoom: 2,
      maxZoom: 18,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
      gestureHandling: "greedy",
      backgroundColor: "#2B2F3A",
    });
    runtime.infoWindow = new google.maps.InfoWindow({ maxWidth: 290 });
    runtime.map.addListener("zoom_changed", renderMarkers);
    renderMarkers();
    updateMapCount();
  } catch (error) {
    setConsent(false);
    const message = error?.message === "maps_key_missing"
      ? "The map is not configured yet."
      : error?.message === "maps_auth_failed"
      ? "This site is not allowed to use the map key."
      : "Google Maps did not load. Please try again.";
    showMapFailure(message);
  }
}

async function loadFeed() {
  try {
    const feed = await fetchPublicPlans();
    runtime.plans = feed.plans;
    runtime.truncated = feed.truncated;
    if (feed.plans.length === 0) {
      feedState("ready", "No plans are on the map yet.", feed.truncated ? "More plans may be available." : "Be the first to add one soon.");
    } else {
      feedState("ready", `${feed.plans.length} public ${feed.plans.length === 1 ? "plan" : "plans"} ready.`, feed.truncated ? "The map is showing the first 1,000 plans." : "");
    }
    updateMapCount();
    renderMarkers();
  } catch (error) {
    runtime.plans = [];
    if (error?.message === "unsupported_version") {
      feedState("error", "This map needs an update.", "Reload the page in a moment.");
    } else {
      feedState("error", "Plans could not load.", "Check your connection and try again.");
    }
  }
}

export function initPage() {
  globalThis.addEventListener?.("unsolo:maps-auth-failure", () => {
    setConsent(false);
    clearMarkers();
    runtime.map = null;
    document.querySelector("#map-canvas").hidden = true;
    document.querySelector("#map-toolbar").hidden = true;
    document.querySelector("#consent-panel").hidden = false;
    showMapFailure("This site is not allowed to use the map key.");
  });
  document.querySelector("#load-map").addEventListener("click", () => {
    setConsent(true);
    activateMap();
  });
  document.querySelector("#retry-map").addEventListener("click", activateMap);
  document.querySelector("#turn-off-map").addEventListener("click", () => {
    setConsent(false);
    location.reload();
  });
  document.querySelector(".add-plan-button").addEventListener("click", () => {
    feedState("ready", "Plan sharing is coming next.");
  });
  loadFeed();
  if (consentGranted()) activateMap();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPage, { once: true });
  } else {
    initPage();
  }
}
