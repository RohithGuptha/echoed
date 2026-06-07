// --- state ---

var fields      = [{ label: "Name", type: "text" }, { label: "Email", type: "email" }, { label: "Message", type: "textarea" }];
var shared      = null;
var FIELD_TYPES = ["text", "email", "textarea", "number", "date", "url", "tel"];

// delimiter bytes: ASCII control codes not present on any keyboard layout.
// sanitizeForSerial() strips them from all user-supplied strings before serialization,
// preventing injection that would corrupt the split() in deserialize().
var FS = "\x1C"; // separates the three top-level sections (title | fields | values)
var RS = "\x1E"; // separates records within a section (one entry per field)
var US = "\x1F"; // separates units within a field record (label | type-index)

// encoding tags: first byte of every compressed payload written by compressBytes().
// decompressBytes() reads this byte to know how to decode the rest, making all
// cross-browser writer/reader combinations deterministic.
var TAG_DEFLATE = 1; // remaining bytes are deflate-compressed
var TAG_RAW     = 2; // remaining bytes are raw UTF-8 (compression unavailable or not beneficial)

// refreshURL() sequence counter. Only the call that last incremented this commits
// its result to the DOM and history, preventing stale async results from winning a race.
var refreshSeq = 0;


// --- serialization ---

// Strip the three delimiter characters from any string before it enters the serial format.
// These characters are not typeable but are pasteable, so we must sanitize explicitly.
function sanitizeForSerial(s) {
  return String(s).replace(/[\x1C\x1E\x1F]/g, "");
}

function serialize(d) {
  return sanitizeForSerial(d.title || "") + FS
    + d.fields.map(function (f) {
        return sanitizeForSerial(f.label) + US + FIELD_TYPES.indexOf(f.type);
      }).join(RS)
    + FS
    + d.fields.map(function (f) {
        return sanitizeForSerial(d.values[f.label] || "");
      }).join(RS);
}

function deserialize(str) {
  var parts     = str.split(FS);
  var title     = parts[0] || "";
  var fparts    = parts[1] ? parts[1].split(RS) : [];
  var vparts    = parts[2] ? parts[2].split(RS) : [];
  var fieldList = fparts.map(function (fp) {
    var up = fp.split(US);
    return { label: up[0] || "", type: FIELD_TYPES[parseInt(up[1], 10)] || "text" };
  });
  var values = {};
  fieldList.forEach(function (f, i) { values[f.label] = vparts[i] || ""; });
  return { title: title, fields: fieldList, values: values };
}


// --- binary encoding ---

function stringToUint8Array(str) { return new TextEncoder().encode(str); }
function uint8ArrayToString(bytes) { return new TextDecoder().decode(bytes); }

