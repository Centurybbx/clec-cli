"""Repeatable end-to-end checks against manually selected, real source passages."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES = [
    {'question':'00575 中，退休后质押借款时现金有什么作用？','query':'00575',
     'source':'clectw:short-00575','need':['來信內容','老師回覆','高過你的欠款']},
    {'question':'00318 对 54 岁来信者的回复有什么条件？','query':'00318',
     'source':'clectw:short-00318','need':['一半是美元放在香港','一半是臺幣','沒有稅務問題']},
    {'question':'00153 中的 2.6% 利率是谁提出的？','query':'00153',
     'source':'clectw:short-00153','need':['email 來信分享','利息 2.6%']},
]


def command(*args):
    p=subprocess.run([sys.executable,'-m','clec_kb',*args],cwd=ROOT,text=True,capture_output=True,check=True)
    return json.loads(p.stdout)


def main():
    output=[]
    for case in CASES:
        found=command('search',case['query'],'--type','transcript','--limit','30')
        hit=next((x for x in found['results'] if x['source_id']==case['source']),None)
        if hit is None: raise AssertionError('未找到预期来源：'+case['source'])
        expanded=command('read',hit['evidence_id'],'--context','1')
        if expanded['source']['file_status']!='verified': raise AssertionError('文件校验失败')
        evidence_for_context = {}
        for s in case['need']:
            supporting = next((c['evidence_id'] for c in expanded['chunks'] if s in c['text']), None)
            if supporting is None: raise AssertionError('缺少关键上下文：'+s)
            evidence_for_context[s] = supporting
        output.append({'question':case['question'],'query':case['query'],'source':case['source'],
                       'retrieval_evidence_id':hit['evidence_id'], 'evidence_for_context':evidence_for_context,
                       'file_status':'verified','required_context_found':True})
    same=command('search','一位台湾朋友学习投资问道之旅','--limit','100')
    ids={x['source_id'] for x in same['results']}
    assert {'clectw:short-00152','clectw:short-00153'}.issubset(ids), '同名不同文被丢失'
    spaced=command('search','54岁 50倍','--limit','100')
    assert any(x['source_id']=='clectw:short-00318' for x in spaced['results']), '数字和单位间空格导致漏检'
    absent=command('search','星际橙子独角兽基金','--limit','5')
    assert not absent['results'], '虚构名称搜索出现结果，应人工检查'
    quote='如果您打算在臺灣生活，且資金將回到臺灣而沒有稅務問題，香港的資金可以匯回臺灣，我建議全部匯回臺灣。'
    check=command('check-claim','4cbd65ed6394d10f6ca59dae','--quote',quote,'--claim','老師建議將資金匯回臺灣。')
    assert check['quote_exact'] and check['status']=='needs_review', '未提示税务等条件遗漏'
    output.append({'test':'同名不同正文','pass':True})
    output.append({'test':'数字与单位间空格','pass':True})
    output.append({'test':'虚构名称关键词搜索','hits':0,'conclusion':'仅证明该检索词无命中，不证明资料库之外不存在'})
    output.append({'test':'真实摘要遗漏条件','status':check['status'],'warnings':check['warnings']})
    print(json.dumps(output,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
