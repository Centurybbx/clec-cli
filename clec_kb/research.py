"""Combine semantic and exact searches into evidence candidates for an Agent."""
from __future__ import annotations

import re
from argparse import Namespace

from .core import normalize
from .cli import search, verify
from .semantic import search_semantic

# Deliberately small domain vocabulary; absence is not evidence of absence.
TERMS = ('退休','现金','质押','股票','借款','借钱','利息','利率','来信','台湾','香港','美元',
         '税务','汇回','再平衡','提领','生活费','资产配置','风险','杠杆','基金','股息','债券')


def keyword_query(question):
    text=normalize(question)
    nums=re.findall(r'(?<!\d)\d+(?:\.\d+)?%?(?:岁|年|倍)?',text)
    words=[x for x in TERMS if x in text]
    # More specific words first; preserve numeric constraints and limit over-constraint.
    specific=[w for w in words if w not in ('股票','退休','基金','风险')]
    selected=(nums[:2]+specific[:4]) or words[:4]
    return ' '.join(dict.fromkeys(selected))


def research(root, db, output, query, limit=10, terms=None, after=None, before=None):
    if not query.strip(): raise ValueError('请输入非空问题')
    exact=terms if terms is not None else keyword_query(query)
    sem=search_semantic(root,db,output,query,limit=50,after=after,before=before)
    lexical=[]
    if exact:
        args=Namespace(query=exact,type=None,source=None,after=after,before=before,limit=50,offset=0,all_passages=False)
        lexical=search(db,args)['results']
    groups={}
    for method, records in [('semantic',sem['results']),('lexical',lexical)]:
        for rank,r in enumerate(records,1):
            key=r['source_id']
            group=groups.setdefault(key,{'source_id':key,'title':r['title'],'type':r['type'],
                                        'quality':r['quality'],'date':r['date'],'date_basis':r['date_basis'],
                                        'path':r['path'],'url':r['url'],'sha256':r['sha256'],
                                        'score':0.0,'retrieval':{},'passages':[]})
            group['score']+=1/(20+rank)
            group['retrieval'][method+'_rank']=rank
            if not any(p['evidence_id']==r['evidence_id'] for p in group['passages']):
                group['passages'].append({'evidence_id':r['evidence_id'],'text':r['text'],
                                          'locator':r['locator'],'method':method})
    results=sorted(groups.values(),key=lambda x:(-x['score'],x['source_id']))[:limit]
    for group in results:
        group['score']=round(group['score'],6)
        group['file_status']=verify(root,group)
    return {'question':query,'keyword_query':exact or None,'answerability':'not_assessed',
            'unknown_date_sources_excluded':sem.get('unknown_date_sources_excluded'),'results':results,
            'note':'候选结果不是答案；相似度和排名不证明内容支持结论。必须 read 每个实际引用片段及上下文；可能漏检。'}
