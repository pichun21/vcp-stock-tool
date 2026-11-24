import requests,io,pandas as pd
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
r=requests.get("https://equibles.com/indexes/russell-2000.csv",headers=UA,timeout=60)
print("CSV",r.status_code,len(r.text),repr(r.text[:400]))
try:
    d=pd.read_csv(io.StringIO(r.text)); print("CSVDF",d.shape,list(d.columns)); print(d.head(3).to_string())
except Exception as e: print("CSVERR",e)
h=requests.get("https://equibles.com/indexes/russell-2000",headers=UA,timeout=60).text
for i,t in enumerate(pd.read_html(io.StringIO(h))): print("TABLE",i,t.shape,list(t.columns)[:8])
