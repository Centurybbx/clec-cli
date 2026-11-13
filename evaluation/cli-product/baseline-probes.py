#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path

binary = Path.home()/'.cache/clec/runs/portable-cli-20261113/blind/install/node_modules/.bin/clec'
data = Path.home()/'.cache/clec/runs/portable-cli-20261113/verification/relocated-data'
out = Path.home()/'.cache/clec/runs/cli-product-20261113/evaluation/baseline-development.jsonl'
queries = ['關於 clec.md', 'clec.md 原始素材 知識庫', '資產配置 終極問題 00575', '現金是空氣 上班 生活費', '聰明再平衡 先看這裡', '再平衡 工作收入 退休', 'Rental Property Index Funds retirement', '2018 實體課程 IRR 十萬 十五年', 'IRA 放空 IRS 官方', '00335B 退休金 年開銷']
with out.open('w') as log:
    for i, query in enumerate(queries, 1):
        argv = [str(binary), 'search', query, '--limit', '5', '--data-dir', str(data)]
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        log.write(json.dumps({'id':f'D{i:02}', 'argv':argv[1:], 'exit':proc.returncode, 'stdout':proc.stdout, 'stderr':proc.stderr}, ensure_ascii=False)+'\n')
print(out)
