/* AI Assistant panel — two tabs, three worker contracts.
 *
 *   Chat / Knowledge base : POST /api/worker/knowledge   {question}
 *   Chat / This document  : POST /api/worker/chat        {question, context, scope}
 *                           context = highlighted selection or full doc text
 *   Prompt chain          : GET  /api/worker/promptchain/options -> {docTypes:[...]}
 *                           POST /api/worker/promptchain {docType, document}
 *
 * All endpoints are same-origin mocks in server.js; swap their bodies for the
 * real worker API calls — the panel needs no changes.
 */
(function (window) {

  window.Asc.plugin.init = function () {};
  window.Asc.plugin.button = function () { this.executeCommand("close", ""); };

  // ---------- editor helpers ----------
  function getSelection(cb) {
    window.Asc.plugin.executeMethod("GetSelectedText", [{ Numbering: false, Math: false }], function (t) {
      cb(t || "");
    });
  }
  function getWholeDoc(cb) {
    window.Asc.plugin.callCommand(function () {
      // Walk paragraphs AND tables (incl. nested) — tables carry most of the
      // substance in governance docs, GetText() alone misses them entirely.
      function grab(el, out) {
        try {
          var t = el.GetClassType ? el.GetClassType() : "";
          if (t === "paragraph") {
            var s = el.GetText();
            if (s && s.trim()) out.push(s);
          } else if (t === "table") {
            for (var r = 0; r < el.GetRowsCount(); r++) {
              var row = el.GetRow(r);
              var cells = [];
              for (var c = 0; c < row.GetCellsCount(); c++) {
                var inner = [];
                var content = row.GetCell(c).GetContent();
                for (var k = 0; k < content.GetElementsCount(); k++) {
                  grab(content.GetElement(k), inner);
                }
                cells.push(inner.join(" "));
              }
              out.push(cells.join(" | "));
            }
          }
        } catch (e) {}
      }
      var doc = Api.GetDocument();
      var out = [];
      for (var i = 0; i < doc.GetElementsCount(); i++) grab(doc.GetElement(i), out);
      return out.join("\n");
    }, false, false, function (text) { cb(text || ""); });
  }
  // ---------- markdown rendering (safe: escape first, then transform) ----------
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }
  function renderMd(text) {
    var lines = esc(text || "").split("\n");
    var html = [], list = null; // list: "ul" | "ol" | null
    function closeList() { if (list) { html.push("</" + list + ">"); list = null; } }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var m;
      if ((m = l.match(/^(#{1,6})\s+(.*)/))) {
        closeList();
        var lvl = Math.min(m[1].length, 4);
        html.push("<h" + lvl + ">" + inlineMd(m[2]) + "</h" + lvl + ">");
      } else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) {
        if (list !== "ul") { closeList(); html.push("<ul>"); list = "ul"; }
        html.push("<li>" + inlineMd(m[1]) + "</li>");
      } else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) {
        if (list !== "ol") { closeList(); html.push("<ol>"); list = "ol"; }
        html.push("<li>" + inlineMd(m[1]) + "</li>");
      } else if (/^\s*-{3,}\s*$/.test(l)) {
        closeList(); html.push("<hr>");
      } else if (!l.trim()) {
        closeList();
      } else {
        closeList(); html.push("<p>" + inlineMd(l) + "</p>");
      }
    }
    closeList();
    return html.join("");
  }

  // ---------- shared UI helpers ----------
  function bubble(host, kind, text, markdown) {
    var d = document.createElement("div");
    d.className = kind === "sys" ? "sys" : "msg " + kind;
    if (markdown) { d.classList.add("md"); d.innerHTML = renderMd(text); }
    else d.textContent = text;
    host.appendChild(d);
    host.scrollTop = host.scrollHeight;
    return d;
  }
  function post(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
      document.querySelectorAll(".pane").forEach(function (x) { x.classList.remove("active"); });
      t.classList.add("active");
      document.getElementById("pane-" + t.dataset.pane).classList.add("active");
    };
  });

  // ---------- chat tab ----------
  var log = document.getElementById("log");

  // Live context indicator: poll the editor selection so the user can SEE
  // what will be sent before hitting Send.
  var liveSelection = "";
  setInterval(function () {
    getSelection(function (sel) {
      liveSelection = sel || "";
      var chip = document.getElementById("ctxchip");
      var prev = document.getElementById("ctxprev");
      if (liveSelection.trim()) {
        var words = liveSelection.trim().split(/\s+/).length;
        chip.textContent = "Selection · " + words + " word" + (words === 1 ? "" : "s");
        chip.className = "chip sel";
        prev.textContent = "“" + liveSelection.trim().slice(0, 60) + (liveSelection.trim().length > 60 ? "…" : "") + "”";
      } else {
        chip.textContent = "Full document";
        chip.className = "chip";
        prev.textContent = "";
      }
    });
  }, 700);

  function ask() {
    var q = document.getElementById("q").value.trim();
    if (!q) return;
    document.getElementById("q").value = "";
    bubble(log, "me", q);
    var pending = bubble(log, "sys", "thinking…");

    function done(j) {
      pending.remove();
      bubble(log, "ai", j.answer || JSON.stringify(j), true);
    }
    function fail(e) { pending.remove(); bubble(log, "sys", "API error: " + e.message); }

    function noteCtx(text) {
      var d = document.createElement("div");
      d.className = "msgctx";
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }

    // Auto context: whatever the user has highlighted; otherwise the full document.
    getSelection(function (sel) {
      if (sel.trim()) {
        var w = sel.trim().split(/\s+/).length;
        noteCtx("with selection · " + w + " word" + (w === 1 ? "" : "s"));
        post("/api/worker/chat", { question: q, context: sel, scope: "selection" }).then(done).catch(fail);
      } else {
        getWholeDoc(function (txt) {
          var w = txt.trim() ? txt.trim().split(/\s+/).length : 0;
          noteCtx("with full document · " + w + " words");
          post("/api/worker/chat", { question: q, context: txt, scope: "document" }).then(done).catch(fail);
        });
      }
    });
  }
  document.getElementById("send").onclick = ask;
  document.getElementById("q").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
  });

  // ---------- prompt chain tab ----------
  var pcout = document.getElementById("pcout");

  function loadGroups() {
    fetch("/api/promptgroups")
      .then(function (r) { return r.json(); })
      .then(function (gs) {
        var sel = document.getElementById("pgroup");
        sel.innerHTML = "";
        if (!gs.length) { sel.innerHTML = "<option value=''>No prompt groups defined</option>"; return; }
        gs.forEach(function (g) {
          var o = document.createElement("option");
          o.value = g.id;
          o.textContent = g.name + " (" + g.steps + " step" + (g.steps === 1 ? "" : "s") + (g.has_summary ? " + summary" : "") + ")";
          sel.appendChild(o);
        });
      })
      .catch(function () {
        document.getElementById("pgroup").innerHTML = "<option value=''>Groups unavailable</option>";
      });
  }
  loadGroups();
  // refresh the group list whenever the user returns to this tab
  document.querySelector('.tab[data-pane="pchain"]').addEventListener("click", loadGroups);

  function chainCard(numLabel, tag, title, answer) {
    var c = document.createElement("div");
    c.className = "card";
    var head = document.createElement("div"); head.className = "chead";
    if (numLabel) { var n = document.createElement("span"); n.className = "cnum"; n.textContent = numLabel; head.appendChild(n); }
    var t = document.createElement("span"); t.className = "ctitle"; t.textContent = title; head.appendChild(t);
    if (tag) { var g = document.createElement("span"); g.className = "ctag"; g.textContent = tag; head.appendChild(g); }
    var body = document.createElement("div"); body.className = "cbody md";
    body.innerHTML = renderMd(answer);
    c.appendChild(head); c.appendChild(body);
    pcout.appendChild(c);
  }

  document.getElementById("pcrun").onclick = function () {
    var groupId = document.getElementById("pgroup").value;
    if (!groupId) return;
    var btn = document.getElementById("pcrun");
    btn.disabled = true;
    pcout.innerHTML = "";
    document.getElementById("pcactions").style.display = "none";
    var pending = bubble(pcout, "sys", "Running analysis…");
    getWholeDoc(function (txt) {
      post("/api/worker/promptchain", { groupId: +groupId, document: txt })
        .then(function (j) {
          pending.remove();
          if (j.error) { bubble(pcout, "sys", j.error); return; }
          // summary always first (generated last, shown first)
          if (j.summary) chainCard("★", "Summary", j.summary.title, j.summary.answer);
          (j.steps || []).forEach(function (s, i) {
            chainCard(String(i + 1) + ".", null, s.title, s.answer);
          });
          if (j.runId) {
            var ex = document.getElementById("pcexport");
            ex.href = "/export/run/" + j.runId;
            document.getElementById("pcactions").style.display = "flex";
          }
          pcout.scrollTop = 0;
        })
        .catch(function (e) { pending.remove(); bubble(pcout, "sys", "API error: " + e.message); })
        .finally(function () { btn.disabled = false; });
    });
  };
})(window);
