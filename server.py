#!/usr/bin/env python3
"""期權羅盤 — 台指選擇權籌碼分析系統（後端）

純標準函式庫，無需安裝套件：
    python3 server.py            # 預設 http://localhost:8765
    PORT=9000 python3 server.py

資料來源（皆為公開資料）：
  - 盤後未平倉 / 三大法人：FinMind 開放資料 API（資料源自臺灣期貨交易所）
  - 盤中即時報價（含夜盤）：臺灣期貨交易所行情資訊網
可選環境變數 FINMIND_TOKEN：填入後可提高 API 配額。
"""
import calendar
import datetime as dt
import json
import os
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
os.makedirs(DATA, exist_ok=True)

FINMIND = "https://api.finmindtrade.com/api/v4/data"
MIS = "https://mis.taifex.com.tw/futures/api/"
TPE = dt.timezone(dt.timedelta(hours=8))
EOD_TTL = 30 * 60
LIVE_TTL = 10


def now_tpe():
    return dt.datetime.now(TPE)


def http(url, body=None, headers=None, timeout=60):
    """GET/POST，回傳 bytes。urllib 憑證有問題時改用 curl。"""
    headers = dict(headers or {})
    headers.setdefault("User-Agent", "Mozilla/5.0 (options-dashboard)")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception:
        cmd = ["curl", "-s", "--fail", "-m", str(timeout), url]
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
        if data is not None:
            cmd += ["--data-binary", data.decode()]
        return subprocess.run(cmd, capture_output=True, check=True).stdout


