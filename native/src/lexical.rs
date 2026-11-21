use std::collections::HashSet;
use std::sync::OnceLock;

use ferrous_opencc::{OpenCC, config::BuiltinConfig};
use jieba_rs::Jieba;
use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
use crate::domain::hex_decode;
use crate::domain::{
    ClecError, ErrorCode, LEGACY_NORMALIZATION_REVISION, NORMALIZATION_REVISION, hex_encode,
};

pub(crate) const MAX_QUERY_BYTES: usize = 512;
pub(crate) const MAX_QUERY_TERMS: usize = 64;

struct LexicalEngine {
    opencc: OpenCC,
    jieba: Jieba,
}

fn engine() -> &'static LexicalEngine {
    static ENGINE: OnceLock<LexicalEngine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let opencc = OpenCC::from_config(BuiltinConfig::Tw2s)
            .expect("built-in OpenCC tw2s config must load");
        let jieba = Jieba::new();
        LexicalEngine { opencc, jieba }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Normalization {
    Legacy,
    Current,
}

impl Normalization {
    pub(crate) fn parse(revision: &str) -> Result<Self, ClecError> {
        match revision {
            LEGACY_NORMALIZATION_REVISION => Ok(Self::Legacy),
            NORMALIZATION_REVISION => Ok(Self::Current),
            _ => Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Unsupported corpus normalization revision.",
            )),
        }
    }

    pub(crate) fn revision(self) -> &'static str {
        match self {
            Self::Legacy => LEGACY_NORMALIZATION_REVISION,
            Self::Current => NORMALIZATION_REVISION,
        }
    }

    pub(crate) fn normalize(self, text: &str) -> String {
        let simplified = engine().opencc.convert(text);
        let nfkc: String = simplified.nfkc().collect();
        let normalized = nfkc.to_lowercase();
        if self == Self::Legacy {
            return normalized;
        }

        // OpenCC maps isolated simplified 么 to 幺, while traditional phrase
        // conversions yield 么. Restore only known grammatical endings.
        normalized.replace("什幺", "什么").replace("怎幺", "怎么")
    }
}

pub(crate) fn encode_fts_token(token: &str) -> String {
    format!("t{}", hex_encode(token.as_bytes()))
}

#[cfg(test)]
pub(crate) fn decode_fts_token(encoded: &str) -> Option<String> {
    let hex = encoded.strip_prefix('t')?;
    let bytes = hex_decode(hex)?;
    String::from_utf8(bytes).ok()
}

fn is_cjk_char(c: char) -> bool {
    matches!(
        c,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{20000}'..='\u{2A6DF}'
            | '\u{2A700}'..='\u{2B73F}'
            | '\u{2B740}'..='\u{2B81F}'
            | '\u{2B820}'..='\u{2CEAF}'
            | '\u{2CEB0}'..='\u{2EBEF}'
            | '\u{2F800}'..='\u{2FA1F}'
    )
}

