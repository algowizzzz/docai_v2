/* Standardize plugin — applies the admin-governed document standard:
 * styles, header/footer, metadata table (first section), version history table.
 * Config from GET /api/standard; versions from GET /api/versions/:docId
 * (docId derived from the editor's document key: "<id>_v<n>_<hash>").
 */
(function (window) {

  var CFG = null;

  window.Asc.plugin.init = function () { load(); };
  window.Asc.plugin.button = function () { this.executeCommand("close", ""); };

  function docIdFromKey() {
    var key = (window.Asc.plugin.info && (window.Asc.plugin.info.documentId || window.Asc.plugin.info.recalculateOnOpen)) || "";
    if (typeof key !== "string") key = "";
    return key.split("_v")[0] || null;
  }

  function load() {
    fetch("/api/standard")
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        CFG = cfg;
        var rows = [
          "<div class='item'><b>Body</b> — " + cfg.body.font + " " + cfg.body.sizePt + "pt</div>",
          "<div class='item'><b>Headings</b> — H1 " + cfg.h1.sizePt + " / H2 " + cfg.h2.sizePt + " / H3 " + cfg.h3.sizePt + "pt, brand colors</div>",
          "<div class='item'><b>Header</b> — " + (cfg.headerText || "—").replace("{filename}", "document file name") + "</div>",
          "<div class='item'><b>Footer</b> — " + (cfg.footerPageNumber ? "page number, centred" : "—") + "</div>",
          "<div class='item'><b>Metadata table</b> — " + (cfg.metadataTable ? cfg.metadataFields.length + " fields, first section" : "off") + "</div>",
          "<div class='item'><b>Version history table</b> — " + (cfg.versionTable ? "one row per version" : "off") + "</div>"
        ];
        document.getElementById("list").innerHTML = rows.join("");
      })
      .catch(function () {
        document.getElementById("list").innerHTML = "<div class='item'>Standard unavailable</div>";
      });
  }

  function note(kind, text) {
    var d = document.createElement("div");
    d.className = kind;
    d.textContent = text;
    var out = document.getElementById("out");
    out.appendChild(d); out.scrollTop = out.scrollHeight;
    return d;
  }

  document.getElementById("apply").onclick = function () {
    if (!CFG) return;
    var btn = this;
    btn.disabled = true;
    var pending = note("sys", "Applying standard…");

    var docId = docIdFromKey();
    var versionsP = (CFG.versionTable && docId)
      ? fetch("/api/versions/" + docId).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
      : Promise.resolve([]);

    versionsP.then(function (versions) {
      Asc.scope.cfg = CFG;
      Asc.scope.docname = (window.Asc.plugin.info && window.Asc.plugin.info.documentTitle) || "Document";
      Asc.scope.versions = (versions || []).slice().reverse().map(function (v) {
        return {
          name: "v" + v.v + (v.original ? " (original upload)" : (v.current ? " (current)" : "")),
          date: new Date(v.date).toISOString().slice(0, 10)
        };
      });

      window.Asc.plugin.callCommand(function () {
        var log = [];
        function hex(c) { return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)]; }
        try {
          var cfg = Asc.scope.cfg;
          var doc = Api.GetDocument();

          // ---- 1. styles ----
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

          // ---- 2. header / footer ----
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

          // ---- helpers for tables ----
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
          function captionPara(text) {
            var p = Api.CreateParagraph();
            var r = Api.CreateRun(); r.AddText(text);
            var pr = r.GetTextPr();
            pr.SetBold(true); pr.SetFontSize(cfg.h2.sizePt * 2);
            var c = hex(cfg.h2.color); pr.SetColor(c[0], c[1], c[2]);
            pr.SetFontFamily(cfg.body.font);
            p.AddElement(r);
            return p;
          }

          var insertAt = 0;
          function addTop(el) {
            try { doc.AddElement(insertAt, el); insertAt++; }
            catch (e) { try { doc.Push(el); } catch (e2) {} }
          }

          // ---- 3. metadata table: 4 rows x 4 cols, two label/value pairs per row ----
          if (cfg.metadataTable && cfg.metadataFields && cfg.metadataFields.length) {
            addTop(captionPara("Document Information"));
            var fields = cfg.metadataFields.slice(0, 8);
            while (fields.length < 8) fields.push("");
            var mt = brandTable(4, 4);
            for (var row = 0; row < 4; row++) {
              var tr = mt.GetRow(row);
              var left = fields[row * 2], right = fields[row * 2 + 1];
              fillCell(tr.GetCell(0), left, true, true);
              fillCell(tr.GetCell(1), "", false, false);
              fillCell(tr.GetCell(2), right, true, true);
              fillCell(tr.GetCell(3), "", false, false);
            }
            addTop(mt);
            log.push("metadata-table");
          }

          // ---- 4. version history table: header + one row per version ----
          var versions = Asc.scope.versions || [];
          if (cfg.versionTable && versions.length) {
            addTop(captionPara("Version History"));
            var vt = brandTable(2, versions.length + 1);
            fillCell(vt.GetRow(0).GetCell(0), "Version", true, true);
            fillCell(vt.GetRow(0).GetCell(1), "Date", true, true);
            for (var i = 0; i < versions.length; i++) {
              fillCell(vt.GetRow(i + 1).GetCell(0), versions[i].name, false, false);
              fillCell(vt.GetRow(i + 1).GetCell(1), versions[i].date, false, false);
            }
            addTop(vt);
            log.push("version-table(" + versions.length + ")");
          }
          if (insertAt > 0) addTop(Api.CreateParagraph());

          return "OK: " + log.join(", ");
        } catch (e) {
          return "ERROR: " + e.message;
        }
      }, false, true, function (r) {
        pending.remove();
        if (String(r).indexOf("ERROR") === 0) note("sys", "Could not apply: " + r);
        else note("msg", "Standard applied: " + String(r).slice(4) + ". Review the document — the previous state is in version history.");
        btn.disabled = false;
      });
    });
  };
})(window);
