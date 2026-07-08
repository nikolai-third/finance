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
  cash: "fin.cash",       // остатки наличных по валютам {cur: {amt, asOf}}
  account: "fin.account", // ручная правка остатка на счёте {amt, asOf}
  rates: "fin.rates",     // кэш курса ЦБ РФ
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

/* эти ключи уезжают в зашифрованный слепок на GitHub при синхронизации */
const SYNC_KEYS = [LS.cats, LS.catEdits, LS.overrides, LS.fx, LS.manual,
  LS.cash, LS.account, LS.roundup];
const LS_TOKEN = "fin.ghToken";
const LS_LASTEDIT = "fin.lastEdit";

let suppressSync = false;

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
  if (!suppressSync && SYNC_KEYS.includes(key)) {
    localStorage.setItem(LS_LASTEDIT, String(Date.now()));
    scheduleSyncPush();
  }
}

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

/* ---------- курс валют (ЦБ РФ) и остатки ---------- */

let rates = load(LS.rates, null);

async function fetchRates() {
  if (rates && Date.now() - rates.fetched < 6 * 3600e3) return;
  try {
    const r = await fetch("https://www.cbr-xml-daily.ru/daily_json.js");
    const j = await r.json();
    const map = {};
    for (const [k, v] of Object.entries(j.Valute)) map[k] = v.Value / v.Nominal;
    rates = { fetched: Date.now(), date: (j.Date || "").slice(0, 10),
              src: "ЦБ РФ", map };
  } catch {
    try {
      // запасной источник, если ЦБ недоступен
      const r = await fetch("https://open.er-api.com/v6/latest/RUB");
      const j = await r.json();
      const map = {};
      for (const [k, v] of Object.entries(j.rates || {})) {
        if (v > 0) map[k] = 1 / v;
      }
      rates = { fetched: Date.now(),
                date: (j.time_last_update_utc || "").slice(5, 16),
                src: "er-api", map };
    } catch { return; /* совсем нет сети — остаёмся на кэше */ }
  }
  save(LS.rates, rates);
  renderAll();
}

function rate(cur) {
  if (!cur || cur === "RUB") return 1;
  return rates?.map?.[cur === "USDT" ? "USD" : cur] ?? null;
}

/* операции в валюте (наличные) пересчитываем в ₽ для статистики */
const amountRub = (t) => {
  const a = amountOf(t);
  if (!t.cur || t.cur === "RUB") return a;
  const r = rate(t.cur);
  return r ? Math.round(a * r * 100) / 100 : 0;
};

/* id ручной операции — "m" + timestamp в base36; по нему считаем,
   какие операции добавлены после последней правки остатков */
const tsOf = (t) => parseInt((t.id || "").slice(1), 36) || 0;

/* банк округляет каждую карточную трату вверх до кратных 100 ₽,
   разница уходит в Инвесткопилку — считаем это и для ручных операций */
function roundupOf(t) {
  if (!roundupOn || (t.src || "account") !== "account" || t.amount >= 0) {
    return 0;
  }
  const kind = (catById(effectiveCat(t)) || {}).kind || "spending";
  if (kind !== "spending") return 0;
  const cents = Math.round(-t.amount * 100);
  return ((10000 - (cents % 10000)) % 10000) / 100;
}

function accountState() {
  const base = load(LS.account, null);
  let balance = base?.amt ?? META.balance ?? 0;
  const asOf = base?.asOf ?? 0;
  let kopilka = 0;
  for (const t of manualTxs) {
    if ((t.src || "account") !== "account" || tsOf(t) <= asOf) continue;
    const ru = roundupOf(t);
    balance += t.amount - ru;
    kopilka += ru;
  }
  return { balance: Math.round(balance * 100) / 100,
           kopilka: Math.round(kopilka * 100) / 100 };
}

const accountBalance = () => accountState().balance;

