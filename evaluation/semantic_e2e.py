"""Small, manually annotated natural-question retrieval and citation check."""
import json
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
CASES=[
 {'question':'退休后用股票借款，为什么还需要保留现金？','source':'clectw:special-00004',
  'need':['真正有風險的','退休','現金']},
 {'question':'打算退休的54岁来信者，资金汇回台湾的前提是什么？','source':'clectw:short-00318',
  'need':['一半是美元放在香港','沒有稅務問題']},
 {'question':'来信者提到借钱利息2.6%，这是谁的计划？','source':'clectw:short-00153',
  'need':['email 來信分享','利息 2.6%']},
 {'question':'2022年关于股票抵押借款是否留现金是怎么说的？','source':'clectw:ep-00288',
  'need':['不應該留現金','Money Market']},
 {'question':'有学员如何向亲朋好友分享投资理念？','source':'clectw:short-00152',
  'need':['RC 留言分享','親朋好友','請他們吃飯']},
]


def command(*args):
    p=subprocess.run([sys.executable,'-m','clec_kb',*args],cwd=ROOT,text=True,capture_output=True,check=True)
    return json.loads(p.stdout)


def main():
    report=[]
    for case in CASES:
        result=command('research',case['question'],'--limit','10')
        ranked=next(((i+1,x) for i,x in enumerate(result['results']) if x['source_id']==case['source']),None)
        if not ranked: raise AssertionError('前 10 个来源缺少人工标注的相关来源: '+case['source'])
        rank,hit=ranked
        if hit['file_status']!='verified':raise AssertionError('引用文件未经校验')
        snippets=[]
        for passage in hit['passages']:
            doc=command('read',passage['evidence_id'],'--context','1')
            snippets.extend(doc['chunks'])
        evidence={}
        for phrase in case['need']:
            found=next((x['evidence_id'] for x in snippets if phrase in x['text']),None)
            if not found:raise AssertionError('找不到关键原文: '+phrase)
            evidence[phrase]=found
        report.append({'question':case['question'],'auto_keyword_query':result['keyword_query'],
                       'source':case['source'],'rank':rank,'retrieval':hit['retrieval'],
                       'file_status':hit['file_status'],'evidence_for_context':evidence})
    absent=command('research','星际橙子独角兽基金何时发行？','--limit','5')
    literal=command('search','星际橙子独角兽基金','--limit','5')
    assert absent['answerability']=='not_assessed' and not literal['results']
    report.append({'question':'星际橙子独角兽基金何时发行？',
                   'semantic_candidates':len(absent['results']),'literal_hits':0,
                   'answerability':absent['answerability'],
                   'required_agent_behavior':'不将相似候选视为名称和发行日期的证据'})
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
