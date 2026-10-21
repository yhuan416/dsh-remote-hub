window.__ModuleLoader__.load({
  id: "dsh-remote-hub",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;
    var PANEL_ID = "remote-hub";
    var WORKSPACES_PANEL = "remote-workspaces";
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
          }));
    }

    function RemoteSection(props) {
      if (!matches(props && props.subject)) return null;
      return h(RemotePanel, null);
    }

    function CombinedIcon(props) {
      var size = props !== undefined && typeof props.size === "number" ? props.size : 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 2.5, y: 2.5, width: 11, height: 4, rx: 1, stroke: "currentColor", strokeWidth: 1.2 }),
        h("rect", { x: 2.5, y: 9.5, width: 11, height: 4, rx: 1, stroke: "currentColor", strokeWidth: 1.2 }));
    }

    var panelStyles = {
      wrap: { maxWidth: "980px", margin: "0 auto", padding: "24px 28px 40px", display: "flex", flexDirection: "column", gap: "18px", color: "var(--dsw-alias-label-primary, inherit)", font: "13px/1.5 system-ui, sans-serif" },
      head: { display: "flex", alignItems: "center", gap: "10px" },
      title: { margin: "0", fontSize: "16px", fontWeight: "600" },
      spacer: { flex: "1" },
      button: { padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
      section: { display: "flex", flexDirection: "column", gap: "8px" },
      sectionTitle: { fontSize: "12px", textTransform: "uppercase", letterSpacing: ".05em", color: "var(--dsw-alias-label-tertiary, #999)", margin: "0" },
      card: { border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "2px" },
      groupTitle: { fontSize: "13px", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px" },
      muted: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: "12px" },
      row: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 8px", borderRadius: "6px", cursor: "pointer", color: "var(--dsw-alias-label-primary, inherit)" },
      rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      badge: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" },
      dot: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: "#8a8a8a" }
    };

    function dotColor(state) {
      return state === "online" ? "#37b24d" : state === "pending" ? "#f59f0b" : state === "offline" ? "#e03131" : "#8a8a8a";
    }

    function sessionLabel(session) {
      return session !== undefined && typeof session.title === "string" && session.title !== "" ? session.title : String(session !== undefined ? session.id : "").slice(0, 28);
    }

    function sessionMeta(session) {
      if (session === undefined || session.updatedAt === undefined || session.updatedAt === null) return null;
      var stamp = typeof session.updatedAt === "number" ? new Date(session.updatedAt) : new Date(String(session.updatedAt));
      return isNaN(stamp.getTime()) ? null : stamp.toLocaleString();
    }

    function makeWorkspacesPanel(ctx) {
      return function WorkspacesPanel(props) {
        var useWorkspaces = props !== undefined && typeof props.useWorkspaces === "function" ? props.useWorkspaces : function () { return []; };
        var useSessions = props !== undefined && typeof props.useSessions === "function" ? props.useSessions : function () { return {}; };
        var items = useWorkspaces(function (state) { return state.items; });
        var sessions = useSessions(function (state) { return state; });
        var remoteState = React.useState([]);
        var remotes = remoteState[0];
        var setRemotes = remoteState[1];

        function load() {
          fetch("/api/remote-hosts/workspaces", { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) { setRemotes(Array.isArray(payload.remotes) ? payload.remotes : []); })
            .catch(function () {});
        }

        React.useEffect(function () {
          load();
          var timer = setInterval(load, 15000);
          return function () { clearInterval(timer); };
        }, []);

        function back() { try { ctx.layout.selectPanel(null); } catch (error) {} }
        function openLocal(sessionId) {
          back();
          var ui = ctx.get("uiWorkspace");
          if (ui !== undefined && typeof ui.openSession === "function") { try { ui.openSession(sessionId); } catch (error) {} }
        }
        function openRemote(remoteId, sessionId) {
          window.dispatchEvent(new CustomEvent("dsh-hub-open-session", { detail: { remoteId: remoteId, sessionId: sessionId } }));
        }
        function row(key, label, meta, onSelect) {
          return h("div", { key: key, style: panelStyles.row, onClick: onSelect },
            h("span", { style: panelStyles.rowTitle }, label),
            meta === null ? null : h("span", { style: panelStyles.badge }, meta));
        }

        var byId = sessions !== undefined && sessions.byId !== undefined ? sessions.byId : {};
        var groups = (Array.isArray(items) ? items : []).map(function (workspace) {
          var ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
          return {
            key: workspace.workspaceId,
            title: workspace.title,
            path: workspace.path,
            sessions: ids.map(function (id) { return byId[id]; }).filter(function (session) { return session !== undefined; })
          };
        });
        var accounted = new Set();
        groups.forEach(function (group) { group.sessions.forEach(function (session) { accounted.add(session.id); }); });
        var others = Object.keys(byId).filter(function (id) { return accounted.has(id) === false; }).map(function (id) { return byId[id]; });

        return h("div", { style: panelStyles.wrap },
          h("div", { style: panelStyles.head },
            h("h2", { style: panelStyles.title }, "工作区"),
            h("span", { style: panelStyles.muted }, "本地 + 远端"),
            h("span", { style: panelStyles.spacer }),
            h("button", { style: panelStyles.button, onClick: load }, "刷新"),
            h("button", { style: panelStyles.button, onClick: back }, "← 对话")),
          h("section", { style: panelStyles.section },
            h("h3", { style: panelStyles.sectionTitle }, "本地"),
            groups.length === 0 ? h("div", { style: panelStyles.muted }, "暂无工作区") : groups.map(function (group) {
              return h("div", { key: group.key, style: panelStyles.card },
                h("div", { style: panelStyles.groupTitle }, group.title),
                group.path === null || group.path === undefined ? null : h("div", { style: panelStyles.muted }, group.path),
                group.sessions.length === 0
                  ? h("div", { style: panelStyles.muted }, "（无会话）")
                  : group.sessions.map(function (session) {
                    return row(session.id, sessionLabel(session), sessionMeta(session), function () { openLocal(session.id); });
                  }));
            }),
            others.length === 0 ? null : h("div", { style: panelStyles.card },
              h("div", { style: panelStyles.groupTitle }, "其他会话"),
              others.map(function (session) { return row(session.id, sessionLabel(session), sessionMeta(session), function () { openLocal(session.id); }); }))),
          h("section", { style: panelStyles.section },
            h("h3", { style: panelStyles.sectionTitle }, "远端"),
            remotes.length === 0
              ? h("div", { style: panelStyles.muted }, "加载中…")
              : remotes.map(function (remote) {
                var workspaces = Array.isArray(remote.workspaces) ? remote.workspaces : [];
                var total = workspaces.reduce(function (sum, workspace) { return sum + (Array.isArray(workspace.sessions) ? workspace.sessions.length : 0); }, 0);
                return h("div", { key: remote.id, style: panelStyles.card },
                  h("div", { style: panelStyles.groupTitle },
                    h("span", { style: Object.assign({}, panelStyles.dot, { background: dotColor(remote.state) }) }),
                    remote.label,
                    h("span", { style: panelStyles.muted }, workspaces.length + " 个工作区 / " + total + " 个会话")),
                  workspaces.map(function (workspace) {
                    return h("div", { key: workspace.id, style: { marginTop: "6px" } },
                      h("div", { style: panelStyles.muted }, (workspace.title === undefined ? "" : workspace.title) + (workspace.path === null || workspace.path === undefined ? "" : "  " + workspace.path)),
                      (Array.isArray(workspace.sessions) ? workspace.sessions : []).slice(0, 20).map(function (session) {
                        return row(session.id, sessionLabel(session), session.running === true ? "运行中" : null, function () { openRemote(remote.id, session.id); });
                      }));
                  }),
                  remote.error === undefined ? null : h("div", { style: panelStyles.muted }, String(remote.error)));
              })));
      };
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
          return ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({
              name: "sidebar.panellist",
              id: WORKSPACES_PANEL,
              order: 40,
              label: "工作区（本地+远端）"
            }, CombinedIcon);
          });
        }, "remote-hub: workspaces panel icon");
        ctx.effect(function () {
          return ctx.slots.inject("main", function () {
            return ctx.slots.register({ name: "main", key: WORKSPACES_PANEL }, makeWorkspacesPanel(ctx));
          });
        }, "remote-hub: workspaces panel");
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
    exports.inject = ["slots", "layout"];
    exports.name = "remote-hub-client";
    return module.exports;
  }
});
