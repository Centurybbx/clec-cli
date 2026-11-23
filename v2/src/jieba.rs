use std::sync::LazyLock;

use fst::{Map, raw::Output};

const TOTAL_FREQUENCY: u64 = include!(concat!(env!("OUT_DIR"), "/jieba_total.rs"));
static DICTIONARY: LazyLock<Map<&'static [u8]>> = LazyLock::new(|| {
    Map::new(include_bytes!(concat!(env!("OUT_DIR"), "/jieba.fst")).as_slice())
        .expect("valid build-time Jieba FST")
});

// Jieba finalseg states in lexical order, which also breaks score ties.
const BEGIN: usize = 0;
const END: usize = 1;
const MIDDLE: usize = 2;
const SINGLE: usize = 3;
const MISSING: f64 = -3.14e100;
const START: [f64; 4] = [-0.26268660809250016, MISSING, MISSING, -1.4652633398537678];
const PREVIOUS: [[(usize, f64); 2]; 4] = [
    [(END, -0.5897149736854513), (SINGLE, -0.7211965654669841)],
    [(BEGIN, -0.51082562376599), (MIDDLE, -0.33344856811948514)],
    [(BEGIN, -0.916290731874155), (MIDDLE, -1.2603623820268226)],
    [(END, -0.8085250474669937), (SINGLE, -0.6658631448798212)],
];
static EMISSIONS: &[(char, [u64; 4])] = include!(concat!(env!("OUT_DIR"), "/jieba_emissions.rs"));

pub fn initialize() {
    LazyLock::force(&DICTIONARY);
}

pub fn cut(text: &str, mut token: impl FnMut(usize, &str)) {
    let mut offsets: Vec<_> = text.char_indices().map(|(offset, _)| offset).collect();
    let len = offsets.len();
    if len < 2 {
        if len == 1 {
            token(0, text);
        }
        return;
    }
    offsets.push(text.len());
    let route = best_route(text, &offsets);
    let mut start = 0;
    let mut singles = 0;
    while start < len {
        let end = route[start].1;
        if end > start + 1 {
            cut_singles(text, &offsets[singles..=start], &mut token);
            token(offsets[start], &text[offsets[start]..offsets[end]]);
            singles = end;
        }
        start = end;
    }
    cut_singles(text, &offsets[singles..], &mut token);
}

fn best_route(text: &str, offsets: &[usize]) -> Vec<(f64, usize)> {
    let dictionary = DICTIONARY.as_fst();
    let root = dictionary.root();
    let mut route = vec![(0.0, 0); offsets.len()];
    let log_total = (TOTAL_FREQUENCY as f64).ln();
    for start in (0..offsets.len() - 1).rev() {
        let mut node = root;
        let mut output = Output::zero();
        let mut best = (f64::NEG_INFINITY, start + 1);
        let mut end = start + 1;
        // Enumerate the DAG edges from this position while scoring their
        // already-computed suffixes, so the edges never need to be stored.
        for (offset, byte) in text.bytes().enumerate().skip(offsets[start]) {
            let Some(index) = node.find_input(byte) else {
                break;
            };
            let edge = node.transition(index);
            output = output.cat(edge.out);
            node = dictionary.node(edge.addr);
            if offset + 1 == offsets[end] {
                if node.is_final() {
                    let freq = output.cat(node.final_output()).value();
                    if freq > 0 {
                        let score = (freq as f64).ln() - log_total + route[end].0;
                        if (score, end) > best {
                            best = (score, end);
                        }
                    }
                }
                end += 1;
            }
        }
        if best.0 == f64::NEG_INFINITY {
            best.0 = route[start + 1].0 - log_total;
        }
        route[start] = best;
    }
    route
}

fn cut_singles(text: &str, offsets: &[usize], token: &mut impl FnMut(usize, &str)) {
    let len = offsets.len() - 1;
    if len == 0 {
        return;
    }
    let start = offsets[0];
    let singles = &text[start..offsets[len]];
    if len == 1 || DICTIONARY.get(singles).is_some_and(|freq| freq > 0) {
        for bytes in offsets.windows(2) {
            token(bytes[0], &text[bytes[0]..bytes[1]]);
        }
    } else {
        let mut begin = 0;
        for (i, state) in viterbi(singles).into_iter().enumerate() {
            if state == END || state == SINGLE {
                token(offsets[begin], &text[offsets[begin]..offsets[i + 1]]);
                begin = i + 1;
            }
        }
    }
}

fn emissions(character: char) -> [f64; 4] {
    EMISSIONS
        .binary_search_by_key(&character, |&(key, _)| key)
        .map_or([MISSING; 4], |index| EMISSIONS[index].1.map(f64::from_bits))
}

fn viterbi(text: &str) -> Vec<usize> {
    let mut chars = text.chars();
    let first = emissions(chars.next().expect("nonempty Han run"));
    let mut scores: [f64; 4] = std::array::from_fn(|state| START[state] + first[state]);
    let mut back = Vec::new();
    for character in chars {
        let emission = emissions(character);
        let paths: [(f64, usize); 4] = std::array::from_fn(|state| {
            let [(left, p_left), (right, p_right)] = PREVIOUS[state];
            let left = (scores[left] + p_left + emission[state], left);
            let right = (scores[right] + p_right + emission[state], right);
            if left > right { left } else { right }
        });
        scores = paths.map(|(score, _)| score);
        back.push(paths.map(|(_, previous)| previous));
    }
    let mut state = if scores[END] > scores[SINGLE] {
        END
    } else {
        SINGLE
    };
    let mut path = vec![state; back.len() + 1];
    for (i, previous) in back.into_iter().enumerate().rev() {
        state = previous[state];
        path[i] = state;
    }
    path
}

#[cfg(test)]
mod tests {
    use super::cut;

    #[test]
    fn exact_mode_matches_jieba_dictionary_and_hmm_examples() {
        for (input, expected) in [
            ("南京市长江大桥", &["南京市", "长江大桥"][..]),
            ("网易杭研", &["网易", "杭研"]),
            ("王小璐今天来到网易", &["王小璐", "今天", "来到", "网易"]),
        ] {
            let mut tokens = Vec::new();
            cut(input, |offset, word| {
                assert_eq!(&input[offset..offset + word.len()], word);
                tokens.push(word.to_owned());
            });
            assert_eq!(tokens, expected);
        }
    }
}