function cashBalances() {
  const out = {};
  for (const [cur, e] of Object.entries(load(LS.cash, {}))) {
    out[cur] = { amt: e.amt, asOf: e.asOf || 0 };
  }
  for (const t of manualTxs) {
    if ((t.src || "account") !== "cash") continue;
    const cur = t.cur || "RUB";
    const e = out[cur] || (out[cur] = { amt: 0, asOf: 0 });
    if (tsOf(t) > e.asOf) e.amt = Math.round((e.amt + t.amount) * 100) / 100;
  }
  return out;
}

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

/* ---------- «Мои деньги» ---------- */

function renderMoney() {
  const box = $("#moneyRows");
  box.textContent = "";
  const row = (lbl, valNode, cls) => {
    const r = el("div", "money-row" + (cls ? " " + cls : ""));
    r.append(el("span", "m-lbl", lbl));
    const v = el("span", "m-val");
    if (typeof valNode === "string") v.textContent = valNode;
    else v.append(...valNode);
    r.append(v);
    box.append(r);
  };

  const { balance: acc, kopilka } = accountState();
  row("На счету Т-Банка", rub0(acc));
  if (kopilka > 0) {
    row("Ушло в копилку округлениями", "+" + rub(kopilka));
  }
  let total = acc;
  let noRate = false;

  const cash = cashBalances();
  const curs = Object.keys(cash).filter((c) => Math.abs(cash[c].amt) > 0.004)
    .sort((a, b) => (a === "RUB" ? -1 : b === "RUB" ? 1 : a.localeCompare(b)));
  if (!curs.length) {
    row("Наличные", "не указаны — ✎ Остатки");
  }
  for (const cur of curs) {
    const amt = cash[cur].amt;
    if (cur === "RUB") {
      total += amt;
      row("Наличные ₽", rub0(amt));
    } else {
      const r = rate(cur);
      const inRub = r ? amt * r : null;
      if (inRub != null) total += inRub; else noRate = true;
      const parts = [document.createTextNode(
        `${fmtMoney.format(amt)} ${fxSym(cur)}`)];
      if (inRub != null) parts.push(el("span", "approx", `≈ ${rub0(inRub)}`));
      row(`Наличные ${fxSym(cur)}`, parts);
    }
  }
  row("Итого", `≈ ${rub0(total)}`, "total");

  $("#rateNote").textContent = rates
    ? `курс ${rates.src || "ЦБ РФ"} на ${rates.date}` +
      (noRate ? " · для части валют курса нет, они не в итоге" : "")
    : "курс валют пока не загрузился — валютные наличные не в итоге";
}

