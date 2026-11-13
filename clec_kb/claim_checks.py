"""Conservative checks for candidate claims; a pass is not an entailment proof."""
from __future__ import annotations

import re
from .core import normalize


def check_claim(evidence_text: str, quote: str, claim: str):
    if not quote.strip() or not claim.strip():
        raise ValueError('引文和主张均不能为空')
    warnings=[]
    if quote not in evidence_text:
        warnings.append('引文不是该证据片段中连续、逐字相同的文字')
    q=normalize(quote); c=normalize(claim)
    conditions=re.findall(r'(?:如果|假如|假设|除非)[^，,。.!?！？\n]{2,100}[，,]',q)
    for condition in conditions:
        condition=condition.rstrip('，,').strip()
        if condition not in c:
            warnings.append('原文条件可能遗漏：'+condition)
    for word in ('尽量','可能','至少','最多','不一定','除非','超过','未必','不可以','不能','没有'):
        if word in q and word not in c:
            warnings.append('原文限定或否定词可能遗漏：'+word)
    quote_numbers=set(re.findall(r'(?<![a-z0-9])\d+(?:\.\d+)?%?(?:[a-z])?',q))
    claim_numbers=set(re.findall(r'(?<![a-z0-9])\d+(?:\.\d+)?%?(?:[a-z])?',c))
    if claim_numbers-quote_numbers:
        warnings.append('主张中的数字或代码未在引文中原样出现：'+', '.join(sorted(claim_numbers-quote_numbers)))
    if quote_numbers-claim_numbers:
        warnings.append('引文中有数字或代码未在主张中出现，需确认是否重要：'+', '.join(sorted(quote_numbers-claim_numbers)))
    return {'quote_exact':quote in evidence_text,'warnings':warnings,
            'status':'needs_review' if warnings else 'no_mechanical_warning',
            'note':'机械检查不能判断主张是否被引文支持，也不能验证转写、讲者和完整上下文；必须由 Agent 逐项核对。'}
