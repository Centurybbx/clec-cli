# Jieba tokenizer data

The inputs are from [Jieba v0.42.1](https://github.com/fxsjy/jieba/releases/tag/v0.42.1), distributed under the accompanying MIT license.

- `dict.txt` is the upstream default `jieba/dict.txt`. Its SHA-256 is `7197c3211ddd98962b036cdf40324d1ea2bfaa12bd028e68faa70111a88e12a8`.
- `emissions.tsv` transposes upstream `jieba/finalseg/prob_emit.py`. Each row contains one character followed by the B, E, M and S emission log probabilities. Characters are sorted by code point. Absent probabilities use Jieba's `-3.14e100` sentinel. The upstream file's SHA-256 is `27d46b1c9efe4dd148fde8be042a21be40e3562d0c7f1273f9de7abae12ebb8d`.

Cargo compiles the dictionary's integer frequencies into an FST map and the emissions into a read-only table. At runtime both resources are embedded, and the dictionary map borrows its bytes from the executable.
