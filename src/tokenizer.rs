use std::{borrow::Cow, collections::HashSet, ops::Range, sync::LazyLock};

use regex::Regex;
use tantivy::tokenizer::{Token, TokenStream, Tokenizer};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfkc_quick};
use unicode_script::{Script, UnicodeScript};
use unicode_segmentation::UnicodeSegmentation;

use crate::jieba;

pub const NAME: &str = "cjk_norm";

// Find decimals and percentages before looking for codes in the intervening text.
static DECIMAL_OR_PERCENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9０-９]+(?:[.．][0-9０-９]+[%％]?|[%％])").unwrap());
static CODE_OR_INTEGER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-zＡ-Ｚａ-ｚ0-9０-９]*[0-9０-９][A-Za-zＡ-Ｚａ-ｚ0-9０-９]*").unwrap()
});

#[derive(Clone, Default)]
pub struct CjkNorm;

pub struct CjkStream {
    tokens: std::vec::IntoIter<Token>,
    current: Token,
}

impl Tokenizer for CjkNorm {
    type TokenStream<'a> = CjkStream;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> CjkStream {
        let mut tokens = Vec::new();
        let mut start = 0;
        let mut han = text.chars().next().is_some_and(is_han);
        for (end, character) in text.char_indices() {
            let next_is_han = is_han(character);
            if han != next_is_han {
                segment(text, start, end, han, &mut tokens);
                start = end;
                han = next_is_han;
            }
        }
        segment(text, start, text.len(), han, &mut tokens);
        CjkStream {
            tokens: tokens.into_iter(),
            current: Token::default(),
        }
    }
}

fn is_han(character: char) -> bool {
    character.script() == Script::Han
}

fn segment(text: &str, from: usize, to: usize, han: bool, tokens: &mut Vec<Token>) {
    let run = &text[from..to];
    if han {
        let first = tokens.len();
        let mut changed = false;
        jieba::cut(run, |offset, word| {
            let start = from + offset;
            let folded = fold(word);
            let normalized = simplify(&folded);
            changed |= normalized != word;
            push(
                text,
                start,
                start + word.len(),
                normalized.into_owned(),
                tokens,
            );
        });
        if changed {
            resegment(text, tokens, first);
        }
    } else {
        let mut cursor = from;
        for number in DECIMAL_OR_PERCENT.find_iter(run) {
            let start = from + number.start();
            let end = from + number.end();
            segment_codes(text, cursor, start, tokens);
            push(text, start, end, fold(number.as_str()).into_owned(), tokens);
            cursor = end;
        }
        segment_codes(text, cursor, to, tokens);
    }
}

fn segment_codes(text: &str, from: usize, to: usize, tokens: &mut Vec<Token>) {
    let mut cursor = from;
    for code in CODE_OR_INTEGER.find_iter(&text[from..to]) {
        let start = from + code.start();
        let end = from + code.end();
        segment_words(text, cursor, start, tokens);
        push(text, start, end, fold(code.as_str()).into_owned(), tokens);
        cursor = end;
    }
    segment_words(text, cursor, to, tokens);
}

fn segment_words(text: &str, from: usize, to: usize, tokens: &mut Vec<Token>) {
    for (offset, word) in text[from..to].unicode_word_indices() {
        let start = from + offset;
        push(
            text,
            start,
            start + word.len(),
            fold(word).into_owned(),
            tokens,
        );
    }
}

struct Piece {
    normalized: Range<usize>,
    source: Range<usize>,
    aligned: bool,
}

impl Piece {
    fn project(&self, normalized: &str, source: &str, offset: usize) -> Option<usize> {
        if offset == self.normalized.start {
            return Some(self.source.start);
        }
        if offset == self.normalized.end {
            return Some(self.source.end);
        }
        if self.aligned {
            let characters = normalized[self.normalized.start..offset].chars().count();
            let (relative, _) = source[self.source.clone()].char_indices().nth(characters)?;
            return Some(self.source.start + relative);
        }
        None
    }
}

// Equal-length conversions keep character boundaries aligned. If a conversion
// changes the character count, a boundary inside it covers the full source piece.
fn resegment(original: &str, tokens: &mut Vec<Token>, start: usize) {
    let mut normalized = String::new();
    let pieces: Vec<_> = tokens
        .drain(start..)
        .map(|token| {
            let from = normalized.len();
            normalized.push_str(&token.text);
            let source = token.offset_from..token.offset_to;
            let aligned = token.text.chars().count() == original[source.clone()].chars().count();
            Piece {
                normalized: from..normalized.len(),
                source,
                aligned,
            }
        })
        .collect();

    jieba::cut(&normalized, |from, word| {
        let to = from + word.len();
        let first = &pieces[pieces.partition_point(|piece| piece.normalized.end <= from)];
        let last = &pieces[pieces.partition_point(|piece| piece.normalized.end < to)];
        let source_from = first
            .project(&normalized, original, from)
            .unwrap_or(first.source.start);
        let source_to = last
            .project(&normalized, original, to)
            .unwrap_or(last.source.end);
        push(original, source_from, source_to, word.into(), tokens);
    });
}

