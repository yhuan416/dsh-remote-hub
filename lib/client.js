window.__ModuleLoader__.load({
  id: "dsh-remote-hub",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;
    var PANEL_ID = "remote-hub";
    var OWNER = "dsh-remote-hub";

    function post(path, body) {
      return fetch("/api/remote-hosts/" + path, body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (response) { return response.json(); });
    }

    var styles = {
      wrap: { display: "flex", flexDirection: "column", gap: "10px", padding: "4px 0" },
      title: { margin: "0", fontSize: "14px", fontWeight: "600", color: "var(--dsw-alias-label-primary, inherit)" },
      table: { width: "100%", borderCollapse: "collapse", fontSize: "12.5px" },
      th: { textAlign: "left", padding: "6px 8px", color: "var(--dsw-alias-label-secondary, #888)", fontWeight: "400", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))" },
      td: { padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))", color: "var(--dsw-alias-label-primary, inherit)" },
      muted: { color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "11.5px" },
      dot: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", marginRight: "6px", background: "#8a8a8a" },
      button: { padding: "3px 9px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", marginRight: "6px" },
      form: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
      input: { background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "6px", padding: "4px 8px", font: "inherit" },
      msg: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)", minHeight: "16px" }
    };

    function dotStyle(state) {
      var color = state === "online" ? "#37b24d" : state === "pending" ? "#f59f0b" : state === "offline" ? "#e03131" : "#8a8a8a";
      return Object.assign({}, styles.dot, { background: color });
    }

    function matches(subject) {
      if (!subject) return false;
      if (subject.kind === "bundle") return !!(subject.pkg && subject.pkg.name === OWNER);
      if (subject.kind === "row") return !!((subject.pkg && subject.pkg.name === OWNER) || (subject.row && subject.row.rowId === PANEL_ID));
      if (subject.kind === "item") return subject.id === PANEL_ID;
      return false;
    }

    function RemotePanel() {
      var listState = React.useState([]);
      var rows = listState[0];
      var setRows = listState[1];
      var msgState = React.useState("");
      var msg = msgState[0];
      var setMsg = msgState[1];
      var formState = React.useState({ label: "", host: "", user: "", port: "3080" });
      var form = formState[0];
      var setForm = formState[1];

      function load() {
        return post("list").then(function (response) {
          setRows(Array.isArray(response.remotes) ? response.remotes : []);
        }).catch(function (error) { setMsg("加载失败：" + error.message); });
      }

      React.useEffect(function () {
        load();
        var timer = setInterval(load, 5000);
        return function () { clearInterval(timer); };
      }, []);

      function update(field, value) {
        var next = Object.assign({}, form);
        next[field] = value;
        setForm(next);
      }

      function save() {
        var label = form.label.trim();
        var id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "remote";
        post("save", {
          id: id,
          label: label || id,
          transport: "ssh",
          ssh: { host: form.host.trim(), user: form.user.trim() || undefined },
          remotePort: Number(form.port) || 3080,
          tokenMode: "ssh"
        }).then(function (response) {
          if (response.ok) {
            setMsg("已添加：" + response.id);
            setForm({ label: "", host: "", user: "", port: "3080" });
            load();
          } else {
            setMsg("失败：" + response.error);
          }
        }).catch(function (error) { setMsg("失败：" + error.message); });
      }

      function remove(id) {
        if (!window.confirm("删除远端 " + id + " ?")) return;
        post("remove", { id: id }).then(function () { setMsg("已删除：" + id); load(); });
      }

      function probe(id) {
        setMsg("测试中…");
        post("probe", { id: id }).then(function (result) { setMsg(id + ": " + JSON.stringify(result.result || result)); load(); });
      }

      function cells(row) {
        return [
          h("td", { key: "s", style: styles.td },
            h("span", { style: dotStyle(row.state), title: row.lastError || row.state || "" }),
            row.tunnel ? row.tunnel.state : row.transport),
          h("td", { key: "l", style: styles.td }, row.label, h("div", { style: styles.muted }, row.id)),
          h("td", { key: "t", style: styles.td },
            row.transport === "ssh-tunnel"
              ? "ssh " + ((row.ssh && row.ssh.host) || "") + " -> :" + row.remotePort
              : "direct " + (row.upstream || "")),
          h("td", { key: "k", style: styles.td }, row.tokenSource || "-"),
          h("td", { key: "p", style: styles.td }, row.latencyMs === null || row.latencyMs === undefined ? "-" : row.latencyMs + "ms"),
          h("td", { key: "a", style: styles.td },
            h("button", { style: styles.button, onClick: function () { window.location.href = "/remotes/" + row.id + "/"; } }, "打开"),
            h("button", { style: styles.button, onClick: function () { probe(row.id); } }, "测试"),
            h("button", { style: styles.button, onClick: function () { remove(row.id); } }, "删除"))
        ];
      }

      return h("section", { style: styles.wrap },
        h("h4", { style: styles.title }, "远端链路"),
        h("table", { style: styles.table },
          h("thead", null, h("tr", null, ["状态", "名称", "传输", "token", "延迟", "操作"].map(function (label) {
            return h("th", { key: label, style: styles.th }, label);
          }))),
          h("tbody", null, rows.map(function (row) { return h("tr", { key: row.id }, cells(row)); }))),
        h("div", { style: styles.form },
          h("input", { style: styles.input, placeholder: "显示名称", value: form.label, onChange: function (event) { update("label", event.target.value); } }),
          h("input", { style: styles.input, placeholder: "ssh 主机", value: form.host, onChange: function (event) { update("host", event.target.value); } }),
          h("input", { style: styles.input, placeholder: "ssh 用户（可选）", value: form.user, onChange: function (event) { update("user", event.target.value); } }),
          h("input", { style: Object.assign({}, styles.input, { width: "76px" }), placeholder: "3080", value: form.port, onChange: function (event) { update("port", event.target.value); } }),
          h("button", { style: styles.button, onClick: save }, "添加远端")),
        h("div", { style: styles.msg }, msg));
    }

    function RemoteSection(props) {
      if (!matches(props && props.subject)) return null;
      return h(RemotePanel, null);
    }

    function apply(ctx) {
      try {
        ctx.effect(function () {
          return ctx.slots.inject("plugins.detail.section", function () {
            return ctx.slots.register({
              name: "plugins.detail.section",
              id: PANEL_ID,
              order: 60,
              label: "远端链路"
            }, RemoteSection);
          });
        }, "remote-hub: plugins detail section");
      } catch (error) {
        console.warn("[dsh-remote-hub] client section registration failed", error);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "remote-hub-client";
    return module.exports;
  }
});
