/* ============================================================
   datastore.js —— 「仓库文件 + 本机覆盖层」通用三源存储
   ------------------------------------------------------------
   为什么需要这个模块：
     门户托管在 GitHub Pages（纯静态），浏览器没有服务端可写。
     所以任何「后台里能改的数据」都必须在两层之间搬运：

       ①  源码常量         js/config/*.js       随源码部署   全站生效
       ②  仓库数据文件     data/*.json          随仓库部署   全站生效  ← 靠它到同事机器
       ③  localStorage     仅本机               即时可用但别人看不到

     三源合并、墓碑删除、差异落盘、导出 payload —— 这套机械逻辑
     用户表和内容表都要用。**只写一遍**，各表只提供配置。

   实例方法：
     ready()            等仓库文件拉取落地（含失败），返回 status
     refresh()          强制重拉
     status()           { loaded, error, count }
     load()             合并后的列表（已应用墓碑）
     save(list)         只把「与共享层不等价」的差异写进本机覆盖层
     sourceOf(item)     'builtin' | 'remote' | 'local'
     changed(item)      该项是否与共享层不同（=需要导出）
     exportPayload()    可直接写进仓库文件的完整对象
     exportRows()       需要导出的条目
     deletedList()      合并后的已删除名单

   配置项（cfg）：
     localKey / remoteKey    localStorage 键名（沿用旧键名，别丢已有数据）
     remoteUrl               仓库文件路径，如 'data/users.json'
     itemsField              文件里存条目数组的字段名，默认 'items'
     key                     去重主键字段名，默认 'id'（比较时忽略大小写）
     identity                判定「与共享层等价」参与比较的字段
     boolFields              按布尔语义比较的字段（undefined 视为 false）
     tombstoneField          本机墓碑标记字段名，默认 '_deleted'
     defaults                源码内置常量函数，返回数组
     note                    导出文件里的说明
     ============================================================ */