fn segment_normalized(normalized: &str, for_index: bool) -> Vec<String> {
    let mut tokens = Vec::new();
    let bytes = normalized.as_bytes();
    let mut idx = 0;

    while idx < bytes.len() {
        let ch = normalized[idx..].chars().next().unwrap();

        if is_cjk_char(ch) {
            let start = idx;
            idx += ch.len_utf8();
            while idx < bytes.len() {
                let next = normalized[idx..].chars().next().unwrap();
                if is_cjk_char(next) {
                    idx += next.len_utf8();
                } else {
                    break;
                }
            }
            let cjk_run = &normalized[start..idx];
            let cut = if for_index {
                engine().jieba.cut_for_search(cjk_run, true)
            } else {
                engine().jieba.cut(cjk_run, true)
            };
            for tok in cut {
                if !tok.word.is_empty() {
                    tokens.push(tok.word.to_owned());
                }
            }
        } else if ch.is_alphanumeric() {
            let start = idx;
            idx += ch.len_utf8();
            let mut all_ascii_digits = ch.is_ascii_digit();
            while idx < bytes.len() {
                let next = normalized[idx..].chars().next().unwrap();
                if next.is_alphanumeric() && !is_cjk_char(next) {
                    if !next.is_ascii_digit() {
                        all_ascii_digits = false;
                    }
                    idx += next.len_utf8();
                } else if next == '.' && all_ascii_digits {
                    let after_dot = idx + 1;
                    if after_dot < bytes.len()
                        && normalized[after_dot..]
                            .chars()
                            .next()
                            .is_some_and(|d| d.is_ascii_digit())
                    {
                        idx = after_dot;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            if idx < bytes.len() && normalized[idx..].starts_with('%') {
                idx += 1;
            }
            tokens.push(normalized[start..idx].to_owned());
        } else {
            idx += ch.len_utf8();
        }
    }

    tokens
}

impl Normalization {
    pub(crate) fn tokenize_normalized(self, text: &str) -> Vec<String> {
        let normalized = self.normalize(text);
        segment_normalized(&normalized, false)
    }

    pub(crate) fn index_tokens(self, text: &str) -> String {
        let normalized = self.normalize(text);
        segment_normalized(&normalized, true)
            .into_iter()
            .map(|tok| encode_fts_token(&tok))
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub(crate) fn query_terms(self, query: &str) -> Result<Vec<String>, ClecError> {
        let trimmed = query.trim();
        if trimmed.is_empty() || query.len() > MAX_QUERY_BYTES || query.contains('\0') {
            return Err(ClecError::new(
                ErrorCode::InvalidQuery,
                "Query must be 1..512 UTF-8 bytes without NUL.",
            ));
        }
        let normalized = self.normalize(trimmed);
        let raw_terms = segment_normalized(&normalized, false);
        let mut seen = HashSet::new();
        let mut deduped = Vec::new();
        for term in raw_terms {
            if seen.insert(term.clone()) {
                deduped.push(term);
            }
        }
        if deduped.is_empty() || deduped.len() > MAX_QUERY_TERMS {
            return Err(ClecError::new(
                ErrorCode::InvalidQuery,
                "Query must produce 1..64 distinct lexical terms.",
            ));
        }
        Ok(deduped)
    }
}

pub(crate) fn index_tokens_string(text: &str) -> String {
    Normalization::Current.index_tokens(text)
}

#[cfg(test)]
fn query_terms(query: &str) -> Result<Vec<String>, ClecError> {
    Normalization::Current.query_terms(query)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_0050_qqq_and_4_percent_distinct_from_bare_numbers() {
        let t_0050 = query_terms("0050").unwrap();
        let t_50 = query_terms("50").unwrap();
        assert_eq!(t_0050, vec!["0050"]);
        assert_eq!(t_50, vec!["50"]);
        assert_ne!(t_0050, t_50);

        let t_qqq_upper = query_terms("QQQ").unwrap();
        let t_qqq_full = query_terms("ＱＱＱ").unwrap();
        assert_eq!(t_qqq_upper, vec!["qqq"]);
        assert_eq!(t_qqq_full, vec!["qqq"]);

        let t_4pct = query_terms("4%").unwrap();
        let t_4pct_full = query_terms("４％").unwrap();
        let t_4 = query_terms("4").unwrap();
        assert_eq!(t_4pct, vec!["4%"]);
        assert_eq!(t_4pct_full, vec!["4%"]);
        assert_ne!(t_4pct, t_4);

        let mixed = query_terms("0050 QQQ 4%法則 00864B").unwrap();
        assert_eq!(mixed, vec!["0050", "qqq", "4%", "法则", "00864b"]);
    }

    #[test]
    fn grammatical_me_variants_share_fts_terms_without_replacing_literal_yao() {
        for spellings in [
            ["什么", "什麼", "什幺"],
            ["怎么", "怎麼", "怎幺"],
            ["为什么", "為什麼", "为什幺"],
        ] {
            let expected = query_terms(spellings[0]).unwrap();
            for spelling in spellings {
                assert_eq!(query_terms(spelling).unwrap(), expected);
                assert_eq!(
                    index_tokens_string(spelling),
                    index_tokens_string(spellings[0])
                );
            }
        }
        assert_eq!(query_terms("幺二").unwrap(), vec!["幺", "二"]);
        assert_eq!(Normalization::Current.normalize("我要幺鸡"), "我要幺鸡");
        assert_eq!(
            Normalization::Legacy.query_terms("什么").unwrap(),
            vec!["什幺"]
        );
    }

    #[test]
    fn traditional_and_simplified_produce_matching_terms() {
        let trad = query_terms("資產配置 退休提領 再平衡").unwrap();
        let simp = query_terms("资产配置 退休提领 再平衡").unwrap();
        assert_eq!(trad, simp);
    }

    #[test]
    fn index_and_query_tokens_roundtrip_via_hex() {
        let encoded = encode_fts_token("4%");
        assert_eq!(decode_fts_token(&encoded).as_deref(), Some("4%"));
        let idx = index_tokens_string("買進0050與QQQ並保留4%提領");
        assert!(idx.contains(&encode_fts_token("0050")));
        assert!(idx.contains(&encode_fts_token("qqq")));
        assert!(idx.contains(&encode_fts_token("4%")));

        let long_passage = "0050 與 QQQ 配置 ".repeat(60);
        assert!(long_passage.len() > MAX_QUERY_BYTES);
        let toks = Normalization::Current.tokenize_normalized(&long_passage);
        assert!(!toks.is_empty());
        assert_eq!(toks[0], "0050");
    }
}
