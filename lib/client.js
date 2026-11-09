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
      msg: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)", minHeight: "16px" },
      details: { border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "8px", padding: "6px 10px", marginTop: "6px" },
      summary: { cursor: "pointer", fontSize: "12.5px", color: "var(--dsw-alias-label-primary, inherit)" },
      wsRow: { padding: "6px 0 2px 10px", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))", marginTop: "6px" },
      wsTitle: { fontSize: "12.5px", fontWeight: "600", color: "var(--dsw-alias-label-primary, inherit)" },
      sessionRow: { padding: "2px 0 2px 12px", cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" },
      sessionTitle: { color: "var(--dsw-alias-label-primary, inherit)" }
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

    function RemoteWorkspaceIcon(props) {
      var size = props !== null && typeof props === "object" && typeof props.size === "number" ? props.size : 16;
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
        strokeWidth: 1.2, "aria-hidden": "true",
      },
        h("rect", { x: 1.5, y: 3, width: 13, height: 10, rx: 2 }),
        h("path", { d: "M1.5 6.2h13" }),
        h("path", { d: "M5 9.4h6" }));
    }

    function RemoteWorkspacePage() {
      var rowsState = React.useState([]);
      var rows = rowsState[0];
      var setRows = rowsState[1];
      var selState = React.useState(null);
      var sel = selState[0];
      var setSel = selState[1];
      var frameRef = React.useRef(null);
      var loadedRemote = React.useRef("");

      function load() {
        fetch("/api/remote-hosts/workspaces", { headers: { accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (payload) { setRows(Array.isArray(payload.remotes) ? payload.remotes : []); })
          .catch(function () {});
      }
      React.useEffect(function () {
        load();
        var timer = setInterval(load, 15000);
        return function () { clearInterval(timer); };
      }, []);

      function deliver() {
        var frame = frameRef.current;
        if (!frame || !sel || !frame.contentWindow) return;
        try { frame.contentWindow.postMessage({ type: "dsh-hub-open-session", sessionId: sel.sessionId }, "*"); } catch (error) {}
      }
      function scheduleDeliver() {
        var attempts = 0;
        var timer = setInterval(function () {
          if (!sel || ++attempts > 20) { clearInterval(timer); return; }
          deliver();
        }, 400);
        deliver();
      }
      React.useEffect(function () {
        if (sel !== null && frameRef.current !== null && loadedRemote.current === sel.remoteId) scheduleDeliver();
      }, [sel === null ? "" : sel.remoteId + "/" + sel.sessionId]);

      function onFrameLoad() {
        loadedRemote.current = sel === null ? "" : sel.remoteId;
        scheduleDeliver();
      }
      function select(remoteId, sessionId) { setSel({ remoteId: remoteId, sessionId: sessionId }); }

      function createSession(remote) {
        var key = "dsh-hub-cwd:" + remote.id;
        var remembered = "";
        try { remembered = localStorage.getItem(key) || ""; } catch (error) {}
        var cwd = window.prompt("在 " + (remote.label || remote.id) + " 新建会话\n目录（留空 = 远端默认）", remembered);
        if (cwd === null) return;
        cwd = cwd.trim();
        post("session/create", cwd === "" ? { id: remote.id } : { id: remote.id, cwd: cwd }).then(function (result) {
          if (result.ok && typeof result.sessionId === "string") {
            try { if (cwd !== "") localStorage.setItem(key, cwd); } catch (error) {}
            load();
            setSel({ remoteId: remote.id, sessionId: result.sessionId });
          } else {
            window.alert("新建远端会话失败：" + (result.error || "unknown"));
          }
        }).catch(function (error) { window.alert("新建远端会话失败：" + error.message); });
      }

      function sessionRow(remote, session) {
        var active = sel !== null && sel.sessionId === session.id;
        return h("div", {
          key: session.id,
          style: Object.assign({}, styles.sessionRow, active ? { background: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.2))", borderRadius: "4px" } : {}),
          title: session.id,
          onClick: function () { select(remote.id, session.id); },
        },
          h("span", { style: styles.sessionTitle }, session.title === null || session.title === undefined ? session.id.slice(0, 30) : session.title),
          session.running ? h("span", { style: styles.muted }, " · 运行中") : null);
      }

      return h("div", { style: { display: "flex", height: "100%", minHeight: 0 } },
        h("div", {
          style: {
            width: "330px", flex: "0 0 330px", boxSizing: "border-box", overflow: "auto",
            borderRight: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", padding: "8px",
          },
        },
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" } },
            h("span", { style: styles.title }, "远端工作区"),
            h("span", { style: { flex: 1 } }),
            h("button", { style: styles.button, onClick: load }, "刷新")),
          rows.length === 0 ? h("div", { style: styles.muted }, "没有已注册的远端") : null,
          rows.map(function (remote) {
            return h("div", { key: remote.id, style: { marginBottom: "12px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: dotStyle(remote.state) }),
                h("span", { style: { fontWeight: 600, fontSize: "12.5px" } }, remote.label || remote.id),
                h("span", { style: styles.muted }, (remote.sessionCount === null || remote.sessionCount === undefined ? "?" : remote.sessionCount) + " 会话"),
                h("span", { style: { flex: 1 } }),
                h("button", { style: styles.button, onClick: function () { createSession(remote); } }, "+ 会话")),
              (remote.workspaces || []).map(function (workspace) {
                return h("div", { key: workspace.id, style: { marginTop: "6px" } },
                  h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)", wordBreak: "break-all" }, title: workspace.path || workspace.id }, workspace.path || workspace.title || workspace.id),
                  (workspace.sessions || []).map(function (session) { return sessionRow(remote, session); }));
              }),
              (remote.orphans || []).length === 0 ? null : h("div", { style: { marginTop: "6px" } },
                h("div", { style: styles.muted }, "未分组"),
                remote.orphans.map(function (session) { return sessionRow(remote, session); })),
              remote.error !== undefined ? h("div", { style: styles.muted }, remote.error) : null);
          })),
        h("div", { style: { flex: 1, minWidth: 0, position: "relative" } },
          sel === null
            ? h("div", { style: { padding: "24px", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" } }, "选择左侧远端会话，或点「+ 会话」在远端新建。")
            : h("iframe", {
                ref: frameRef,
                key: sel.remoteId,
                src: "/remotes/" + encodeURIComponent(sel.remoteId) + "/",
                onLoad: onFrameLoad,
                style: { width: "100%", height: "100%", border: "0", display: "block" },
              })));
    }

    function RemoteHeroOptions() {
      var hostsState = React.useState([]);
      var hosts = hostsState[0];
      var setHosts = hostsState[1];
      var hostState = React.useState("");
      var host = hostState[0];
      var setHost = hostState[1];
      var cwdState = React.useState("");
      var cwd = cwdState[0];
      var setCwd = cwdState[1];
      var msgState = React.useState("");
      var msg = msgState[0];
      var setMsg = msgState[1];

      React.useEffect(function () {
        fetch("/api/remote-hosts/list", { headers: { accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (payload) {
            var rows = Array.isArray(payload.remotes) ? payload.remotes : [];
            setHosts(rows);
            if (rows.length > 0) setHost(rows[0].id);
          })
          .catch(function () {});
      }, []);

      function create() {
        if (host === "") return;
        setMsg("创建中…");
        post("session/create", { id: host, cwd: cwd.trim() === "" ? undefined : cwd.trim() }).then(function (result) {
          if (result.ok && typeof result.sessionId === "string") {
            setMsg("");
            window.dispatchEvent(new CustomEvent("dsh-hub-open-session", { detail: { remoteId: host, sessionId: result.sessionId } }));
          } else {
            setMsg("创建失败：" + (result.error || "unknown"));
          }
        }).catch(function (error) { setMsg("创建失败：" + error.message); });
      }

      if (hosts.length === 0) return null;
      return h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", fontSize: "12px" } },
        h("select", { style: styles.input, value: host, onChange: function (event) { setHost(event.target.value); } },
          hosts.map(function (row) { return h("option", { key: row.id, value: row.id }, row.label || row.id); })),
        h("input", {
          style: Object.assign({}, styles.input, { width: "200px" }),
          placeholder: "远端目录（留空=默认）",
          value: cwd,
          onChange: function (event) { setCwd(event.target.value); },
        }),
        h("button", { style: styles.button, onClick: create }, "在远端新建会话"),
        msg === "" ? null : h("span", { style: styles.muted }, msg));
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
      var spacesState = React.useState([]);
      var spaces = spacesState[0];
      var setSpaces = spacesState[1];
      function loadSpaces() {
        return fetch("/api/remote-hosts/workspaces", { headers: { accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (payload) { setSpaces(Array.isArray(payload.remotes) ? payload.remotes : []); })
          .catch(function () {});
      }

      function load() {
        return post("list").then(function (response) {
          setRows(Array.isArray(response.remotes) ? response.remotes : []);
        }).catch(function (error) { setMsg("加载失败：" + error.message); });
      }

      React.useEffect(function () {
        load();
        loadSpaces();
        var timer = setInterval(load, 5000);
        var spaceTimer = setInterval(loadSpaces, 15000);
        return function () { clearInterval(timer); clearInterval(spaceTimer); };
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
            h("button", { style: styles.button, onClick: function () {
              window.dispatchEvent(new CustomEvent("dsh-hub-open-session", { detail: { remoteId: row.id } }));
            } }, "打开"),
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
        h("div", { style: styles.msg }, msg),
        h("h4", { style: styles.title }, "远端工作区"),
        spaces.length === 0
          ? h("div", { style: styles.muted }, "加载中…")
          : spaces.map(function (remote) {
            var workspaces = Array.isArray(remote.workspaces) ? remote.workspaces : [];
            var total = workspaces.reduce(function (sum, workspace) { return sum + (Array.isArray(workspace.sessions) ? workspace.sessions.length : 0); }, 0);
            return h("details", { key: remote.id, style: styles.details, open: true },
              h("summary", { style: styles.summary },
                remote.label + " — " + workspaces.length + " 个工作区 / " + total + " 个会话" +
                (remote.error === undefined ? "" : "（" + remote.error + "）") +
                (remote.storeAvailable === false ? "（按 cwd 分组）" : "")),
              workspaces.map(function (workspace) {
                return h("div", { key: workspace.id, style: styles.wsRow },
                  h("div", { style: styles.wsTitle },
                    workspace.title,
                    workspace.path === null ? null : h("span", { style: styles.muted }, "  " + workspace.path)),
                  (Array.isArray(workspace.sessions) ? workspace.sessions : []).map(function (session) {
                    return h("div", {
                      key: session.id,
                      style: styles.sessionRow,
                      title: session.id,
                      onClick: function () {
                        window.dispatchEvent(new CustomEvent("dsh-hub-open-session", { detail: { remoteId: remote.id, sessionId: session.id } }));
                      }
                    },
                      h("span", { style: styles.sessionTitle }, session.title === null || session.title === undefined ? session.id.slice(0, 28) : session.title),
                      h("span", { style: styles.muted },
                        session.updatedAt === null || session.updatedAt === undefined ? "" : "  · " + new Date(session.updatedAt).toLocaleString(),
                        session.running ? "  · 运行中" : "",
                        session.blank ? "  · 空白" : ""));
                  }));
              }));
          }),
        );
    }

    function RemoteSection(props) {
      if (!matches(props && props.subject)) return null;
      return h(RemotePanel, null);
    }

    function openSessionViaUi(ctx, sessionId) {
      var attempts = 0;
      function ack(ok) {
        try { window.parent.postMessage({ type: "dsh-hub-opened", sessionId: sessionId, ok: ok }, window.location.origin); } catch (error) {}
      }
      if (typeof sessionId !== "string" || sessionId === "") { ack(false); return; }
      function attempt() {
        var workspace = ctx.get("uiWorkspace");
        if (workspace !== undefined && typeof workspace.openSession === "function") {
          try { workspace.openSession(sessionId); ack(true); } catch (error) { ack(false); }
          return;
        }
        if (++attempts < 20) { setTimeout(attempt, 250); return; }
        ack(false);
      }
      attempt();
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
      try {
        ctx.effect(function () {
          return ctx.slots.inject("conversation.hero.options", function () {
            return ctx.slots.register({ name: "conversation.hero.options", id: PANEL_ID, order: 80 }, RemoteHeroOptions);
          });
        }, "remote-hub: new-session hero options");
      } catch (error) {
        console.warn("[dsh-remote-hub] hero options registration failed", error);
      }
      try {
        ctx.effect(function () {
          return ctx.slots.inject("main", function () {
            return ctx.slots.register({ name: "main", key: PANEL_ID }, RemoteWorkspacePage);
          });
        }, "remote-hub: workspace page");
        ctx.effect(function () {
          return ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 12, label: function () { return "远端工作区"; } }, RemoteWorkspaceIcon);
          });
        }, "remote-hub: sidebar workspace entry");
      } catch (error) {
        console.warn("[dsh-remote-hub] workspace page registration failed", error);
      }
      try {
        if (window.self !== window.top) {
          try { window.parent.postMessage({ type: "dsh-hub-ready" }, window.location.origin); } catch (error) {}
          window.addEventListener("message", function (event) {
            if (event.origin !== window.location.origin) return;
            var data = event.data;
            if (!data || data.type !== "dsh-hub-open-session") return;
            openSessionViaUi(ctx, data.sessionId);
          });
        }
      } catch (error) {
        console.warn("[dsh-remote-hub] deep link listener failed", error);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "remote-hub-client";
    return module.exports;
  }
});