var DataStore = (function () {
  'use strict';

  function readJSON(key, fb) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 满则忽略 */ }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }

  function create(cfg) {
    var localKey = cfg.localKey;
    var remoteKey = cfg.remoteKey;
    var remoteUrl = cfg.remoteUrl;
    var itemsField = cfg.itemsField || 'items';
    var keyField = cfg.key || 'id';
    var identityFields = cfg.identity || [keyField];
    var boolFields = cfg.boolFields || [];
    var tombField = cfg.tombstoneField || '_deleted';
    var defaultsFn = cfg.defaults || function () { return []; };
    var note = cfg.note || '';

    var STATE = { loaded: false, error: null, count: 0 };

    /* ── 本机覆盖层 ─────────────────────────────── */
    function localList() { return readJSON(localKey, null) || []; }
    function saveLocalList(list) { writeJSON(localKey, list); }

    /* ── 仓库文件（远端 + 本地缓存）─────────────── */
    function remoteDoc() { return readJSON(remoteKey, null) || {}; }
    function remoteItems() { return remoteDoc()[itemsField] || []; }
    function remoteDeleted() { return remoteDoc().deleted || []; }

    function ready(force) {
      if (STATE.loaded && !force) return Promise.resolve(STATE);
      var base = (window.SITE_BASE || '/');
      return fetch(base + remoteUrl, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          var list = (d && d[itemsField]) || [];
          var doc = { version: (d && d.version) || 1, updatedAt: (d && d.updatedAt) || null, deleted: (d && d.deleted) || [] };
          doc[itemsField] = list;
          writeJSON(remoteKey, doc);
          STATE = { loaded: true, error: null, count: list.length };
          return STATE;
        })
        .catch(function (e) {
          STATE = { loaded: true, error: String((e && e.message) || e), count: remoteItems().length };
          return STATE;
        });
    }

    /* ── 等价判定 ───────────────────────────────── */
    function cmpVal(v, isBool) {
      if (isBool) return (v !== false) ? '1' : '0';
      if (v === true) return '1';
      if (v === false) return '0';
      return String(v == null ? '' : v);
    }
    function sameIdentity(a, b) {
      if (!a || !b) return false;
      for (var i = 0; i < identityFields.length; i++) {
        var f = identityFields[i];
        if (cmpVal(a[f], boolFields.indexOf(f) !== -1) !== cmpVal(b[f], boolFields.indexOf(f) !== -1)) return false;
      }
      return true;
    }

    /* 共享层 = 源码常量 + 仓库文件 */
    function shared() { return clone(defaultsFn()).concat(remoteItems()); }

    function indexByKey(list) {
      var m = {};
      (list || []).forEach(function (x) { if (x && x[keyField] != null) m[lc(x[keyField])] = x; });
      return m;
    }

    /* 清掉本机覆盖层里「与共享层等价」的陈旧副本。
       历史版本曾在登录时把整表写进 localStorage，成员浏览器会留下快照；
       不清理的话，管理员远端改了密码，成员本机的旧快照会把它盖回去。 */
    function prune(local, sh) {
      var byKey = indexByKey(sh);
      return (local || []).filter(function (x) {
        if (x && x[tombField]) return true;                 // 墓碑必须留
        var b = byKey[lc(x && x[keyField])];
        return !b || !sameIdentity(x, b);
      });
    }

    /* ── 合并 ───────────────────────────────────── */
    function mergeLayers(layers) {
      var idx = {}, out = [];
      layers.forEach(function (list) {
        (list || []).forEach(function (x) {
          if (!x || x[keyField] == null) return;
          var k = lc(x[keyField]);
          if (Object.prototype.hasOwnProperty.call(idx, k)) out[idx[k]] = x;
          else { idx[k] = out.length; out.push(x); }
        });
      });
      return out;
    }

    /* 墓碑：只记主键 + 展示名 + 删除时间。
       主键字段名与正常条目一致（用户表=username、内容表=id），
       这样 data/*.json 里的 deleted 名单天然就是「用户账号」/「内容 id」。 */
    function deletedSet(local) {
      var gone = {};
      remoteDeleted().forEach(function (n) { gone[lc(n)] = 1; });
      (local || []).forEach(function (x) {
        if (x && x[tombField] && x[keyField] != null) gone[lc(x[keyField])] = 1;
      });
      return gone;
    }

    function load() {
      var raw = localList();
      var sh = shared();
      var local = prune(raw, sh);
      if (local.length !== raw.length) saveLocalList(local);
      var merged = mergeLayers([clone(defaultsFn()), remoteItems(), local]);
      var gone = deletedSet(local);
      return merged.filter(function (x) { return !x[tombField] && !gone[lc(x[keyField])]; });
    }

    /* 只落差异 —— 不把整表写进 localStorage */
    function save(list) {
      var byKey = indexByKey(shared());
      saveLocalList((list || []).filter(function (x) {
        if (x && x[tombField]) return true;
        var b = byKey[lc(x && x[keyField])];
        return !b || !sameIdentity(x, b);
      }));
    }

    /* 加墓碑（删除共享层里的条目时用：直接从列表移除会被合并还原） */
    function tombstone(item) {
      var l = localList();
      var k = lc(item && item[keyField]);
      if (l.some(function (x) { return x && x[tombField] && lc(x[keyField]) === k; })) return;
      var t = {};
      t[keyField] = item[keyField];
      t[tombField] = true;
      t.deletedAt = new Date().toISOString();
      if (item.title != null) t.title = item.title;      // 展示用，不参与判定
      if (item.name != null) t.name = item.name;
      l.push(t);
      saveLocalList(l);
    }

    function inShared(item) {
      var k = lc(item && item[keyField]);
      return shared().some(function (x) { return lc(x && x[keyField]) === k; });
    }

    function sourceOf(item) {
      var k = lc(item && item[keyField]);
      if (localList().some(function (x) { return x && !x[tombField] && lc(x[keyField]) === k; })) return 'local';
      if (remoteItems().some(function (x) { return lc(x && x[keyField]) === k; })) return 'remote';
      return 'builtin';
    }

    /* 与共享层不等价 → 需要导出 */
    function changed(item) {
      var k = lc(item && item[keyField]);
      var b = shared().filter(function (x) { return lc(x && x[keyField]) === k; })[0];
      return !b || !sameIdentity(item, b);
    }
    function exportRows() { return load().filter(changed); }

    function deletedList() {
      var out = remoteDeleted().slice();
      localList().forEach(function (x) {
        if (!x || !x[tombField] || x[keyField] == null) return;
        var name = x[keyField];
        if (out.indexOf(name) === -1) out.push(name);
      });
      return out;
    }

    function exportPayload() {
      var gone = deletedList();
      var rows = exportRows().filter(function (x) { return gone.indexOf(x[keyField]) === -1; });
      var out = {
        version: 1,
        updatedAt: new Date().toISOString(),
        note: note,
        deleted: gone
      };
      out[itemsField] = rows;
      return out;
    }

    return {
      config: cfg,
      ready: ready,
      refresh: function () { return ready(true); },
      status: function () { return STATE; },
      load: load,
      save: save,
      tombstone: tombstone,
      inShared: inShared,
      sourceOf: sourceOf,
      changed: changed,
      exportRows: exportRows,
      exportPayload: exportPayload,
      deletedList: deletedList,
      localList: localList,
      saveLocalList: saveLocalList,
      remoteItems: remoteItems,
      sameIdentity: sameIdentity
    };
  }

  return { create: create };
})();
