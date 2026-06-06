var fields = [{ label: "Name", type: "text" }, { label: "Email", type: "email" }, { label: "Message", type: "textarea" }];
var shared = null;

function slug(s) { return s.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, ""); }
// properly escape all dangerous HTML characters, including single quotes to prevent injection
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(msg) {
  var t = document.getElementById("toast-msg");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function () { t.classList.remove("show"); }, 2500);
}

function setTab(e, name) {
  ["build", "fill", "view"].forEach(function (n) {
    var isTarget = n === name;
    var tab = document.getElementById("tab-" + n);
    var pane = document.getElementById("pane-" + n);

    tab.classList.toggle("active", isTarget);
    tab.setAttribute("aria-selected", isTarget);

    if (isTarget) {
      // slight delay for smooth transition if already rendered
      setTimeout(function () { pane.classList.add("active"); }, 10);
      pane.style.display = "block";
    } else {
      pane.classList.remove("active");
      setTimeout(function () { if (!pane.classList.contains("active")) pane.style.display = "none"; }, 300);
    }
  });

  if (name === "fill") renderFill();
  if (name === "view") renderView();
}

function renderBuilder() {
  var list = document.getElementById("fields-list");
  var types = ["text", "email", "textarea", "number", "date", "url", "tel"];
  list.innerHTML = "";

  fields.forEach(function (f, i) {
    var opts = types.map(function (t) {
      return "<option value='" + t + "'" + (f.type === t ? " selected" : "") + ">" + t + "</option>";
    }).join("");

    var isMissingLabel = f.label.trim() === "";
    var inputClass = isMissingLabel ? " class='error'" : "";
    var placeholder = isMissingLabel ? "Field label (required)" : "Field label";

    var row = document.createElement("div");
    row.className = "frow";
    row.innerHTML = "<input type='text'" + inputClass + " value='" + esc(f.label) + "' placeholder='" + placeholder + "' oninput='updateFieldLabel(" + i + ", this.value)'>"
      + "<select onchange='fields[" + i + "].type = this.value' aria-label='Field type'>" + opts + "</select>"
      + "<button class='delbtn' onclick='removeField(" + i + ")' aria-label='Remove field'><svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 6h18'></path><path d='M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'></path><path d='M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'></path><line x1='10' y1='11' x2='10' y2='17'></line><line x1='14' y1='11' x2='14' y2='17'></line></svg></button>";
    list.appendChild(row);
  });
}

function updateFieldLabel(i, val) {
  fields[i].label = val;
  // remove error class if user types
  var inputs = document.querySelectorAll("#fields-list .frow input[type='text']");
  if (inputs[i] && val.trim() !== "") {
    inputs[i].classList.remove("error");
  }
}

function addField() { fields.push({ label: "", type: "text" }); renderBuilder(); }
function removeField(i) { fields.splice(i, 1); renderBuilder(); }

