#!/usr/bin/env python3
"""Run synthetic controls for RRF and one-result-per-query round-robin selection."""

from collections import deque
from fractions import Fraction


def rrf(lanes):
    scores = {}
    best_ranks = {}
    for lane in lanes:
        for rank, passage in enumerate(lane, start=1):
            scores[passage] = scores.get(passage, Fraction(0)) + Fraction(1, 60 + rank)
            best_ranks[passage] = min(best_ranks.get(passage, rank), rank)
    return sorted(scores, key=lambda passage: (-scores[passage], best_ranks[passage], passage))


def round_robin(lanes):
    pending = deque(iter(lane) for lane in dict.fromkeys(map(tuple, lanes)))
    seen = set()
    while pending:
        lane = pending.popleft()
        for passage in lane:
            if passage not in seen:
                yield passage
                seen.add(passage)
                pending.append(lane)
                break


def main():
    left = ["left-first", *(f"left-{i}" for i in range(2, 50)), "cross-covered"]
    right = ["right-first", *(f"right-{i}" for i in range(2, 50)), "cross-covered"]
    assert Fraction(2, 110) > Fraction(1, 61)
    assert rrf([left, right])[:3] == ["cross-covered", "left-first", "right-first"]
    balanced = list(round_robin([left, right]))
    assert balanced[:4] == ["left-first", "right-first", "left-2", "right-2"]
    assert balanced[-1] == "cross-covered"
    assert balanced.count("cross-covered") == 1
    assert list(round_robin([left, left, right])) == balanced
    assert list(round_robin([["a", "b", "c"], ["a", "d"], ["a"]])) == ["a", "d", "b", "c"]
    print("RRF rank-50 cross-coverage, round-robin ordering, duplicate lanes, and exhaustion verified.")


if __name__ == "__main__":
    main()