fn fold(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        if text.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Cow::Owned(text.to_ascii_lowercase());
        }
        return Cow::Borrowed(text);
    }
    if is_nfkc_quick(text.chars()) == IsNormalized::Yes && text.chars().case_fold().eq(text.chars())
    {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.nfkc().case_fold().collect())
    }
}

fn simplify(text: &str) -> Cow<'_, str> {
    let converter = zhconv::get_builtin_converter(zhconv::Variant::ZhHans);
    if converter.count_replaced(text) == 0 {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(converter.convert(text))
    }
}

fn push(original: &str, from: usize, to: usize, text: String, tokens: &mut Vec<Token>) {
    assert!(from < to && original.get(from..to).is_some());
    tokens.push(Token {
        offset_from: from,
        offset_to: to,
        position: tokens.len(),
        position_length: 1,
        text,
    });
}

impl TokenStream for CjkStream {
    fn advance(&mut self) -> bool {
        if let Some(next) = self.tokens.next() {
            self.current = next;
            true
        } else {
            false
        }
    }

    fn token(&self) -> &Token {
        &self.current
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.current
    }
}

pub(crate) fn tokenize(text: &str) -> Vec<String> {
    CjkNorm
        .token_stream(text)
        .tokens
        .map(|token| token.text)
        .collect()
}

pub fn query_terms(text: &str) -> Vec<String> {
    static STOP_WORDS: LazyLock<HashSet<&'static str>> =
        LazyLock::new(|| include_str!("stopwords.txt").split_whitespace().collect());

    let mut terms = tokenize(text);
    if terms.iter().any(|term| !STOP_WORDS.contains(term.as_str())) {
        terms.retain(|term| !STOP_WORDS.contains(term.as_str()));
    }
    terms
}

#[cfg(test)]
mod tests {
    use tantivy::{
        Index, Term, doc,
        query::{BooleanQuery, Occur, Query, TermQuery},
        schema::IndexRecordOption,
        snippet::{SnippetGenerator, collapse_overlapped_ranges},
    };

    use super::*;
    use crate::schema::schema;

    #[derive(Clone)]
    struct WithLengthChanges;

    impl Tokenizer for WithLengthChanges {
        type TokenStream<'a> = CjkStream;

        fn token_stream<'a>(&'a mut self, original: &'a str) -> CjkStream {
            let mut tokens = Vec::new();
            if original == "甲" {
                push(original, 0, 3, "繁体简体".into(), &mut tokens);
            } else {
                assert_eq!(original, "甲乙丙");
                push(original, 0, 6, "繁".into(), &mut tokens);
                push(original, 6, 9, "体".into(), &mut tokens);
            }
            resegment(original, &mut tokens, 0);
            CjkStream {
                tokens: tokens.into_iter(),
                current: Token::default(),
            }
        }
    }

    #[test]
    fn changed_length_pieces_project_safely_through_snippets() -> tantivy::Result<()> {
        // Exercise length-changing pieces explicitly. The selected ZhHans tables
        // contain only equal-character-count conversions.
        let schema = schema();
        let body = schema.get_field("body")?;
        let index = Index::create_in_ram(schema);
        index.tokenizers().register(NAME, WithLengthChanges);
        let expansion = doc!(body => "甲");
        let contraction = doc!(body => "甲乙丙");
        let mut writer = index.writer(20_000_000)?;
        writer.add_document(expansion.clone())?;
        writer.add_document(contraction.clone())?;
        writer.commit()?;
        let terms = ["繁体", "简体"]
            .into_iter()
            .map(|word| {
                let term = Term::from_field_text(body, word);
                (
                    Occur::Should,
                    Box::new(TermQuery::new(term, IndexRecordOption::Basic)) as Box<dyn Query>,
                )
            })
            .collect();
        let query = BooleanQuery::new(terms);
        let searcher = index.reader()?.searcher();
        let generator = SnippetGenerator::create(&searcher, &query, body)?;
        let snippet = generator.snippet_from_doc(&expansion);
        assert_eq!(snippet.highlighted().len(), 2);
        assert_eq!(
            collapse_overlapped_ranges(snippet.highlighted()),
            vec![0..3]
        );
        assert_eq!(snippet.fragment(), "甲");
        let snippet = generator.snippet_from_doc(&contraction);
        assert_eq!(snippet.highlighted().len(), 1);
        assert_eq!(snippet.highlighted()[0], 0..9);
        assert_eq!(snippet.fragment(), "甲乙丙");
        Ok(())
    }
}
