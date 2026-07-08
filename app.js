/* Мои финансы — статичное приложение поверх data.js.
   Пользовательские категории, правила и правки хранятся в localStorage. */
"use strict";

const LS = {
  cats: "fin.customCats",
  catEdits: "fin.catEdits",
  overrides: "fin.overrides",
  fx: "fin.fx",
  manual: "fin.manualTxs",
  roundup: "fin.roundup",
};

const FX_CURRENCIES = [
  ["USD", "$"], ["EUR", "€"], ["RUB", "₽"], ["GBP", "£"], ["CNY", "¥"],
  ["TRY", "₺"], ["AMD", "֏"], ["GEL", "₾"], ["KZT", "₸"], ["RSD", "din"],
  ["THB", "฿"], ["USDT", "USDT"],
];
const fxSym = (cur) =>
  (FX_CURRENCIES.find(([c]) => c === cur) || [cur, cur])[1];
const fxStr = (fx) => `${fmtMoney.format(fx.amt)} ${fxSym(fx.cur)}`;

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_FULL = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const KIND_NAMES = { spending: "Траты", transfer: "Переводы", income: "Доходы" };

const fmtMoney = new Intl.NumberFormat("ru-RU",
  { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtMoney0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (v) => fmtMoney.format(v) + " ₽";
const rub0 = (v) => fmtMoney0.format(v) + " ₽";

function plur(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ` + (m10 === 1 && m100 !== 11 ? one
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
}
const plurOps = (n) => plur(n, "операция", "операции", "операций");

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

/* ---------- данные (заполняются после расшифровки) ---------- */

let BASE_CATEGORIES = [];
let META = {};
let RAW = [];          // операции из выписки (для сверки баланса)
let txs = [];          // выписка + ручные операции
let monthsInData = [];
let lastDate = "";

let customCats = load(LS.cats, []);
let catEdits = load(LS.catEdits, {});   // правки встроенных категорий
let overrides = load(LS.overrides, {});
let fxMap = load(LS.fx, {});
let manualTxs = load(LS.manual, []);
let roundupOn = load(LS.roundup, true);

const txKey = (t) => `${t.date}|${t.time || ""}|${t.amount}|${t.desc}`;

function allCats() {
  return [...customCats, ...BASE_CATEGORIES.map((c) =>
    catEdits[c.id] ? { ...c, ...catEdits[c.id] } : c)];
}

function catById(id) { return allCats().find((c) => c.id === id); }

const matchPatterns = (desc, patterns) =>
  (patterns || []).some((p) =>
    p && desc.toLowerCase().includes(p.toLowerCase()));

function effectiveCat(t) {
  const ov = overrides[txKey(t)];
  if (ov && catById(ov)) return ov;
  for (const c of customCats) {
    if (matchPatterns(t.desc, c.patterns)) return c.id;
  }
  // доп. правила, дописанные к встроенным категориям
  for (const [id, e] of Object.entries(catEdits)) {
    if (e.patterns && matchPatterns(t.desc, e.patterns)) return id;
  }
  return t.cat;
}

function recompute() { txs.forEach((t) => { t.ecat = effectiveCat(t); }); }

/* Одноразовая чистка: ранние версии подставляли первое слово описания как
   правило новой категории — для переводов («Перевод», «Пополнение.») это
   утаскивало в неё сотни операций. Убираем такие правила-пылесосы; сами
   категории и назначенные вручную операции остаются. Заодно категории,
   в которых только поступления, помечаем как доходы. */
function migrate() {
  if (load("fin.migr1", false)) return;
  const sweep = ["перевод", "переводы", "пополнение", "внутрибанковский",
    "внутренний", "внешний", "банковский", "внесение", "снятие", "оплата",
    "сбп", "кэшбэк", "возврат"];
  let changed = false;
  for (const c of customCats) {
    const kept = (c.patterns || []).filter((p) => {
      const w = p.toLowerCase().replace(/^[^a-zа-яё0-9]+|[^a-zа-яё0-9]+$/g, "");
      return w.length >= 3 && !sweep.includes(w);
    });
    if (kept.length !== (c.patterns || []).length) {
      c.patterns = kept;
      changed = true;
    }
    const assigned = txs.filter((t) => overrides[txKey(t)] === c.id);
    if (assigned.length && c.kind === "spending" &&
        assigned.every((t) => t.amount > 0)) {
      c.kind = "income";
      changed = true;
    }
  }
  if (changed) {
    save(LS.cats, customCats);
    recompute();
  }
  save("fin.migr1", true);
}

/* Категории перекладывания денег между своими счетами («на копилку»,
   «вывод с кредитки») — это переводы, не траты и не доходы. */
function migrate2() {
  if (load("fin.migr2", false)) return;
  let changed = false;
  for (const c of customCats) {
    if (c.kind !== "transfer" && /копилк|кредитк|вывод/i.test(c.name)) {
      c.kind = "transfer";
      changed = true;
    }
  }
  if (changed) {
    save(LS.cats, customCats);
    recompute();
  }
  save("fin.migr2", true);
}

function rebuildTxs() {
  txs = [...RAW.map((t) => ({ ...t })),
         ...manualTxs.map((t) => ({ ...t, manual: true }))];
  recompute();
  monthsInData = [...new Set(txs.map((t) => t.date.slice(0, 7)))].sort();
  lastDate = META.balanceDate ||
    RAW.reduce((m, t) => (t.date > m ? t.date : m), "");
}

/* сумма операции с учётом округления в копилку; спаренные копилочные
   переводы при включённой галке скрываются, их сумма прибавлена к покупке */
const amountOf = (t) =>
  roundupOn && t.ru ? Math.round((t.amount - t.ru) * 100) / 100 : t.amount;
const visibleTx = (t) => !(roundupOn && t.pr !== undefined);

/* ---------- состояние фильтров ---------- */

const state = {
  range: "all",        // all | 30 | 90 | "YYYY-MM"
  kind: "spending",    // spending | income | transfer | all
  cat: null,           // id категории или null
  search: "",
  limit: 50,
};

function inRange(t) {
  if (state.range === "all") return true;
  if (state.range === "30" || state.range === "90") {
    const d = new Date(lastDate);
    d.setDate(d.getDate() - Number(state.range));
    return t.date > d.toISOString().slice(0, 10);
  }
  return t.date.startsWith(state.range);
}

function inKind(t) {
  const kind = (catById(t.ecat) || {}).kind || "spending";
  switch (state.kind) {
    // плюсовые операции в категориях трат — возмещения (друзья скинули за
    // каршеринг, возврат покупки): показываются в тратах и уменьшают их
    case "spending": return kind === "spending";
    case "income": return t.amount > 0 && kind === "income";
    case "transfer": return kind === "transfer";
    default: return true;
  }
}

function filtered(ignoreCat = false) {
  const q = state.search.trim().toLowerCase();
  return txs.filter((t) =>
    visibleTx(t) && inRange(t) && inKind(t) &&
    (ignoreCat || !state.cat || t.ecat === state.cat) &&
    (!q || t.desc.toLowerCase().includes(q)));
}

/* ---------- утилиты DOM ---------- */

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function slotColor(slot) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--s${slot}`).trim() || "#898781";
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- фильтры (chips) ---------- */

function renderChips() {
  const row = $("#rangeChips");
  row.textContent = "";
  const mk = (label, value) => {
    const b = el("button", "chip" + (state.range === value ? " on" : ""), label);
    b.onclick = () => { state.range = value; state.limit = 50; renderAll(); };
    row.append(b);
  };
  mk("Всё время", "all");
  mk("30 дней", "30");
  mk("90 дней", "90");
  for (const m of monthsInData) {
    const [y, mm] = m.split("-");
    mk(`${MONTHS_SHORT[Number(mm) - 1]} ’${y.slice(2)}`, m);
  }
}

/* ---------- KPI ---------- */

function renderKpis() {
  const list = filtered();
  const box = $("#kpis");
  box.textContent = "";

  const days = new Set(list.map((t) => t.date)).size || 1;
  const out = list.filter((t) => t.amount < 0)
    .reduce((s, t) => s - amountOf(t), 0);
  const inn = list.filter((t) => t.amount > 0)
    .reduce((s, t) => s + amountOf(t), 0);

  const tile = (lbl, val, sub, pos) => {
    const d = el("div", "tile");
    d.append(el("div", "lbl", lbl));
    d.append(el("div", "val" + (pos ? " pos" : ""), val));
    if (sub) d.append(el("div", "sub", sub));
    box.append(d);
  };

  if (state.kind === "spending") {
    const byCat = groupSum(list);
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
    const reimb = list.filter((t) => amountOf(t) > 0)
      .reduce((s, t) => s + amountOf(t), 0);
    const net = out - reimb;
    tile("Потрачено", rub0(net), plurOps(list.length) +
      (reimb > 0 ? ` · возмещения −${rub0(reimb)}` : ""));
    tile("В день", rub0(net / days), `за ${days} дн. с тратами`);
    if (top) {
      const c = catById(top[0]);
      tile("Топ категория", `${c.emoji} ${rub0(top[1])}`, c.name);
    }
  } else if (state.kind === "income") {
    tile("Поступило", rub0(inn), plurOps(list.length), true);
    tile("В день", rub0(inn / days), `за ${days} дн.`);
  } else if (state.kind === "transfer") {
    tile("Отправлено", rub0(out), "копилка, брокер, переводы");
    tile("Получено", rub0(inn), "", true);
  } else {
    tile("Поступления", rub0(inn), "", true);
    tile("Расходы", rub0(out));
    tile("Итог", (inn - out >= 0 ? "+" : "−") + rub0(Math.abs(inn - out)),
      plurOps(list.length), inn - out >= 0);
  }

  // сверка с балансом счёта: якорь — остаток на дату конца выписки;
  // ручные операции на баланс не влияют
  if (META.balance != null) {
    const end = /^\d{4}-\d{2}$/.test(state.range)
      ? state.range + "-99" : META.balanceDate;
    const later = RAW.filter((t) => t.date > end)
      .reduce((s, t) => s + t.amount, 0);
    const endBal = META.balance - later;
    const net = RAW.filter((t) => inRange(t))
      .reduce((s, t) => s + t.amount, 0);
    tile("На счету", rub0(endBal),
      (state.range === "all" ? "сейчас" : "на конец периода") +
      ` · в начале ${rub0(endBal - net)}`);
  }
}

/* В режиме трат суммы нетто: плюсовые возмещения вычитаются из категории */
function groupSum(list, net = state.kind === "spending") {
  const m = new Map();
  for (const t of list) {
    const v = net ? -amountOf(t) : Math.abs(amountOf(t));
    m.set(t.ecat, (m.get(t.ecat) || 0) + v);
  }
  return m;
}

/* ---------- график ---------- */

const CHART_FOLD = "__fold__";

function renderChart() {
  const svg = $("#chart");
  svg.textContent = "";
  const list = filtered(true).filter((t) =>
    state.kind === "income" ? t.amount > 0 : true);

  $("#chartTitle").textContent = {
    spending: "Траты по месяцам", income: "Поступления по месяцам",
    transfer: "Переводы по месяцам", all: "Обороты по месяцам",
  }[state.kind];

  // месяц × категория → сумма (по модулю)
  const perMonth = new Map();
  for (const m of monthsInData) perMonth.set(m, new Map());
  const netMode = state.kind === "spending";
  for (const t of list) {
    const mm = perMonth.get(t.date.slice(0, 7));
    if (mm) {
      mm.set(t.ecat, (mm.get(t.ecat) || 0) +
        (netMode ? -amountOf(t) : Math.abs(amountOf(t))));
    }
  }

  // топ-7 категорий за период, остальное (и «Прочее») — в серую «Остальное»
  const totals = groupSum(list);
  const top = [...totals.entries()].filter(([id]) => id !== "other")
    .sort((a, b) => b[1] - a[1]).slice(0, 7).map(([id]) => id);
  const hasFold = totals.size > top.length;
  const series = [...top, ...(hasFold ? [CHART_FOLD] : [])];

  const W = Math.max(svg.parentElement.clientWidth || 640, 320);
  const H = 240, padL = 46, padR = 8, padT = 10, padB = 26;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

  const monthTotals = monthsInData.map((m) =>
    [...perMonth.get(m).values()].reduce((s, v) => s + v, 0));
  const maxV = Math.max(...monthTotals, 1);
  const step = niceStep(maxV / 4);
  const yMax = Math.ceil(maxV / step) * step;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const y = (v) => padT + plotH * (1 - v / yMax);
  const ns = "http://www.w3.org/2000/svg";

  // сетка + подписи оси Y
  for (let v = 0; v <= yMax; v += step) {
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", padL); ln.setAttribute("x2", W - padR);
    ln.setAttribute("y1", y(v)); ln.setAttribute("y2", y(v));
    ln.setAttribute("stroke", v === 0 ? "var(--baseline)" : "var(--grid)");
    ln.setAttribute("stroke-width", "1");
    svg.append(ln);
    if (v > 0) {
      const tx = document.createElementNS(ns, "text");
      tx.setAttribute("x", padL - 6); tx.setAttribute("y", y(v) + 4);
      tx.setAttribute("text-anchor", "end");
      tx.setAttribute("font-size", "11");
      tx.setAttribute("fill", "var(--ink-3)");
      tx.style.fontVariantNumeric = "tabular-nums";
      tx.textContent = v >= 1000 ? (v / 1000) + "к" : v;
      svg.append(tx);
    }
  }

  const band = plotW / monthsInData.length;
  const barW = Math.min(24, band * 0.55);

  monthsInData.forEach((m, i) => {
    const cx = padL + band * i + band / 2;
    const mm = perMonth.get(m);
    let acc = 0;
    const parts = series
      .map((sid) => {
        const v = sid === CHART_FOLD
          ? [...mm.entries()].filter(([id]) => !top.includes(id))
            .reduce((s, [, val]) => s + val, 0)
          : (mm.get(sid) || 0);
        return [sid, v];
      })
      .filter(([, v]) => v > 0);

    parts.forEach(([sid, v], j) => {
      const isTop = j === parts.length - 1;
      const y0 = y(acc + v), y1 = y(acc);
      const h = Math.max(y1 - y0 - (j > 0 ? 2 : 0), 0.5); // 2px surface gap
      const x0 = cx - barW / 2;
      const color = sid === CHART_FOLD ? "var(--s0)"
        : `var(--s${(catById(sid) || {}).slot ?? 0})`;
      let node;
      if (isTop && h > 4) { // верхний сегмент — скруглённый кап
        node = document.createElementNS(ns, "path");
        const r = 4, x1 = x0 + barW, yy = y1 - (j > 0 ? 2 : 0);
        node.setAttribute("d",
          `M${x0},${yy} L${x0},${y0 + r} Q${x0},${y0} ${x0 + r},${y0} ` +
          `L${x1 - r},${y0} Q${x1},${y0} ${x1},${y0 + r} L${x1},${yy} Z`);
      } else {
        node = document.createElementNS(ns, "rect");
        node.setAttribute("x", x0); node.setAttribute("y", y0);
        node.setAttribute("width", barW); node.setAttribute("height", h);
      }
      node.setAttribute("fill", color);
      attachSegTooltip(node, m, sid, v);
      svg.append(node);
      acc += v;
    });

    const tx = document.createElementNS(ns, "text");
    tx.setAttribute("x", cx); tx.setAttribute("y", H - 8);
    tx.setAttribute("text-anchor", "middle");
    tx.setAttribute("font-size", "11.5");
    tx.setAttribute("fill", "var(--ink-3)");
    tx.textContent = MONTHS_SHORT[Number(m.slice(5)) - 1];
    svg.append(tx);
  });

  // легенда
  const lg = $("#legend");
  lg.textContent = "";
  for (const sid of series) {
    const k = el("span", "key");
    const sw = el("i", "swatch");
    sw.style.background = sid === CHART_FOLD ? "var(--s0)"
      : `var(--s${(catById(sid) || {}).slot ?? 0})`;
    k.append(sw, document.createTextNode(
      sid === CHART_FOLD ? "Остальное" : (catById(sid) || {}).name || sid));
    lg.append(k);
  }
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  for (const k of [1, 2, 2.5, 5, 10]) {
    if (raw <= k * pow) return k * pow;
  }
  return 10 * pow;
}

let tipEl;
function attachSegTooltip(node, month, sid, value) {
  const name = sid === CHART_FOLD ? "Остальное" : (catById(sid) || {}).name;
  const show = (e) => {
    if (!tipEl) { tipEl = el("div", "tooltip"); document.body.append(tipEl); }
    tipEl.textContent = "";
    tipEl.append(el("div", "tt-val", rub0(value)));
    const [y, m] = month.split("-");
    tipEl.append(el("div", "", `${name} · ${MONTHS_FULL[Number(m) - 1]} ${y}`));
    move(e);
    node.setAttribute("opacity", "0.75");
  };
  const move = (e) => {
    if (!tipEl) return;
    const pad = 12, r = tipEl.getBoundingClientRect();
    let x = e.clientX + pad, yy = e.clientY - r.height - pad;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (yy < 8) yy = e.clientY + pad;
    tipEl.style.left = x + "px";
    tipEl.style.top = yy + "px";
  };
  const hide = () => {
    if (tipEl) { tipEl.remove(); tipEl = null; }
    node.removeAttribute("opacity");
  };
  node.addEventListener("pointerenter", show);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerleave", hide);
  node.addEventListener("pointerdown", show);
}

/* ---------- список категорий ---------- */

function renderCats() {
  const box = $("#catList");
  box.textContent = "";
  const list = filtered(true);
  const sums = groupSum(list);
  const counts = new Map();
  list.forEach((t) => counts.set(t.ecat, (counts.get(t.ecat) || 0) + 1));

  const rows = allCats()
    .map((c) => ({ c, sum: sums.get(c.id) || 0, n: counts.get(c.id) || 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.sum - a.sum);
  const maxSum = rows[0]?.sum || 1;

  for (const { c, sum, n } of rows) {
    const row = el("button", "cat-row" +
      (state.cat && state.cat !== c.id ? " dim" : ""));
    row.append(el("div", "cat-emoji", c.emoji));
    const mid = el("div", "cat-mid");
    const nm = el("div", "cat-name", c.name);
    if (!c.builtin) nm.append(el("span", "custom-mark", "своя"));
    const edit = el("span", "cat-edit", "✎");
    edit.title = "Изменить категорию";
    edit.setAttribute("role", "button");
    edit.onclick = (e) => { e.stopPropagation(); openCatForm(c); };
    nm.append(edit);
    const bar = el("div", "cat-bar");
    const fill = el("i");
    fill.style.width = (100 * sum / maxSum).toFixed(1) + "%";
    fill.style.background = `var(--s${c.slot ?? 0})`;
    bar.append(fill);
    mid.append(nm, bar);
    const right = el("div", "cat-sum", rub0(sum));
    right.append(el("span", "cat-n", n + " оп."));
    if (c.fx) {
      const agg = {};
      for (const t of list) {
        const f = t.ecat === c.id && fxMap[txKey(t)];
        if (f) agg[f.cur] = (agg[f.cur] || 0) + f.amt;
      }
      const parts = Object.entries(agg)
        .map(([cur, amt]) => fxStr({ cur, amt }));
      if (parts.length) right.append(el("span", "cat-n", "→ " + parts.join(" · ")));
    }
    row.append(mid, right);
    row.onclick = () => {
      state.cat = state.cat === c.id ? null : c.id;
      state.limit = 50;
      renderAll();
    };
    box.append(row);
  }
  if (!rows.length) box.append(el("div", "tx-empty", "Нет операций по фильтрам"));
}

/* ---------- список операций ---------- */

function renderTxs() {
  const box = $("#txList");
  box.textContent = "";
  const list = filtered().sort((a, b) =>
    (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));

  $("#txTitle").textContent = state.cat
    ? `Операции · ${(catById(state.cat) || {}).name}`
    : "Операции";

  let lastD = "";
  for (const t of list.slice(0, state.limit)) {
    if (t.date !== lastD) {
      lastD = t.date;
      const [y, m, d] = t.date.split("-");
      box.append(el("div", "tx-date",
        `${Number(d)} ${MONTHS_FULL[Number(m) - 1].toLowerCase()} ${y}`));
    }
    const c = catById(t.ecat) || {};
    const row = el("button", "tx-row");
    row.append(el("div", "tx-ico", c.emoji || "❔"));
    const mid = el("div", "tx-mid");
    mid.append(el("div", "tx-desc", cleanDesc(t.desc)));
    const f = fxMap[txKey(t)];
    mid.append(el("div", "tx-cat", (c.name || t.ecat) +
      (f ? ` → ${fxStr(f)}` : "") + (t.manual ? " · вручную" : "")));
    row.append(mid);
    const amt = amountOf(t);
    row.append(el("div", "tx-amt" + (amt > 0 ? " pos" : ""),
      (amt > 0 ? "+" : "") + rub(amt)));
    row.onclick = () => openTxSheet(t);
    box.append(row);
  }
  if (!list.length) box.append(el("div", "tx-empty", "Ничего не найдено"));
  const more = $("#moreBtn");
  more.hidden = list.length <= state.limit;
  more.onclick = () => { state.limit += 100; renderTxs(); };
}

function cleanDesc(d) {
  return d.replace(/^Оплата в /, "").replace(/ RUS?$/, "");
}

/* ---------- шторка операции ---------- */

function openSheet(id) {
  $("#backdrop").hidden = false;
  $(id).hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheets() {
  $("#backdrop").hidden = true;
  $("#txSheet").hidden = true;
  $("#catSheet").hidden = true;
  document.body.style.overflow = "";
}
$("#backdrop").onclick = closeSheets;

function untriagedTransfers() {
  return txs.filter((t) => t.ecat === "transfers" && !(txKey(t) in overrides))
    .sort((a, b) =>
      (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
}

function assignCat(t, catId, fx, bulk) {
  const k = txKey(t);
  overrides[k] = catId;
  if (fx) fxMap[k] = fx;
  else delete fxMap[k];
  let n = 1;
  if (bulk) {
    for (const o of txs) {
      if (o !== t && o.desc === t.desc && o.ecat === "transfers" &&
          !(txKey(o) in overrides)) {
        overrides[txKey(o)] = catId;
        n++;
      }
    }
  }
  save(LS.overrides, overrides);
  save(LS.fx, fxMap);
  recompute();
  return n;
}

function openTxSheet(t, triage) {
  const body = $("#txSheetBody");
  body.textContent = "";
  if (triage) {
    body.append(el("div", "triage-progress",
      `Разбор переводов · осталось ${untriagedTransfers().length}`));
  }
  const [y, m, d] = t.date.split("-");
  body.append(el("h3", "", cleanDesc(t.desc)));
  body.append(el("div", "sub",
    `${Number(d)} ${MONTHS_FULL[Number(m) - 1].toLowerCase()} ${y}` +
    (t.time ? ` в ${t.time}` : "") +
    (t.manual ? " · добавлена вручную" : "")));
  const amt = amountOf(t);
  body.append(el("div", "big-amt" + (amt > 0 ? " pos" : ""),
    (amt > 0 ? "+" : "") + rub(amt)));
  if (roundupOn && t.ru) {
    body.append(el("div", "sub",
      `включая ${rub(t.ru)} округления в Инвесткопилку (сама покупка ${rub(-t.amount)})`));
  }
  const exFx = fxMap[txKey(t)];
  if (exFx) body.append(el("div", "sub", `конвертировано: ${fxStr(exFx)}`));
  body.append(el("div", "sub", t.desc));

  const sec = el("div", "sheet-sec");
  sec.append(el("div", "sec-lbl", "Категория — нажмите, чтобы изменить"));

  let bulkBox = null;
  const same = txs.filter((o) => o.desc === t.desc &&
    o.ecat === "transfers" && !(txKey(o) in overrides)).length;
  if (t.ecat === "transfers" && same > 1) {
    bulkBox = el("input");
    bulkBox.type = "checkbox";
    const lbl = el("label", "remember");
    lbl.style.justifyContent = "flex-start";
    lbl.style.marginBottom = "10px";
    lbl.append(bulkBox, document.createTextNode(
      ` сразу ко всем «${cleanDesc(t.desc)}» (${same} шт.)`));
    sec.append(lbl);
  }

  const fxWrap = el("div");
  const kindsOrder = t.amount > 0
    ? ["income", "spending", "transfer"]
    : ["spending", "income", "transfer"];
  const allBtns = [];
  for (const k of kindsOrder) {
    const cats = allCats().filter((c) => (c.kind || "spending") === k);
    if (!cats.length) continue;
    sec.append(el("div", "pick-kind",
      k === "spending" && t.amount > 0
        ? "Траты · как возмещение, уменьшит траты категории"
        : KIND_NAMES[k]));
    const pick = el("div", "cat-pick");
    for (const c of cats) {
      const b = el("button", t.ecat === c.id ? "on" : "");
      b.append(el("span", "", c.emoji), el("span", "", c.name));
      b.onclick = () => {
        if (c.fx) {
          allBtns.forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          showFxForm(fxWrap, t, c, triage);
          return;
        }
        const n = assignCat(t, c.id, null, bulkBox && bulkBox.checked);
        toast(n > 1 ? `→ ${c.emoji} ${c.name} · ${plurOps(n)}`
                    : `→ ${c.emoji} ${c.name}`);
        afterAssign(triage);
      };
      allBtns.push(b);
      pick.append(b);
    }
    sec.append(pick);
  }
  sec.append(fxWrap);
  body.append(sec);

  const actions = el("div", "sheet-actions");
  if (t.manual) {
    const del = el("button", "btn danger", "Удалить");
    del.onclick = () => {
      manualTxs = manualTxs.filter((o) => o.id !== t.id);
      delete overrides[txKey(t)];
      delete fxMap[txKey(t)];
      save(LS.manual, manualTxs);
      save(LS.overrides, overrides);
      save(LS.fx, fxMap);
      rebuildTxs();
      closeSheets();
      toast("Операция удалена");
      renderAll();
    };
    actions.append(del);
  }
  const nb = el("button", "btn", "＋ Новая категория");
  nb.onclick = () => { closeSheets(); openCatForm(null, t, triage); };
  actions.append(nb);
  if (triage) {
    const skip = el("button", "btn", "Пропустить →");
    skip.onclick = () => nextTriage(t);
    actions.append(skip);
  }
  body.append(actions);
  openSheet("#txSheet");
}

function showFxForm(wrap, t, c, triage) {
  wrap.textContent = "";
  const form = el("div", "fx-form");
  const sel = el("select");
  for (const [code, sym] of FX_CURRENCIES) {
    const o = el("option", "", code === sym ? code : `${code} ${sym}`);
    o.value = code;
    sel.append(o);
  }
  const inp = el("input");
  inp.type = "number";
  inp.step = "0.01";
  inp.min = "0";
  inp.placeholder = "Сколько получено";
  const ex = fxMap[txKey(t)];
  if (ex) { sel.value = ex.cur; inp.value = ex.amt; }
  const ok = el("button", "btn primary", "ОК");
  ok.onclick = () => {
    const amt = parseFloat(inp.value);
    if (!(amt > 0)) { inp.focus(); return; }
    assignCat(t, c.id, { cur: sel.value, amt });
    toast(`→ ${c.emoji} ${c.name} · ${fxStr({ cur: sel.value, amt })}`);
    afterAssign(triage);
  };
  form.append(sel, inp, ok);
  wrap.append(form,
    el("div", "fx-note", "В какую сумму и валюту в итоге конвертировался перевод"));
  inp.focus();
}

function afterAssign(triage) {
  if (triage) nextTriage(null);
  else { closeSheets(); renderAll(); }
}

let skippedTriage = new Set();

function nextTriage(current) {
  if (current) skippedTriage.add(txKey(current));
  const next = untriagedTransfers()
    .find((t) => !skippedTriage.has(txKey(t)));
  renderAll();
  if (next) openTxSheet(next, true);
  else {
    closeSheets();
    toast("Все переводы разобраны 🎉");
  }
}

function startTriage() {
  skippedTriage = new Set();
  const first = untriagedTransfers()[0];
  if (first) openTxSheet(first, true);
}

function renderTriage() {
  const n = untriagedTransfers().length;
  const card = $("#triageCard");
  card.hidden = n === 0;
  if (!n) return;
  const txt = $("#triageTxt");
  txt.textContent = "";
  const b = el("b", "", `Неразобранных переводов: ${n}`);
  txt.append(b, el("div", "sub",
    "раскидайте их по категориям — наличные в валюте, долги, своё"));
}

/* ---------- форма категории ---------- */

function openCatForm(existing, forTx, triage) {
  const body = $("#catSheetBody");
  body.textContent = "";
  body.append(el("h3", "", existing ? "Изменить категорию" : "Новая категория"));
  body.append(el("div", "sub",
    "Правила — подстроки описания, по одной на строку (например: SELFKIOSK). " +
    "Правило перекидывает в категорию все операции, где встречается подстрока, " +
    "поэтому «Перевод» или «Пополнение» писать не стоит."));

  const form = el("div", "form-grid");
  form.style.marginTop = "14px";

  const f = (lbl, node) => {
    const w = el("div");
    w.append(el("label", "", lbl), node);
    form.append(w);
    return node;
  };

  const nameIn = f("Название", el("input"));
  nameIn.type = "text";
  nameIn.value = existing?.name || "";
  nameIn.placeholder = "Кофе у корпуса";

  const emojiIn = f("Эмодзи", el("input"));
  emojiIn.type = "text";
  emojiIn.value = existing?.emoji || "🏷️";
  emojiIn.maxLength = 4;
  emojiIn.style.width = "90px";

  const kindSel = f("Тип", el("select"));
  for (const [v, n] of Object.entries(KIND_NAMES)) {
    const o = el("option", "", n);
    o.value = v;
    kindSel.append(o);
  }
  kindSel.value = existing?.kind ||
    (forTx && forTx.amount > 0 ? "income" : "spending");

  const colorWrap = el("div", "color-pick");
  let slot = existing?.slot ?? 1;
  for (let s = 1; s <= 8; s++) {
    const b = el("button", s === slot ? "on" : "");
    b.type = "button";
    b.style.background = `var(--s${s})`;
    b.setAttribute("aria-label", "Цвет " + s);
    b.onclick = () => {
      slot = s;
      colorWrap.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    };
    colorWrap.append(b);
  }
  f("Цвет", colorWrap);

  const isBuiltin = !!existing?.builtin;
  const patIn = f(isBuiltin
    ? "Свои правила (добавляются к встроенным)"
    : "Правила (необязательно)", el("textarea"));
  patIn.value = (isBuiltin
    ? catEdits[existing.id]?.patterns || []
    : existing?.patterns || []).join("\n");
  if (forTx) {
    // название мерчанта — осмысленное правило; для переводов и доходов
    // первое слово описания слишком общее, ничего не подставляем
    const tKind = (catById(forTx.ecat) || {}).kind || "spending";
    patIn.value = tKind === "spending" && forTx.amount < 0
      ? cleanDesc(forTx.desc).split(" ")[0] : "";
  }

  body.append(form);

  const actions = el("div", "sheet-actions");
  if (existing && !isBuiltin) {
    const del = el("button", "btn danger", "Удалить");
    del.onclick = () => {
      customCats = customCats.filter((c) => c.id !== existing.id);
      for (const [k, v] of Object.entries(overrides)) {
        if (v === existing.id) delete overrides[k];
      }
      save(LS.cats, customCats);
      save(LS.overrides, overrides);
      recompute();
      closeSheets();
      toast("Категория удалена");
      renderAll();
    };
    actions.append(del);
  }
  if (isBuiltin && catEdits[existing.id]) {
    const reset = el("button", "btn danger", "Сбросить правки");
    reset.onclick = () => {
      delete catEdits[existing.id];
      save(LS.catEdits, catEdits);
      recompute();
      closeSheets();
      toast("Категория как из коробки");
      renderAll();
    };
    actions.append(reset);
  }
  const okBtn = el("button", "btn primary", existing ? "Сохранить" : "Создать");
  okBtn.onclick = () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); return; }
    const patterns = patIn.value.split("\n").map((s) => s.trim())
      .filter((s) => s.length >= 3);
    if (isBuiltin) {
      catEdits[existing.id] = {
        name, emoji: emojiIn.value.trim() || existing.emoji,
        kind: kindSel.value, slot, patterns,
      };
      save(LS.catEdits, catEdits);
    } else if (existing) {
      Object.assign(existing, {
        name, emoji: emojiIn.value.trim() || "🏷️", kind: kindSel.value,
        slot, patterns,
      });
    } else {
      const cat = {
        id: "u" + Date.now().toString(36),
        name, emoji: emojiIn.value.trim() || "🏷️", slot,
        kind: kindSel.value, patterns, builtin: false,
      };
      customCats.unshift(cat);
      if (forTx) { overrides[txKey(forTx)] = cat.id; }
    }
    save(LS.cats, customCats);
    save(LS.overrides, overrides);
    recompute();
    closeSheets();
    toast(existing ? "Сохранено" : "Категория создана");
    if (forTx && triage) nextTriage(null);
    else renderAll();
  };
  actions.append(okBtn);
  body.append(actions);
  openSheet("#catSheet");
}

$("#addCatBtn").onclick = () => openCatForm(null);

/* ---------- ручная операция ---------- */

function openManualTxForm() {
  const body = $("#catSheetBody");
  body.textContent = "";
  body.append(el("h3", "", "Новая операция"));
  body.append(el("div", "sub",
    "Хранится в этом браузере; на сверку баланса счёта не влияет"));

  const form = el("div", "form-grid");
  form.style.marginTop = "14px";
  const f = (lbl, node) => {
    const w = el("div");
    w.append(el("label", "", lbl), node);
    form.append(w);
    return node;
  };

  const dateIn = f("Дата", el("input"));
  dateIn.type = "date";
  dateIn.value = new Date().toISOString().slice(0, 10);

  const amtIn = f("Сумма, ₽", el("input"));
  amtIn.type = "number";
  amtIn.step = "0.01";
  amtIn.min = "0";
  amtIn.placeholder = "500";

  const signSel = f("Тип", el("select"));
  for (const [v, n] of [["-", "Трата"], ["+", "Поступление"]]) {
    const o = el("option", "", n);
    o.value = v;
    signSel.append(o);
  }

  const descIn = f("Описание", el("input"));
  descIn.type = "text";
  descIn.placeholder = "Шаурма за наличные";

  const catSel = f("Категория", el("select"));
  for (const k of ["spending", "income", "transfer"]) {
    const cats = allCats().filter((c) => (c.kind || "spending") === k);
    if (!cats.length) continue;
    const grp = document.createElement("optgroup");
    grp.label = KIND_NAMES[k];
    for (const c of cats) {
      const o = el("option", "", `${c.emoji} ${c.name}`);
      o.value = c.id;
      grp.append(o);
    }
    catSel.append(grp);
  }
  signSel.onchange = () => {
    const k = signSel.value === "+" ? "income" : "spending";
    const first = allCats().find((c) => (c.kind || "spending") === k);
    if (first) catSel.value = first.id;
  };
  body.append(form);

  const actions = el("div", "sheet-actions");
  const ok = el("button", "btn primary", "Добавить");
  ok.onclick = () => {
    const amt = parseFloat(amtIn.value);
    if (!(amt > 0)) { amtIn.focus(); return; }
    if (!descIn.value.trim()) { descIn.focus(); return; }
    manualTxs.unshift({
      id: "m" + Date.now().toString(36),
      date: dateIn.value || new Date().toISOString().slice(0, 10),
      time: null,
      amount: (signSel.value === "-" ? -1 : 1) * amt,
      desc: descIn.value.trim(),
      cat: catSel.value,
    });
    save(LS.manual, manualTxs);
    rebuildTxs();
    closeSheets();
    toast("Операция добавлена");
    renderAll();
  };
  actions.append(ok);
  body.append(actions);
  openSheet("#catSheet");
}

$("#addTxBtn").onclick = openManualTxForm;
$("#triageBtn").onclick = startTriage;
$("#roundupToggle").onchange = (e) => {
  roundupOn = e.target.checked;
  save(LS.roundup, roundupOn);
  renderAll();
};

/* ---------- CSV ---------- */

$("#csvBtn").onclick = () => {
  const list = filtered().sort((a, b) => a.date.localeCompare(b.date));
  let csv = "﻿Дата;Время;Сумма;Округление;Категория;Конвертация;Описание\n";
  for (const t of list) {
    const c = catById(t.ecat) || {};
    const f = fxMap[txKey(t)];
    csv += `${t.date};${t.time || ""};${String(amountOf(t)).replace(".", ",")};` +
      `${roundupOn && t.ru ? String(t.ru).replace(".", ",") : ""};` +
      `${c.name || ""};${f ? f.amt + " " + f.cur : ""};` +
      `"${t.desc.replace(/"/g, '""')}"\n`;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "операции.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

/* ---------- шапка и запуск ---------- */

function renderPeriodNote() {
  const first = txs[0]?.date || "", last = lastDate;
  const f = (d) => {
    const [y, m, dd] = d.split("-");
    return `${Number(dd)} ${MONTHS_SHORT[Number(m) - 1]} ${y}`;
  };
  $("#periodNote").textContent = first ? `${f(first)} — ${f(last)}` : "";
}

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    state.limit = 50;
    renderKpis(); renderChart(); renderCats(); renderTxs();
  }, 250);
});

$("#kindFilter").onchange = (e) => {
  state.kind = e.target.value;
  state.cat = null;
  state.limit = 50;
  renderAll();
};

function renderAll() {
  renderChips();
  renderKpis();
  renderTriage();
  renderChart();
  renderCats();
  renderTxs();
}

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChart, 150);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderChart);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });

