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

  // ---------- standardize pane (admin-governed standard) ----------
  var STDCFG = null;
  var stdout2 = document.getElementById("stdout");

  function stdNote(kind, text) {
    var d = document.createElement("div");
    d.className = kind === "sys" ? "sys" : "msg ai";
    d.textContent = text;
    stdout2.appendChild(d); stdout2.scrollTop = stdout2.scrollHeight;
    return d;
  }

  function loadStandard() {
    fetch("/api/standard")
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        STDCFG = cfg;
        document.getElementById("stdlist").innerHTML = [
          "<div class='stditem2'><b>Body</b> — " + cfg.body.font + " " + cfg.body.sizePt + "pt</div>",
          "<div class='stditem2'><b>Headings</b> — H1 " + cfg.h1.sizePt + " / H2 " + cfg.h2.sizePt + " / H3 " + cfg.h3.sizePt + "pt, brand colors</div>",
          "<div class='stditem2'><b>Header</b> — " + (cfg.headerText || "—").replace("{filename}", "document file name") + "</div>",
          "<div class='stditem2'><b>Footer</b> — " + (cfg.footerPageNumber ? "page number, centred" : "—") + "</div>"
        ].join("");
      })
      .catch(function () {
        document.getElementById("stdlist").innerHTML = "<div class='stditem2'>Standard unavailable</div>";
      });
  }
  loadStandard();
  document.querySelector('.tab[data-pane="std"]').addEventListener("click", loadStandard);

  function stdDocId() {
    var key = (window.Asc.plugin.info && window.Asc.plugin.info.documentId) || "";
    if (typeof key !== "string") key = "";
    return key.split("_v")[0] || null;
  }

  function stdRun(btn, pendingText, prep, command, doneText) {
    if (!STDCFG) return;
    btn.disabled = true;
    var pending = stdNote("sys", pendingText);
    prep().then(function () {
      Asc.scope.cfg = STDCFG;
      window.Asc.plugin.callCommand(command, false, true, function (r) {
        pending.remove();
        if (String(r).indexOf("ERROR") === 0) stdNote("sys", "Could not apply: " + r);
        else stdNote("msg", doneText);
        btn.disabled = false;
      });
    });
  }

  document.getElementById("stdapply").onclick = function () {
    Asc.scope.docname = (window.Asc.plugin.info && window.Asc.plugin.info.documentTitle) || "Document";
    stdRun(this, "Applying standard…", function () { return Promise.resolve(); }, function () {
      var log = [];
      function hex(c) { return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)]; }
      try {
        var cfg = Asc.scope.cfg;
        var doc = Api.GetDocument();
        function styleText(name, font, sizePt, colorHex, bold) {
          try {
            var st = doc.GetStyle(name);
            if (!st) return;
            var pr = st.GetTextPr();
            pr.SetFontFamily(font);
            pr.SetFontSize(sizePt * 2);
            var c = hex(colorHex);
            pr.SetColor(c[0], c[1], c[2]);
            if (bold !== undefined) pr.SetBold(!!bold);
            log.push(name);
          } catch (e) { log.push(name + "!"); }
        }
        styleText("Normal", cfg.body.font, cfg.body.sizePt, cfg.body.color);
        styleText("Heading 1", cfg.body.font, cfg.h1.sizePt, cfg.h1.color, cfg.h1.bold);
        styleText("Heading 2", cfg.body.font, cfg.h2.sizePt, cfg.h2.color, cfg.h2.bold);
        styleText("Heading 3", cfg.body.font, cfg.h3.sizePt, cfg.h3.color, cfg.h3.bold);
        var section = doc.GetFinalSection();
        if (cfg.headerText) {
          var header = section.GetHeader("default", true);
          header.RemoveAllElements();
          var hp = Api.CreateParagraph();
          hp.SetJc("right");
          var hr = Api.CreateRun();
          hr.AddText(cfg.headerText.replace("{filename}", Asc.scope.docname));
          var hpr = hr.GetTextPr(); hpr.SetFontSize(18); hpr.SetColor(110,110,115); hpr.SetFontFamily(cfg.body.font);
          hp.AddElement(hr);
          header.Push(hp);
          log.push("header");
        }
        if (cfg.footerPageNumber) {
          var footer = section.GetFooter("default", true);
          footer.RemoveAllElements();
          var fp = Api.CreateParagraph();
          fp.SetJc("center");
          try { fp.AddPageNumber(); } catch (e) { var fr = Api.CreateRun(); fr.AddText(" "); fp.AddElement(fr); }
          footer.Push(fp);
          log.push("footer");
        }

        // ---- enforcement pass: direct (run-level) formatting beats styles in
        // Word, so force the standard onto heading/title paragraphs and
        // normalize the body font everywhere, tables included.
        var forced = 0;
        function forceRange(rg, font, sizePt, colorHex, bold) {
          try { rg.SetFontFamily(font); } catch (e) {}
          if (sizePt) { try { rg.SetFontSize(sizePt * 2); } catch (e) {} }
          if (colorHex) {
            var c = hex(colorHex);
            try { rg.SetColor(c[0], c[1], c[2]); }
            catch (e) { try { rg.SetColor(Api.CreateColorFromRGB(c[0], c[1], c[2])); } catch (e2) {} }
          }
          if (bold !== undefined) { try { rg.SetBold(!!bold); } catch (e) {} }
        }
        function forcePara(p) {
          var sName = "";
          try { var st = p.GetStyle(); sName = st ? String(st.GetName()) : ""; } catch (e) {}
          var rg;
          try { rg = p.GetRange(); } catch (e) { return; }
          if (!rg) return;
          if (/^(heading\s*1|title)/i.test(sName)) { forceRange(rg, cfg.body.font, cfg.h1.sizePt, cfg.h1.color, cfg.h1.bold); forced++; }
          else if (/^heading\s*2/i.test(sName)) { forceRange(rg, cfg.body.font, cfg.h2.sizePt, cfg.h2.color, cfg.h2.bold); forced++; }
          else if (/^heading\s*3/i.test(sName)) { forceRange(rg, cfg.body.font, cfg.h3.sizePt, cfg.h3.color, cfg.h3.bold); forced++; }
          else {
            // no style semantics (common in generated docs): infer headings
            // from font size on short paragraphs, then assign the REAL style
            var sizeHalf = 0, txtLen = 0;
            try { txtLen = String(p.GetText() || "").trim().length; } catch (e) {}
            try {
              var r0 = p.GetElement(0);
              if (r0 && r0.GetClassType && r0.GetClassType() === "run") {
                var tp0 = r0.GetTextPr();
                if (tp0 && tp0.GetFontSize) sizeHalf = tp0.GetFontSize() || 0;
              }
            } catch (e) {}
            var h = null;
            if (txtLen > 0 && txtLen < 120) {
              if (sizeHalf >= 40) h = cfg.h1;
              else if (sizeHalf >= 30) h = cfg.h2;
              else if (sizeHalf >= 26) h = cfg.h3;
            }
            if (h) {
              try { p.SetStyle(doc.GetStyle(h === cfg.h1 ? "Heading 1" : h === cfg.h2 ? "Heading 2" : "Heading 3")); } catch (e) {}
              forceRange(rg, cfg.body.font, h.sizePt, h.color, h.bold);
              forced++;
            } else {
              forceRange(rg, cfg.body.font);
            }
          }
        }
        function walk(el) {
          try {
            var t = el.GetClassType ? el.GetClassType() : "";
            if (t === "paragraph") forcePara(el);
            else if (t === "table") {
              for (var r2 = 0; r2 < el.GetRowsCount(); r2++) {
                var row = el.GetRow(r2);
                for (var c2 = 0; c2 < row.GetCellsCount(); c2++) {
                  var content = row.GetCell(c2).GetContent();
                  for (var k = 0; k < content.GetElementsCount(); k++) walk(content.GetElement(k));
                }
              }
            }
          } catch (e) {}
        }
        for (var i2 = 0; i2 < doc.GetElementsCount(); i2++) walk(doc.GetElement(i2));
        log.push("enforced(" + forced + " headings)");

        return "OK: " + log.join(", ");
      } catch (e) { return "ERROR: " + e.message; }
    }, "Standard formatting applied — styles enforced across the document (including direct formatting on headings), header and footer set. Previous state is in version history.");
  };

  function stdTableCommand() {
    function hex(c) { return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)]; }
    try {
      var cfg = Asc.scope.cfg;
      var doc = Api.GetDocument();
      function fillCell(cell, text, bold, shade) {
        var content = cell.GetContent();
        var p = content.GetElement(0) || Api.CreateParagraph();
        p.RemoveAllElements();
        var r = Api.CreateRun();
        r.AddText(text || "");
        var pr = r.GetTextPr();
        pr.SetFontFamily(cfg.body.font); pr.SetFontSize(20);
        if (bold) pr.SetBold(true);
        p.AddElement(r);
        if (!content.GetElement(0)) content.Push(p);
        if (shade) { try { cell.SetBackgroundColor(232, 240, 247, false); } catch (e) {} }
      }
      function brandTable(cols, rows) {
        var t = Api.CreateTable(cols, rows);
        try { t.SetWidth("percent", 100); } catch (e) {}
        var b = hex("AEB6BD");
        ["Top","Bottom","Left","Right","InsideH","InsideV"].forEach(function (side) {
          try { t["SetTableBorder" + side]("single", 4, 0, b[0], b[1], b[2]); } catch (e) {}
        });
        return t;
      }
      var t;
      if (Asc.scope.tableKind === "meta") {
        var fields = (cfg.metadataFields || []).slice(0, 8);
        while (fields.length < 8) fields.push("");
        t = brandTable(4, 4);
        for (var row = 0; row < 4; row++) {
          var tr = t.GetRow(row);
          fillCell(tr.GetCell(0), fields[row * 2], true, true);
          fillCell(tr.GetCell(1), "", false, false);
          fillCell(tr.GetCell(2), fields[row * 2 + 1], true, true);
          fillCell(tr.GetCell(3), "", false, false);
        }
      } else {
        var versions = Asc.scope.versions || [];
        t = brandTable(2, versions.length + 1);
        fillCell(t.GetRow(0).GetCell(0), "Version", true, true);
        fillCell(t.GetRow(0).GetCell(1), "Date", true, true);
        for (var i = 0; i < versions.length; i++) {
          fillCell(t.GetRow(i + 1).GetCell(0), versions[i].name, false, false);
          fillCell(t.GetRow(i + 1).GetCell(1), versions[i].date, false, false);
        }
      }
      doc.InsertContent([t]); // at cursor
      return "OK: inserted";
    } catch (e) { return "ERROR: " + e.message; }
  }

  document.getElementById("insmeta").onclick = function () {
    Asc.scope.tableKind = "meta";
    stdRun(this, "Inserting metadata table…", function () { return Promise.resolve(); },
        stdTableCommand, "Metadata table inserted at the cursor.");
  };

  document.getElementById("insvers").onclick = function () {
    var docId = stdDocId();
    stdRun(this, "Inserting version history…", function () {
      return (docId
        ? fetch("/api/versions/" + docId).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
        : Promise.resolve([])
      ).then(function (versions) {
        Asc.scope.tableKind = "versions";
        Asc.scope.versions = (versions || []).slice().reverse().map(function (v) {
          return {
            name: "v" + v.v + (v.original ? " (original upload)" : (v.current ? " (current)" : "")),
            date: new Date(v.date).toISOString().slice(0, 10)
          };
        });
      });
    }, stdTableCommand, "Version history table inserted at the cursor.");
  };
})(window);