function openCashForm() {
  const body = $("#catSheetBody");
  body.textContent = "";
  body.append(el("h3", "", "Остатки денег"));
  body.append(el("div", "sub",
    "Укажите, сколько денег сейчас. Операции, добавленные после, " +
    "будут менять эти цифры автоматически."));

  const form = el("div", "form-grid");
  form.style.marginTop = "14px";

  const accWrap = el("div");
  accWrap.append(el("label", "", "На счету, ₽"));
  const accIn = el("input");
  accIn.type = "number";
  accIn.step = "0.01";
  accIn.value = Math.round(accountBalance() * 100) / 100;
  accWrap.append(accIn);
  form.append(accWrap);

  const cashWrap = el("div");
  cashWrap.append(el("label", "", "Наличные"));
  const rowsBox = el("div");
  cashWrap.append(rowsBox);
  const mkRow = (cur, amt) => {
    const r = el("div", "cash-row");
    const sel = el("select");
    for (const [code, sym] of FX_CURRENCIES) {
      const o = el("option", "", code === sym ? code : `${code} ${sym}`);
      o.value = code;
      sel.append(o);
    }
    sel.value = cur;
    const inp = el("input");
    inp.type = "number";
    inp.step = "0.01";
    inp.placeholder = "Сколько";
    if (amt !== undefined) inp.value = amt;
    r.append(sel, inp);
    rowsBox.append(r);
  };
  const cash = cashBalances();
  const existing = Object.keys(cash).filter((c) => cash[c].amt !== 0)
    .sort((a, b) => (a === "RUB" ? -1 : 1));
  if (existing.length) {
    for (const cur of existing) mkRow(cur, Math.round(cash[cur].amt * 100) / 100);
  } else {
    mkRow("RUB");
  }
  const addBtn = el("button", "btn", "＋ Ещё валюта");
  addBtn.onclick = () => mkRow("USD");
  cashWrap.append(addBtn);
  form.append(cashWrap);
  body.append(form);

  const actions = el("div", "sheet-actions");
  const ok = el("button", "btn primary", "Сохранить");
  ok.onclick = () => {
    const now = Date.now();
    const accAmt = parseFloat(accIn.value);
    if (!Number.isNaN(accAmt)) save(LS.account, { amt: accAmt, asOf: now });
    const cashOut = {};
    rowsBox.querySelectorAll(".cash-row").forEach((r) => {
      const cur = r.querySelector("select").value;
      const amt = parseFloat(r.querySelector("input").value);
      if (!Number.isNaN(amt)) {
        cashOut[cur] = { amt: (cashOut[cur]?.amt || 0) + amt, asOf: now };
      }
    });
    save(LS.cash, cashOut);
    closeSheets();
    toast("Остатки обновлены");
    renderAll();
  };
  actions.append(ok);
  body.append(actions);
  openSheet("#catSheet");
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
    .reduce((s, t) => s - amountRub(t), 0);
  const inn = list.filter((t) => t.amount > 0)
    .reduce((s, t) => s + amountRub(t), 0);

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
      .reduce((s, t) => s + amountRub(t), 0);
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

}

