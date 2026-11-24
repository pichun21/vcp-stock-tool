import requests,re
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36","Accept":"text/csv,text/html,application/json,*/*"}
s=requests.Session(); s.headers.update(UA)
def t(name,url,**kw):
    try:
        r=s.get(url,timeout=40,**kw); x=r.text
        print(f"== {name} {r.status_code} len={len(x)} final={r.url}\n{x[:250]!r}")
        return x
    except Exception as e: print("==",name,"ERR",e)
s.get("https://www.ishares.com/us/products/239710/ishares-russell-2000-etf",timeout=40)
t("ishares-cookie","https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund",headers={"Referer":"https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"})
t("ishares-json","https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?tab=all&fileType=json")
h=t("equibles","https://equibles.com/indexes/russell-2000")
if h:
    print("pagelinks:",sorted(set(re.findall(r'href="([^"]*(?:page|csv|export|download)[^"]*)"',h,re.I)))[:20])
    print("rows:",h.count("<tr"))
t("equibles-p2","https://equibles.com/indexes/russell-2000?page=2")
t("vanguard","https://investor.vanguard.com/investment-products/etfs/profile/api/VTWO/portfolio-holding/stock?start=1&count=50")
t("ssga-twok","https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-twok.xlsx")
