# -*- coding: utf-8 -*-
"""Categorize parsed transactions and emit data.js for the web app.

Usage: python3 scripts/categorize.py <transactions.json> <out data.js>
"""
import json
import re
import sys
from collections import defaultdict

# (id, name, emoji, palette slot, kind, [patterns])
# kind: "spending" — реальные траты; "transfer" — перемещения денег (исключаются
# из статистики трат по умолчанию); "income" — поступления/возвраты.
CATEGORIES = [
    ("groceries", "Продукты", "🛒", 2, "spending", [
        r"EVO_PRODUKTY", r"OKEY", r"MIRATORG", r"МИРАТОРГ", r"VKUSVILL",
        r"\bVV_", r"VV_KKM", r"LENTA-", r"PEREKRYOSTOK", r"PEREKRESTOK",
        r"PYATEROCHKA", r"\bSPAR\b", r"SPAR \d", r"SPAR N\d", r"MAGNOLIYA",
        r"SLATA", r"METRO STORE", r"SAMOKAT", r"\bDA S\d", r"PRODUKTY",
        r"Продукты", r"BLIZNECY", r"БЛИЗНЕЦЫ", r"MAGNIT", r"AZBUKA VKUSA",
    ]),
    ("cafe", "Кафе и столовые", "🍜", 8, "spending", [
        r"VERYFOOD", r"STOLOVAYA", r"KULINKA", r"DODO", r"ROSTICS",
        r"vkusnoitochka", r"\bQSR\b", r"TANUKI", r"YANDEX\*EDA", r"eatandsplit",
        r"\bMUNCH\b", r"YapYap", r"CIVI SACIVI", r"KAFE", r"PEKARNYA",
        r"SINNABON", r"KARAVAEV", r"UZ-FOOD", r"ARENA PARK CATERING",
        r"SelfKiosk", r"Селфкиоск", r"TORGOVYE AVTOMATY", r"MIR VENDINGA",
        r"SB_UNICUM", r"UNIKUM", r"UNICUM", r"TERMOLEND", r"CANDY CAT",
        r"KAPITAN MARMELAD", r"BOLTAY", r"\bDali\b", r"BURGER", r"KFC",
    ]),
    ("bars", "Бары и алкоголь", "🍺", 8, "spending", [
        r"RYUMKA", r"Saldens", r"Taphouse", r"BRISTOL", r"WINELAB",
        r"PIVOVARNYA", r"\bBAR\b", r"KARO-OKTYABR- BAR",
    ]),
    ("carsharing", "Каршеринг и самокаты", "🚗", 1, "spending", [
        r"CITYDRIVE", r"DELIMOBIL", r"Yandex\.Drive", r"Y\.M\*DRIVE",
        r"YM \*drive", r"WHOOSH", r"BERIZARYAD", r"BelkaCar",
    ]),
    ("transport", "Транспорт", "🚇", 3, "spending", [
        r"Mos\.Transport", r"СБП для транспорта", r"CPPK", r"STRELKA",
        r"TROYKA", r"KRYUKOVO BP", r"\bBPA\b", r"YANDEX\.RASP", r"RASP\.EL",
        r"NEFTMAGISTRAL", r"YANDEX\*GO", r"YandexGo", r"AEROEXPRESS",
    ]),
    ("shopping", "Шопинг и маркетплейсы", "📦", 5, "spending", [
        r"OZON", r"Wildberries", r"WB\*", r"Yandex\*MARKET", r"market\.yandex",
        r"MVIDEO", r"OSTIN", r"LEONARDO", r"Спортмастер", r"SPORTMASTER",
        r"AtributikaClub", r"kleekstore", r"ggsel", r"FIXPRICE", r"DNS",
    ]),
    ("health", "Здоровье", "💊", 6, "spending", [
        r"APTEKA", r"mskApt", r"STOMATOLOG", r"GEMOTEST", r"Genotek",
        r"DIAGNOSTIK", r"KLINIKA", r"\bAP \d", r"T-Ins\.",
    ]),
    ("beauty", "Красота и уход", "💈", 7, "spending", [
        r"BELYJ OBRAZ", r"SALON KRASOTY", r"AVANESYAN", r"Avanesyan",
        r"BARBER", r"PARIKMAKHER",
    ]),
    ("telecom", "Связь и интернет", "📡", 4, "spending", [
        r"Yota", r"YOTA", r"МТС", r"\bMTS\b", r"mipt-telecom", r"Телеком",
        r"Veesp", r"OBLAKO", r"Сервисы Яндекса", r"MEGAFON", r"BEELINE",
    ]),
    ("fun", "Развлечения", "🎬", 1, "spending", [
        r"okko", r"KARO", r"CINEMASTAR", r"AFISHA", r"RUNCHAR", r"MOSBILET",
        r"SAD KIO", r"BIOSTANCI", r"WUSHU", r"Theory", r"vpoXod", r"KINO",
        r"CONCERT", r"MUZEJ",
    ]),
    ("education", "Учёба и МФТИ", "🎓", 7, "spending", [
        r"MIPT", r"PHYSTECH", r"printmipt", r"KOPIRKA", r"FIZTEKH",
    ]),
    ("gov", "Налоги и госуслуги", "🏛️", 6, "spending", [
        r"GOSUSLUGI", r"NALOG", r"\bMFC\b", r"GIBDD",
    ]),
    ("savings", "Инвестиции и копилка", "🐷", 2, "transfer", [
        r"Инвесткопилк", r"брокерского счета", r"брокерского счёта",
        r"Пополнение брокерского",
    ]),
    ("cash", "Наличные", "💵", 3, "transfer", [
        r"наличных",
    ]),
    ("transfers", "Переводы", "🔁", 5, "transfer", [
        r"[Пп]еревод", r"Пополнение\.", r"Пополнение ", r"СБП", r"Sberbank",
        r"Сбербанк",
    ]),
    ("cashback", "Кэшбэк и возвраты", "🎁", 4, "income", [
        r"Кэшбэк", r"Возврат",
    ]),
    ("other", "Прочее", "❔", 0, "spending", []),
]