def finmind(dataset, data_id, start):
    q = {"dataset": dataset, "data_id": data_id, "start_date": start}
    headers = {}
    token = os.environ.get("FINMIND_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    j = json.loads(http(FINMIND + "?" + urllib.parse.urlencode(q), headers=headers, timeout=120))
    if j.get("status") != 200:
        raise RuntimeError(f"FinMind {dataset}: {j.get('msg')}")
    return j["data"]


# ---------- 合約到期日 ----------
def nth_weekday(year, month, weekday, n):
    days = [d for d in calendar.Calendar().itermonthdates(year, month)
            if d.month == month and d.weekday() == weekday]
    return days[min(n, len(days)) - 1]


def expiry_of(code):
    """202611 → 第三個週三；202611W4 → 第四個週三；202611F3 → 第三個週五。"""
    y, m, suf = int(code[:4]), int(code[4:6]), code[6:]
    if not suf:
        return nth_weekday(y, m, 2, 3)
    wd = 2 if suf[0] == "W" else 4
    return nth_weekday(y, m, wd, int(suf[1:]))


def contract_label(code):
    suf = code[6:]
    kind = "月選" if not suf else ("週三選" if suf[0] == "W" else "週五選")
    e = expiry_of(code)
    return f"{kind} {e.month}/{e.day} 結算"


# ---------- 盤後資料 ----------
def build_eod():
    today = now_tpe().date()
    rows = []
    for back in (8, 16):
        rows = [r for r in finmind("TaiwanOptionDaily", "TXO", str(today - dt.timedelta(days=back)))
                if r["trading_session"] == "position"]
        dates = sorted({r["date"] for r in rows})
        if len(dates) >= 2:
            break
    if not rows:
        raise RuntimeError("查無選擇權盤後資料")
    D = dates[-1]
    P = dates[-2] if len(dates) > 1 else None

    def table(date):
        t = {}
        for r in rows:
            if r["date"] == date:
                t[(r["contract_date"], r["strike_price"], r["call_put"])] = r
        return t

    cur, prev = table(D), (table(P) if P else {})
    contracts = {}
    for (code, k, cp), r in cur.items():
        s = contracts.setdefault(code, {}).setdefault(k, [k, 0, 0, 0, 0, 0, 0, 0, 0])
        off = 1 if cp == "call" else 5
        p = prev.get((code, k, cp))
        s[off] = r["open_interest"]
        s[off + 1] = r["open_interest"] - (p["open_interest"] if p else 0)
        s[off + 2] = r["volume"]
        s[off + 3] = r["settlement_price"] or r["close"]
    out_contracts = []
    for code, strikes in contracts.items():
        lst = [v for _, v in sorted(strikes.items()) if v[1] or v[5] or v[3] or v[7]]
        try:
            exp = expiry_of(code)
        except Exception:
            continue
        out_contracts.append({
            "code": code, "expiry": str(exp), "label": contract_label(code),
            "total_oi": sum(v[1] + v[5] for v in lst), "strikes": lst,
        })
    out_contracts.sort(key=lambda c: (c["expiry"], c["code"]))

    pc = {}
    for r in rows:
        d = pc.setdefault(r["date"], {"date": r["date"], "call_oi": 0, "put_oi": 0})
        d["call_oi" if r["call_put"] == "call" else "put_oi"] += r["open_interest"]
    pc_trend = []
    for d in sorted(pc.values(), key=lambda x: x["date"]):
        d["ratio"] = round(d["put_oi"] / d["call_oi"], 4) if d["call_oi"] else None
        pc_trend.append(d)

    start45 = str(today - dt.timedelta(days=45))
    fut = {}
    for r in finmind("TaiwanFuturesDaily", "TX", start45):
        if r["trading_session"] != "position" or "/" in r["contract_date"]:
            continue
        b = fut.get(r["date"])
        if b is None or r["volume"] > b["v"]:
            fut[r["date"]] = {"date": r["date"], "o": r["open"], "h": r["max"], "l": r["min"],
                              "c": r["close"], "v": r["volume"], "oi": r["open_interest"]}

    def who(name):
        return "foreign" if name.startswith("外資") else ("trust" if name.startswith("投信") else "dealer")

    inst_fut = {}
    for r in finmind("TaiwanFuturesInstitutionalInvestors", "TX", start45):
        d = inst_fut.setdefault(r["date"], {"date": r["date"]})
        d[who(r["institutional_investors"])] = (
            r["long_open_interest_balance_volume"] - r["short_open_interest_balance_volume"])
    inst_opt = {}
    for r in finmind("TaiwanOptionInstitutionalInvestors", "TXO", start45):
        d = inst_opt.setdefault(r["date"], {"date": r["date"]})
        w = d.setdefault(who(r["institutional_investors"]), {})
        side = "c" if r["call_put"] in ("買權", "call") else "p"
        w["b" + side] = r["long_open_interest_balance_amount"]
        w["s" + side] = r["short_open_interest_balance_amount"]
        w["b" + side + "_v"] = r["long_open_interest_balance_volume"]
        w["s" + side + "_v"] = r["short_open_interest_balance_volume"]

    return {
        "asof": D, "prev": P, "generated": now_tpe().isoformat(timespec="seconds"),
        "contracts": out_contracts, "pc_trend": pc_trend,
        "fut": [fut[k] for k in sorted(fut)],
        "inst_fut": [inst_fut[k] for k in sorted(inst_fut)],
        "inst_opt": [inst_opt[k] for k in sorted(inst_opt)],
    }


_eod = {"data": None, "ts": 0, "busy": False, "err": None}
_eod_lock = threading.Lock()
EOD_FILE = os.path.join(DATA, "eod.json")


def _refresh_eod():
    try:
        d = build_eod()
        with open(EOD_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        _eod.update(data=d, ts=time.time(), err=None)
    except Exception as e:  # 保留舊資料
        _eod.update(err=str(e), ts=time.time() - EOD_TTL + 60)
    finally:
        _eod["busy"] = False


def get_eod():
    with _eod_lock:
        if _eod["data"] is None and os.path.exists(EOD_FILE):
            try:
                with open(EOD_FILE, encoding="utf-8") as f:
                    _eod["data"] = json.load(f)
                _eod["ts"] = os.path.getmtime(EOD_FILE)
            except Exception:
                pass
        stale = time.time() - _eod["ts"] > EOD_TTL
        if _eod["data"] is None:
            _eod["busy"] = True
            _refresh_eod()
        elif stale and not _eod["busy"]:
            _eod["busy"] = True
            threading.Thread(target=_refresh_eod, daemon=True).start()
    if _eod["data"] is None:
        raise RuntimeError(_eod["err"] or "資料載入失敗")
    return _eod["data"]


# ---------- 即時報價 ----------
_live_cache = {}


def cached(key, ttl, fn):
    hit = _live_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _live_cache[key] = (time.time(), val)
    return val


def mis(path, body):
    j = json.loads(http(MIS + path, body=body, timeout=20))
    if j.get("RtCode") != "0":
        raise RuntimeError(j.get("RtMsg") or "行情來源錯誤")
    return j["RtData"]


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def session_now():
    t = now_tpe()
    hm = t.hour * 60 + t.minute
    if 15 * 60 <= hm or hm < 5 * 60:
        return 1, "夜盤"
    if 5 * 60 <= hm < 8 * 60 + 45:
        return 1, "夜盤（已收盤）"
    if hm < 13 * 60 + 45:
        return 0, "日盤"
    return 0, "日盤（已收盤）"


def fetch_live(code, mt):
    base = {"SymbolType": "O", "KindID": "1", "CID": "TXO", "RowSize": "全部",
            "PageNo": "", "SortColumn": "", "AscDesc": "A"}
    ql = mis("getQuoteListOption", dict(base, MarketType=str(mt), ExpireMonth=code)).get("QuoteList") or []
    quotes = []
    for q in ql:
        last, bid, ask = num(q["CLastPrice"]), num(q["CBidPrice1"]), num(q["CAskPrice1"])
        vol = int(num(q["CTotalVolume"]))
        if not (last or bid or ask or vol):
            continue
        quotes.append([num(q["StrikePrice"]), q["CP"], last, bid, ask, vol, num(q["CRefPrice"])])
    fl = mis("getQuoteList", dict(base, MarketType=str(mt), SymbolType="F", CID="TXF",
                                  ExpireMonth="")).get("QuoteList") or []
    spot, futs = None, []
    for q in fl:
        item = {"name": q["DispCName"], "last": num(q["CLastPrice"]), "ref": num(q["CRefPrice"]),
                "high": num(q["CHighPrice"]), "low": num(q["CLowPrice"]), "open": num(q["COpenPrice"]),
                "vol": int(num(q["CTotalVolume"])), "time": q.get("CTime", "")}
        if q["SymbolID"].startswith("TXF-"):
            spot = item
        elif "/" not in q["SymbolID"] and item["last"]:
            futs.append(item)
    fut = max(futs, key=lambda x: x["vol"]) if futs else None
    return {"quotes": quotes, "fut": fut, "spot": spot if spot and spot["last"] else None}


def get_live(code):
    mt, label = session_now()
    data = cached((code, mt), LIVE_TTL, lambda: fetch_live(code, mt))
    if mt == 1 and not data["fut"]:
        mt, label = 0, "日盤（已收盤）"
        data = cached((code, mt), LIVE_TTL, lambda: fetch_live(code, mt))
    return dict(data, session=label, contract=code, ts=now_tpe().isoformat(timespec="seconds"))


# ---------- HTTP ----------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        try:
            if u.path == "/healthz":
                return self.send_json({"ok": True})
            if u.path == "/api/eod":
                return self.send_json(get_eod())
            if u.path == "/api/live":
                code = urllib.parse.parse_qs(u.query).get("contract", [""])[0]
                if code not in {c["code"] for c in get_eod()["contracts"]}:
                    return self.send_json({"error": "contract 參數錯誤"}, 400)
                return self.send_json(get_live(code))
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    host = os.environ.get("HOST", "127.0.0.1")  # 上線時設 HOST=0.0.0.0
    print(f"期權羅盤已啟動：http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