function renderFill() {
  // Validate fields before proceeding (ensure they have labels)
  var hasEmpty = false;
  fields.forEach(function (f, i) {
    if (!f.label.trim()) hasEmpty = true;
  });
  if (hasEmpty) {
    renderBuilder(); // re-render to show red error borders
  }

  var html = "";
  var validFields = 0;

  fields.forEach(function (f, i) {
    if (!f.label.trim()) return;
    validFields++;
    var id = "fill-" + i + "-" + slug(f.label);
    var inp = f.type === "textarea"
      ? "<textarea id='" + id + "' rows='4' placeholder='Enter " + esc(f.label.toLowerCase()) + "…' oninput='refreshURL()'></textarea>"
      : "<input type='" + f.type + "' id='" + id + "' placeholder='Enter " + esc(f.label.toLowerCase()) + "…' oninput='refreshURL()'>";
    html += "<div class='fg'><label class='fl' for='" + id + "'>" + esc(f.label) + "</label>" + inp + "</div>";
  });

  if (validFields === 0) {
    document.getElementById("fill-form").innerHTML = "<div class='empty-state'><div class='empty-icon'><svg width='32' height='32' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><polygon points='12 2 2 22 22 22 12 2'></polygon><line x1='12' y1='8' x2='12' y2='14'></line><line x1='12' y1='18' x2='12.01' y2='18'></line></svg></div><h3 class='empty-title'>No fields yet</h3><p class='empty-desc'>Go back to the Create tab to add fields to your form.</p><button class='btn btn-w' onclick='setTab(null, \"build\")'>Go to Create</button></div>";
  } else {
    document.getElementById("fill-form").innerHTML = html;
  }

  refreshURL();
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

function buildData() {
  var validFields = fields.filter(function (f) { return f.label.trim(); });
  return {
    title: (document.getElementById("form-title").value.trim() || "Untitled form"),
    fields: validFields.map(function (f) { return { label: f.label, type: f.type }; }),
    values: getVals()
  };
}

function buildURL(d) { return location.href.split("#")[0] + "#data=" + encodeURIComponent(JSON.stringify(d)); }

function refreshURL() {
  var d = buildData();
  var url = buildURL(d);
  var el = document.getElementById("gen-url");
  if (el) el.textContent = url;
  try { history.replaceState(null, "", "#data=" + encodeURIComponent(JSON.stringify(d))); } catch (e) { }
}

function copyLink() {
  var url = buildURL(buildData());
  navigator.clipboard.writeText(url)
    .then(function () { showToast("Link copied to clipboard!"); })
    .catch(function () { prompt("Copy this link:", url); });
}

function shareNative() {
  var d = buildData();
  var url = buildURL(d);
  if (navigator.share) {
    navigator.share({ title: d.title, url: url }).catch(function () { });
  } else {
    copyLink();
  }
}

function renderView() {
  var loaded = document.getElementById("view-loaded");
  var empty = document.getElementById("view-empty");

  if (!shared || !shared.fields || shared.fields.length === 0) {
    loaded.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  var html = "<div class='vwrap'><div class='vtitle'>" + esc(shared.title || "Untitled form") + "</div>";

  shared.fields.forEach(function (f, i) {
    var val = (shared.values && shared.values[f.label]) || "";
    var id = "view-" + i + "-" + slug(f.label);
    var inp = f.type === "textarea"
      ? "<textarea id='" + id + "' rows='4' readonly>" + esc(val) + "</textarea>"
      : "<input type='" + f.type + "' id='" + id + "' value='" + esc(val) + "' readonly>";
    html += "<div class='vfield'><label class='fl' for='" + id + "'>" + esc(f.label) + "</label>" + inp + "</div>";
  });

  html += "</div><div class='brow'><button class='btn btn-w btn-p' onclick='editShared()'><svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'></path><path d='M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'></path></svg>Edit &amp; Reshare</button></div>";

  loaded.innerHTML = html;
}

function editShared() {
  if (!shared) return;
  fields = (shared.fields || []).map(function (f) { return { label: f.label, type: f.type }; });
  document.getElementById("form-title").value = shared.title || "";
  renderBuilder();
  setTab(null, "fill");

  setTimeout(function () {
    fields.forEach(function (f, i) {
      if (!f.label.trim()) return;
      var el = document.getElementById("fill-" + i + "-" + slug(f.label));
      if (el && shared.values) el.value = shared.values[f.label] || "";
    });
    refreshURL();
  }, 50);
}

function boot() {
  renderBuilder();
  var href = location.href;
  var idx = href.indexOf("#data=");
  if (idx !== -1) {
    try {
      shared = JSON.parse(decodeURIComponent(href.slice(idx + 6)));
      document.getElementById("banner").classList.add("show");
      setTab(null, "view");
    } catch (e) {
      setTab(null, "build");
    }
  } else {
    setTab(null, "build");
  }
}

// Initialize
document.addEventListener("DOMContentLoaded", boot);