def sanitize(desc: str) -> str:
    desc = re.sub(r"\+7\d{6}(\d{4})", r"+7•••••\1", desc)  # phone numbers
    desc = re.sub(r"счёт \d+(\d{4})", r"счёт •••\1", desc)  # account numbers
    desc = re.sub(r"счет \d+(\d{4})", r"счет •••\1", desc)
    return desc


def categorize(desc: str) -> str:
    for cid, _name, _emoji, _slot, _kind, patterns in CATEGORIES:
        for p in patterns:
            if re.search(p, desc, re.IGNORECASE if p.isascii() else 0):
                return cid
    return "other"


def main():
    src, out = sys.argv[1], sys.argv[2]
    txs = json.load(open(src, encoding="utf-8"))
    txs.sort(key=lambda t: (
        tuple(reversed(t["date"].split("."))), t.get("time") or "00:00"))

    rows = []
    for i, t in enumerate(txs):
        d, m, y = t["date"].split(".")
        desc = sanitize(t["description"])
        rows.append({
            "id": i,
            "date": f"{y}-{m}-{d}",
            "time": t.get("time"),
            "amount": t["amount"],
            "desc": desc,
            "cat": categorize(desc),
        })

    by_cat = defaultdict(lambda: [0, 0.0])
    for r in rows:
        by_cat[r["cat"]][0] += 1
        by_cat[r["cat"]][1] += r["amount"]
    print(f"{'category':<14} {'n':>5} {'sum':>14}", file=sys.stderr)
    for cid, (n, s) in sorted(by_cat.items(), key=lambda kv: kv[1][1]):
        print(f"{cid:<14} {n:>5} {s:>14.2f}", file=sys.stderr)
    other = [r["desc"] for r in rows if r["cat"] == "other"]
    print(f"\nuncategorized: {len(other)}", file=sys.stderr)
    for d in sorted(set(other)):
        print("  " + d, file=sys.stderr)

    cats = [
        {"id": cid, "name": name, "emoji": emoji, "slot": slot, "kind": kind,
         "patterns": patterns, "builtin": True}
        for cid, name, emoji, slot, kind, patterns in CATEGORIES
    ]
    with open(out, "w", encoding="utf-8") as f:
        f.write("// Сгенерировано scripts/categorize.py — не редактировать руками\n")
        f.write("const BASE_CATEGORIES = ")
        json.dump(cats, f, ensure_ascii=False)
        f.write(";\nconst TRANSACTIONS = ")
        json.dump(rows, f, ensure_ascii=False)
        f.write(";\n")

    names = {c[0]: c[1] for c in CATEGORIES}
    csv_path = out.rsplit("/", 1)[0] + "/transactions.csv" if "/" in out \
        else "transactions.csv"
    with open(csv_path, "w", encoding="utf-8-sig") as f:
        f.write("Дата;Время;Сумма;Категория;Описание\n")
        for r in rows:
            amount = f'{r["amount"]:.2f}'.replace(".", ",")
            f.write(f'{r["date"]};{r["time"] or ""};{amount};'
                    f'{names[r["cat"]]};"{r["desc"]}"\n')


if __name__ == "__main__":
    main()