function bytesToBase64Url(bytes) {
  var bin = "";
  bytes.forEach(function (b) { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  var b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}


// --- compression ---

// deflateBytes / inflateBytes: thin async wrappers around the native Streams API.
// Both throw if the browser lacks CompressionStream / DecompressionStream, or if
// the input is not valid deflate data — callers must handle rejections.

async function deflateBytes(bytes) {
  var cs     = new CompressionStream("deflate");
  var writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  var chunks = [], reader = cs.readable.getReader();
  for (;;) { var r = await reader.read(); if (r.done) break; chunks.push(r.value); }
  var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
  var out = new Uint8Array(total), pos = 0;
  chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
  return out;
}

async function inflateBytes(bytes) {
  var ds     = new DecompressionStream("deflate");
  var writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  var chunks = [], reader = ds.readable.getReader();
  for (;;) { var r = await reader.read(); if (r.done) break; chunks.push(r.value); }
  var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
  var out = new Uint8Array(total), pos = 0;
  chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
  return out;
}

// compressBytes: attempts deflate (TAG_DEFLATE). Falls back to raw (TAG_RAW) if
// CompressionStream is absent or if deflate expands the input (common for short
// payloads where the deflate header overhead exceeds any savings). The TAG_ prefix
// is always written so decompressBytes() never has to guess the encoding.
async function compressBytes(bytes) {
  if (typeof CompressionStream !== "undefined") {
    try {
      var compressed = await deflateBytes(bytes);
      if (compressed.length < bytes.length) {
        var out = new Uint8Array(1 + compressed.length);
        out[0] = TAG_DEFLATE;
        out.set(compressed, 1);
        return out;
      }
    } catch (e) {}
  }
  var out = new Uint8Array(1 + bytes.length);
  out[0] = TAG_RAW;
  out.set(bytes, 1);
  return out;
}

// decompressBytes: reads the TAG_ byte written by compressBytes() and dispatches.
// An unrecognised tag throws, which boot()'s try/catch converts to setTab("build").
async function decompressBytes(tagged) {
  var tag     = tagged[0];
  var payload = tagged.slice(1);
  if (tag === TAG_DEFLATE) return await inflateBytes(payload);
  if (tag === TAG_RAW)     return payload;
  throw new Error("unknown encoding tag: " + tag);
}


// --- clipboard ---

// writeClipboard: wraps navigator.clipboard.writeText with an outer try/catch.
// On non-HTTPS origins navigator.clipboard is undefined; accessing .writeText throws
// synchronously before any promise is created, so a .catch() on the returned promise
// is unreachable. The outer catch ensures the prompt() fallback always fires.
function writeClipboard(text, successMsg) {
  try {
    if (!navigator.clipboard) throw new Error("unavailable");
    navigator.clipboard.writeText(text)
      .then(function ()  { showToast(successMsg); })
      .catch(function () { prompt("Copy:", text); });
  } catch (e) {
    prompt("Copy:", text);
  }
}


// --- utility ---

function slug(s) { return s.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, ""); }

function esc(s) {
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

function showToast(msg) {
  var t = document.getElementById("toast-msg");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function () { t.classList.remove("show"); }, 2500);
}


// --- tabs ---

function setTab(e, name) {
  ["fill", "view"].forEach(function (n) {
    var isTarget = n === name;
    var tab  = document.getElementById("tab-" + n);
    var pane = document.getElementById("pane-" + n);
    if (tab) {
      tab.classList.toggle("active", isTarget);
      tab.setAttribute("aria-selected", isTarget);
    }
    if (pane) {
      if (isTarget) {
        setTimeout(function () { pane.classList.add("active"); }, 10);
        pane.style.display = "block";
      } else {
        pane.classList.remove("active");
        setTimeout(function () { if (!pane.classList.contains("active")) pane.style.display = "none"; }, 300);
      }
    }
  });

  if (name === "fill") {
    var savedVals = getVals();
    renderFill();
    populateFillValues(savedVals);
    refreshURL();
  }
  if (name === "view") renderView();
}


// --- builder ---

function renderBuilder() {
  var list = document.getElementById("fields-list");
  list.innerHTML = "";

  fields.forEach(function (f, i) {
    var opts = FIELD_TYPES.map(function (t) {
      return "<option value='" + t + "'" + (f.type === t ? " selected" : "") + ">" + t + "</option>";
    }).join("");

    var trimmed    = f.label.trim();
    var isDupe     = trimmed !== "" && fields.some(function (g, j) {
      return j !== i && g.label.trim() === trimmed;
    });
    var isInvalid  = !trimmed || isDupe;
    var inputClass = isInvalid ? " class='error'" : "";
    var placeholder = !trimmed ? "Field label (required)" : isDupe ? "Duplicate label" : "Field label";

    var row = document.createElement("div");
    row.className = "frow";
    row.innerHTML =
        "<input type='text'" + inputClass + " value='" + esc(f.label) + "' placeholder='" + placeholder + "' oninput='updateFieldLabel(" + i + ", this.value)'>"
      + "<select onchange='updateFieldType(" + i + ", this.value)' aria-label='Field type'>" + opts + "</select>"
      + "<button class='delbtn' onclick='removeField(" + i + ")' aria-label='Remove field'>"
      + "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>"
      + "<path d='M3 6h18'></path><path d='M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'></path>"
      + "<path d='M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'></path>"
      + "<line x1='10' y1='11' x2='10' y2='17'></line><line x1='14' y1='11' x2='14' y2='17'></line>"
      + "</svg></button>";
    list.appendChild(row);
  });
}

function updateFieldLabel(i, val) {
  fields[i].label = val;
  var inputs  = document.querySelectorAll("#fields-list .frow input[type='text']");
  if (inputs[i]) {
    var trimmed = val.trim();
    var isDupe  = trimmed !== "" && fields.some(function (f, j) {
      return j !== i && f.label.trim() === trimmed;
    });
    inputs[i].classList.toggle("error", !trimmed || isDupe);
  }
}

function updateFieldType(i, val) { fields[i].type = val; }

function addField()     { fields.push({ label: "", type: "text" }); renderBuilder(); }
function removeField(i) { fields.splice(i, 1); renderBuilder(); }


// --- fill ---

function renderFill() {
  // Surface empty-label and duplicate-label errors in the builder before rendering fill UI.
  var hasInvalid = fields.some(function (f, i) {
    if (!f.label.trim()) return true;
    return fields.some(function (g, j) { return j !== i && g.label.trim() === f.label.trim(); });
  });
  if (hasInvalid) renderBuilder();

  var seen        = {};
  var html        = "";
  var validFields = 0;

  fields.forEach(function (f, i) {
    var trimmed = f.label.trim();
    if (!trimmed || seen[trimmed]) return; // skip empty labels and duplicate labels
    seen[trimmed] = true;
    validFields++;
    var id  = "fill-" + i + "-" + slug(trimmed);
    var inp = f.type === "textarea"
      ? "<textarea id='" + id + "' rows='4' placeholder='Enter " + esc(trimmed.toLowerCase()) + "\u2026' oninput='refreshURL()'></textarea>"
      : "<input type='" + f.type + "' id='" + id + "' placeholder='Enter " + esc(trimmed.toLowerCase()) + "\u2026' oninput='refreshURL()'>";
    html += "<div class='fg'><label class='fl' for='" + id + "'>" + esc(trimmed) + "</label>" + inp + "</div>";
  });

  if (validFields === 0) {
    document.getElementById("fill-form").innerHTML =
        "<div class='empty-state'>"
      + "<div class='empty-icon'><svg width='32' height='32' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'>"
      + "<polygon points='12 2 2 22 22 22 12 2'></polygon>"
      + "<line x1='12' y1='8' x2='12' y2='14'></line><line x1='12' y1='18' x2='12.01' y2='18'></line>"
      + "</svg></div>"
      + "<h3 class='empty-title'>No fields yet</h3>"
      + "<p class='empty-desc'>Go back to the Create tab to add fields to your form.</p>"
      + "<button class='btn btn-w' onclick='setTab(null, \"build\")'>Go to Create</button>"
      + "</div>";
  } else {
    document.getElementById("fill-form").innerHTML = html;
  }
}

// populateFillValues: sets input/textarea values from a {label: value} map.
// Separated from renderFill() so it can be called independently without rebuilding the DOM.
function populateFillValues(values) {
  if (!values) return;
  fields.forEach(function (f, i) {
    if (!f.label.trim()) return;
    var el = document.getElementById("fill-" + i + "-" + slug(f.label));
    if (el) el.value = values[f.label] || "";
  });
}

function getVals() {
  var v = {};
  fields.forEach(function (f, i) {
    if (!f.label.trim()) return;
    var el = document.getElementById("fill-" + i + "-" + slug(f.label));
    if (el) v[f.label] = el.value;
  });
  return v;
}


// --- URL ---

function buildData() {
  var validFields = fields.filter(function (f) { return f.label.trim(); });
  return {
    title:  document.getElementById("form-title").value.trim() || "Untitled form",
    fields: validFields.map(function (f) { return { label: f.label, type: f.type }; }),
    values: getVals()
  };
}

async function buildURL(d) {
  var bytes  = stringToUint8Array(serialize(d));
  var tagged = await compressBytes(bytes);
  return location.href.split("#")[0] + "#v2=" + bytesToBase64Url(tagged);
}

async function refreshURL() {
  var seq = ++refreshSeq;
  try {
    var d   = buildData();
    var url = await buildURL(d);
    if (seq !== refreshSeq) return; // a later call is already in flight; discard this result
    var el = document.getElementById("gen-url");
    if (el) el.textContent = url;
    history.replaceState(null, "", url);
  } catch (e) {}
}


// --- clipboard / share ---

async function copyLink() {
  try {
    writeClipboard(await buildURL(buildData()), "Link copied to clipboard!");
  } catch (e) {}
}

function copyJSON() {
  if (!shared || !shared.values) return;
  writeClipboard(JSON.stringify(shared.values, null, 2), "Data copied as JSON!");
}

function copyText() {
  if (!shared || !shared.fields || !shared.values) return;
  var text = shared.fields.map(function (f) {
    return f.label + ": " + (shared.values[f.label] || "");
  }).join("\n");
  writeClipboard(text, "Data copied as text!");
}

async function shareNative() {
  try {
    var d   = buildData();
    var url = await buildURL(d);
    if (navigator.share) {
      navigator.share({ title: d.title, url: url }).catch(function () {});
    } else {
      writeClipboard(url, "Link copied to clipboard!");
    }
  } catch (e) {}
}


// --- view ---

function renderView() {
  var loaded = document.getElementById("view-loaded");
  var empty  = document.getElementById("view-empty");

  if (!shared || !shared.fields || shared.fields.length === 0) {
    loaded.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  var html = "<div class='vwrap'><div class='vtitle'>" + esc(shared.title || "Untitled form") + "</div>";

  shared.fields.forEach(function (f, i) {
    var val = (shared.values && shared.values[f.label]) || "";
    var id  = "view-" + i + "-" + slug(f.label);
    var inp = f.type === "textarea"
      ? "<textarea id='" + id + "' rows='4' readonly>" + esc(val) + "</textarea>"
      : "<input type='" + f.type + "' id='" + id + "' value='" + esc(val) + "' readonly>";
    html += "<div class='vfield'><label class='fl' for='" + id + "'>" + esc(f.label) + "</label>" + inp + "</div>";
  });

  html +=
      "</div><div class='brow'>"
    + "<button class='btn btn-w btn-s' onclick='copyText()'>"
    + "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>"
    + "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'></path>"
    + "<polyline points='14 2 14 8 20 8'></polyline>"
    + "<line x1='16' y1='13' x2='8' y2='13'></line><line x1='16' y1='17' x2='8' y2='17'></line>"
    + "<polyline points='10 9 9 9 8 9'></polyline>"
    + "</svg>Copy Text</button>"
    + "<button class='btn btn-w btn-s' onclick='copyJSON()'>"
    + "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>"
    + "<rect x='9' y='9' width='13' height='13' rx='2' ry='2'></rect>"
    + "<path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'></path>"
    + "</svg>Copy JSON</button>"
    + "<button class='btn btn-w btn-p' onclick='editShared()'>"
    + "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>"
    + "<path d='M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'></path>"
    + "<path d='M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'></path>"
    + "</svg>Edit &amp; Reshare</button></div>";

  loaded.innerHTML = html;
}


// --- edit shared ---

function editShared() {
  if (!shared) return;
  fields = (shared.fields || []).map(function (f) { return { label: f.label, type: f.type }; });
  document.getElementById("form-title").value = shared.title || "";
  renderBuilder();
  setTab(null, "fill");
  populateFillValues(shared.values);
  refreshURL();
}


// --- boot ---

async function boot() {
  renderBuilder();
  
  // Initialize tabs
  setTab(null, "fill");
  
  var href = location.href;
  var idx  = href.indexOf("#v2=");
  if (idx !== -1) {
    try {
      var tagged = base64UrlToBytes(href.slice(idx + 4));
      var bytes  = await decompressBytes(tagged);
      shared     = deserialize(uint8ArrayToString(bytes));
      document.getElementById("banner").classList.add("show");
      setTab(null, "view");
    } catch (e) {
      setTab(null, "fill");
    }
  } else {
    setTab(null, "fill");
  }
}

document.addEventListener("DOMContentLoaded", boot);