/* В режиме трат суммы нетто: плюсовые возмещения вычитаются из категории */
function groupSum(list, net = state.kind === "spending") {
  const m = new Map();
  for (const t of list) {
    const v = net ? -amountRub(t) : Math.abs(amountRub(t));
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

  if (!list.length) {
    svg.setAttribute("height", 0);
    const lg = $("#legend");
    lg.textContent = "";
    lg.append(el("span", "key", "Пока нет операций за этот период"));
    return;
  }

  // месяц × категория → сумма (по модулю)
  const perMonth = new Map();
  for (const m of monthsInData) perMonth.set(m, new Map());
  const netMode = state.kind === "spending";
  for (const t of list) {
    const mm = perMonth.get(t.date.slice(0, 7));
    if (mm) {
      mm.set(t.ecat, (mm.get(t.ecat) || 0) +
        (netMode ? -amountRub(t) : Math.abs(amountRub(t))));
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
    const foreign = t.cur && t.cur !== "RUB";
    mid.append(el("div", "tx-cat", (c.name || t.ecat) +
      (f ? ` → ${fxStr(f)}` : "") +
      (foreign ? ` · ≈ ${rub0(amountRub(t))}` : "") +
      (t.manual ? " · вручную" : "")));
    row.append(mid);
    const amt = amountOf(t);
    row.append(el("div", "tx-amt" + (amt > 0 ? " pos" : ""),
      (amt > 0 ? "+" : "") +
      (foreign ? `${fmtMoney.format(amt)} ${fxSym(t.cur)}` : rub(amt))));
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
  const foreign = t.cur && t.cur !== "RUB";
  body.append(el("div", "big-amt" + (amt > 0 ? " pos" : ""),
    (amt > 0 ? "+" : "") +
    (foreign ? `${fmtMoney.format(amt)} ${fxSym(t.cur)}` : rub(amt))));
  if (foreign) body.append(el("div", "sub", `≈ ${rub0(amountRub(t))} по курсу ЦБ`));
  if (roundupOn && t.ru) {
    body.append(el("div", "sub",
      `включая ${rub(t.ru)} округления в Инвесткопилку (сама покупка ${rub(-t.amount)})`));
  }
  const mru = t.manual ? roundupOf(t) : 0;
  if (mru > 0) {
    body.append(el("div", "sub",
      `со счёта спишется ${rub(-t.amount + mru)}: ` +
      `${rub(-t.amount)} трата + ${rub(mru)} в копилку округлением`));
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
    "Хранится в этом браузере и меняет остаток счёта или наличных"));

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

  const amtIn = f("Сумма", el("input"));
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

  const srcSel = f("Откуда", el("select"));
  for (const [v, n] of [["account", "Счёт (карта), ₽"], ["cash", "Наличные"]]) {
    const o = el("option", "", n);
    o.value = v;
    srcSel.append(o);
  }
  const curSel = f("Валюта наличных", el("select"));
  for (const [code, sym] of FX_CURRENCIES) {
    const o = el("option", "", code === sym ? code : `${code} ${sym}`);
    o.value = code;
    curSel.append(o);
  }
  curSel.value = "RUB";
  curSel.parentElement.hidden = true;
  srcSel.onchange = () => {
    curSel.parentElement.hidden = srcSel.value !== "cash";
  };

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
      src: srcSel.value,
      cur: srcSel.value === "cash" ? curSel.value : "RUB",
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
$("#cashBtn").onclick = openCashForm;
$("#triageBtn").onclick = startTriage;
$("#roundupToggle").onchange = (e) => {
  roundupOn = e.target.checked;
  save(LS.roundup, roundupOn);
  renderAll();
};

/* ---------- CSV ---------- */

$("#csvBtn").onclick = () => {
  const list = filtered().sort((a, b) => a.date.localeCompare(b.date));
  let csv = "﻿Дата;Время;Сумма ₽;Округление;Категория;Валюта;Описание\n";
  for (const t of list) {
    const c = catById(t.ecat) || {};
    const f = fxMap[txKey(t)];
    const native = t.cur && t.cur !== "RUB" ? `${t.amount} ${t.cur}`
      : f ? `${f.amt} ${f.cur}` : "";
    const ruCsv = roundupOn ? (t.ru || (t.manual ? roundupOf(t) : 0)) : 0;
    csv += `${t.date};${t.time || ""};${String(amountRub(t)).replace(".", ",")};` +
      `${ruCsv ? String(ruCsv).replace(".", ",") : ""};` +
      `${c.name || ""};${native};` +
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
  const f = (d) => {
    const [y, m, dd] = d.split("-");
    return `${Number(dd)} ${MONTHS_SHORT[Number(m) - 1]} ${y}`;
  };
  const dates = txs.map((t) => t.date);
  if (dates.length) {
    const first = dates.reduce((a, b) => (a < b ? a : b));
    const last = dates.reduce((a, b) => (a > b ? a : b));
    $("#periodNote").textContent =
      first === last ? f(first) : `${f(first)} — ${f(last)}`;
  } else {
    $("#periodNote").textContent = META.balanceDate
      ? `учёт с ${f(META.balanceDate)}` : "";
  }
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
  renderMoney();
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

let stateKey = null; // тот же ключ шифрует слепок настроек для синхронизации

async function decryptData(password) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(ENC_DATA.salt), iterations: ENC_DATA.iter,
      hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["decrypt", "encrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(ENC_DATA.iv) }, key, b64(ENC_DATA.ct));
  stateKey = key;
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ---------- синхронизация между устройствами через GitHub ----------
   Слепок настроек (операции, категории, остатки) шифруется тем же ключом,
   что и данные, и кладётся коммитом в этот же репозиторий: state.enc.json.
   Устройства сверяются по updatedAt — побеждает последняя запись. */

const SYNC_PATH = "state.enc.json";
const SYNC_BRANCH = "sync-state"; // отдельная ветка, чтобы не дёргать Pages
const REPO = localStorage.getItem("fin.syncRepo") || (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : "nikolai-third/finance";
})();

let syncSha = null;
let syncTimer = null;
let syncBusy = false;

const ghToken = () => (localStorage.getItem(LS_TOKEN) || "").trim();

function setSyncStatus(cls, note) {
  const b = $("#syncBtn");
  b.className = "sync-btn " + cls;
  b.dataset.note = note || "";
}

function b64e(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function collectState() {
  const s = { updatedAt: Number(localStorage.getItem(LS_LASTEDIT) || 0) };
  for (const k of SYNC_KEYS) s[k] = load(k, null);
  return s;
}

function applyState(s) {
  suppressSync = true;
  try {
    for (const k of SYNC_KEYS) {
      if (s[k] === null || s[k] === undefined) localStorage.removeItem(k);
      else save(k, s[k]);
    }
  } finally { suppressSync = false; }
  customCats = load(LS.cats, []);
  catEdits = load(LS.catEdits, {});
  overrides = load(LS.overrides, {});
  fxMap = load(LS.fx, {});
  manualTxs = load(LS.manual, []);
  roundupOn = load(LS.roundup, true);
  $("#roundupToggle").checked = roundupOn;
  rebuildTxs();
}

async function encryptState(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, stateKey,
    new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, iv: b64e(iv), ct: b64e(ct), updatedAt: obj.updatedAt };
}

async function decryptState(file) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(file.iv) }, stateKey, b64(file.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

const ghHeaders = () => ({
  Authorization: "Bearer " + ghToken(),
  Accept: "application/vnd.github+json",
});

async function ghGetState() {
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${SYNC_PATH}?ref=${SYNC_BRANCH}`,
    { headers: ghHeaders(), cache: "no-store" });
  if (r.status === 404) { syncSha = null; return null; }
  if (!r.ok) throw new Error("GitHub " + r.status);
  const j = await r.json();
  syncSha = j.sha;
  return JSON.parse(atob(j.content.replace(/\s/g, "")));
}

async function ghEnsureBranch() {
  const head = await fetch(
    `https://api.github.com/repos/${REPO}/git/refs/heads/${SYNC_BRANCH}`,
    { headers: ghHeaders() });
  if (head.ok) return;
  const main = await fetch(
    `https://api.github.com/repos/${REPO}/git/refs/heads/main`,
    { headers: ghHeaders() });
  if (!main.ok) throw new Error("GitHub " + main.status);
  const sha = (await main.json()).object.sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/refs`, {
    method: "POST", headers: ghHeaders(),
    body: JSON.stringify({ ref: `refs/heads/${SYNC_BRANCH}`, sha }),
  });
  if (!r.ok && r.status !== 422) throw new Error("GitHub " + r.status);
}

async function ghPutState(file, firstTry = true) {
  const body = { message: "Синхронизация", branch: SYNC_BRANCH,
                 content: btoa(JSON.stringify(file)) };
  if (syncSha) body.sha = syncSha;
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${SYNC_PATH}`,
    { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
  if (r.status === 404 && firstTry) { // ветки ещё нет — создаём
    await ghEnsureBranch();
    return ghPutState(file, false);
  }
  if (r.status === 409 || r.status === 422) return false; // кто-то успел раньше
  if (!r.ok) throw new Error("GitHub " + r.status);
  syncSha = (await r.json()).content.sha;
  return true;
}

async function syncNow(retry = true) {
  if (!ghToken() || !stateKey || syncBusy) return;
  syncBusy = true;
  setSyncStatus("syncing");
  try {
    const remote = await ghGetState();
    const lastEdit = Number(localStorage.getItem(LS_LASTEDIT) || 0);
    if (remote && remote.ct && remote.updatedAt > lastEdit) {
      const s = await decryptState(remote);
      applyState(s);
      localStorage.setItem(LS_LASTEDIT, String(remote.updatedAt));
      renderAll();
      toast("Данные обновлены с другого устройства");
    } else if (lastEdit > (remote?.updatedAt || 0)) {
      const ok = await ghPutState(await encryptState(collectState()));
      if (!ok && retry) {
        syncBusy = false;
        return syncNow(false);
      }
    }
    localStorage.setItem("fin.lastSync", String(Date.now()));
    setSyncStatus("ok");
  } catch (e) {
    setSyncStatus("error",
      e.name === "OperationError"
        ? "Слепок зашифрован другим паролем"
        : e.message);
  } finally { syncBusy = false; }
}

function scheduleSyncPush() {
  if (!ghToken()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 4000);
}

let lastVisSync = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" &&
      Date.now() - lastVisSync > 30000) {
    lastVisSync = Date.now();
    syncNow();
  }
});

function openSyncForm() {
  const body = $("#catSheetBody");
  body.textContent = "";
  body.append(el("h3", "", "Синхронизация устройств"));
  body.append(el("div", "sub",
    "Зашифрованный слепок операций, категорий и остатков хранится коммитами " +
    "в вашем же репозитории GitHub. Прочитать его можно только с паролем от сайта."));

  const form = el("div", "form-grid");
  form.style.marginTop = "14px";
  const w = el("div");
  w.append(el("label", "", "Токен GitHub (нужен один раз на устройство)"));
  const tokIn = el("input");
  tokIn.type = "password";
  tokIn.placeholder = "ghp_…";
  tokIn.value = ghToken();
  w.append(tokIn);
  form.append(w);

  const help = el("div", "sub");
  help.append(document.createTextNode("Создать: "));
  const a = el("a", "", "github.com/settings/tokens/new");
  a.href = "https://github.com/settings/tokens/new?scopes=repo&description=finance-sync";
  a.target = "_blank";
  a.style.color = "var(--accent)";
  help.append(a, document.createTextNode(
    " → галка «repo» уже стоит → Generate token → вставьте сюда. " +
    "Токен остаётся только в этом браузере."));
  form.append(help);
  body.append(form);

  const st = el("div", "sync-status");
  const last = Number(localStorage.getItem("fin.lastSync") || 0);
  const note = $("#syncBtn").dataset.note;
  if ($("#syncBtn").classList.contains("error")) {
    st.className = "sync-status error";
    st.textContent = "Ошибка: " + (note || "не удалось синхронизироваться");
  } else if (ghToken() && last) {
    st.className = "sync-status ok";
    st.textContent = "Работает · последняя синхронизация " +
      new Date(last).toLocaleString("ru-RU");
  } else {
    st.textContent = "Пока не настроено на этом устройстве";
  }
  body.append(st);

  const actions = el("div", "sheet-actions");
  if (ghToken()) {
    const off = el("button", "btn danger", "Отключить");
    off.onclick = () => {
      localStorage.removeItem(LS_TOKEN);
      setSyncStatus("off");
      closeSheets();
      toast("Синхронизация отключена");
    };
    actions.append(off);
  }
  const ok = el("button", "btn primary", "Сохранить и синхронизировать");
  ok.onclick = async () => {
    const tok = tokIn.value.trim();
    if (!tok) { tokIn.focus(); return; }
    localStorage.setItem(LS_TOKEN, tok);
    closeSheets();
    await syncNow();
    toast($("#syncBtn").classList.contains("ok")
      ? "Синхронизация работает" : "Не получилось — смотри статус");
  };
  actions.append(ok);
  body.append(actions);
  openSheet("#catSheet");
}

$("#syncBtn").onclick = openSyncForm;

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
  fetchRates();
  // данные, накопленные до появления синка, считаем свежей правкой —
  // иначе пустое устройство могло бы затереть их своим пустым слепком
  if (!localStorage.getItem(LS_LASTEDIT) &&
      SYNC_KEYS.some((k) => localStorage.getItem(k) !== null)) {
    localStorage.setItem(LS_LASTEDIT, String(Date.now()));
  }
  if (ghToken()) syncNow();
  else setSyncStatus("off");
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