/* ---------- расшифровка данных ---------- */

const LS_PW = "fin.pw";
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decryptData(password) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(ENC_DATA.salt), iterations: ENC_DATA.iter,
      hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(ENC_DATA.iv) }, key, b64(ENC_DATA.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

function boot(data) {
  BASE_CATEGORIES = data.categories;
  META = data.meta || {};
  RAW = data.transactions;
  rebuildTxs();
  migrate();
  migrate2();
  $("#roundupToggle").checked = roundupOn;
  $("#lock").hidden = true;
  renderPeriodNote();
  renderAll();
}

async function tryUnlock(password, remember, silent) {
  const err = $("#lockErr");
  const btn = $("#unlockBtn");
  btn.disabled = true;
  btn.textContent = "Расшифровка…";
  try {
    const data = await decryptData(password);
    if (remember) localStorage.setItem(LS_PW, password);
    boot(data);
  } catch {
    if (!silent) err.textContent = "Не подошло — проверьте пароль";
    localStorage.removeItem(LS_PW);
  } finally {
    btn.disabled = false;
    btn.textContent = "Открыть";
  }
}

$("#unlockBtn").onclick = () =>
  tryUnlock($("#pw").value, $("#rememberPw").checked, false);
$("#pw").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#unlockBtn").click();
});

{
  // пароль можно передать один раз через #p=…, из адресной строки он затирается
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get("p");
  if (fromHash) history.replaceState(null, "", location.pathname + location.search);
  const saved = fromHash || localStorage.getItem(LS_PW);
  if (saved) tryUnlock(saved, $("#rememberPw").checked, true);
  else $("#pw").focus();
}
