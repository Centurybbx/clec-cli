use clec::{
    schema::{register, schema},
    search::SNIPPET_MAX_BYTES,
    tokenizer::{CjkNorm, query_terms},
};
use tantivy::{
    Index, Term, doc,
    query::{BooleanQuery, Occur, Query, TermQuery},
    schema::IndexRecordOption,
    snippet::SnippetGenerator,
    tokenizer::{TokenStream, Tokenizer},
};

#[test]
fn snippet_highlights_exact_original_utf8_in_50_cases() -> tantivy::Result<()> {
    let targets = [
        ("繁體", "繁体"),
        ("殖利率", "殖利率"),
        ("那斯達克", "那斯达克"),
        ("４％", "4%"),
        ("４．５％", "4.5%"),
        ("00864B", "00864b"),
        ("００５０", "0050"),
        ("50", "50"),
        ("QQQ", "qqq"),
        ("ﬃ", "ffi"),
    ];
    let contexts = [
        ("😁序言：", "；后記🧮"),
        ("中英mix👩‍💻「", "」收尾"),
        ("  🧑🏾‍🚀️〔", "〕　完"),
        ("简體混排👨‍👩‍👧‍👦【", "】😀\r\n结束"),
        ("𠮷 　測試🙃\t(", ")\n最後Ｃafé"),
    ];
    let schema = schema();
    let body = schema.get_field("body")?;
    let index = Index::create_in_ram(schema);
    register(&index);
    let mut docs = Vec::new();
    let mut writer = index.writer(20_000_000)?;
    for (original, query) in targets {
        for (prefix, suffix) in contexts {
            let text = format!("{prefix}{original}{suffix}");
            let document = doc!(body => text.as_str());
            writer.add_document(document.clone())?;
            docs.push((
                text,
                query,
                prefix.len()..prefix.len() + original.len(),
                document,
            ));
        }
    }
    assert_eq!(docs.len(), 50);
    writer.commit()?;
    let searcher = index.reader()?.searcher();
    let mut tokenizer = CjkNorm;
    for (text, query, target, document) in docs {
        let terms = query_terms(query);
        assert!(!terms.is_empty(), "{query:?}");
        let mut stream = tokenizer.token_stream(&text);
        let mut indexed_bytes = Vec::new();
        while let Some(token) = stream.next() {
            let range = token.offset_from..token.offset_to;
            assert!(text.get(range.clone()).is_some(), "{text:?}: {range:?}");
            if terms.contains(&token.text) {
                indexed_bytes.extend(range);
            }
        }
        assert_eq!(
            indexed_bytes,
            target.clone().collect::<Vec<_>>(),
            "{text:?}"
        );
        let clauses = terms
            .into_iter()
            .map(|term| {
                let term = Term::from_field_text(body, &term);
                let query = TermQuery::new(term, IndexRecordOption::Basic);
                (Occur::Should, Box::new(query) as Box<dyn Query>)
            })
            .collect();
        let query = BooleanQuery::new(clauses);
        let mut generator = SnippetGenerator::create(&searcher, &query, body)?;
        generator.set_max_num_chars(SNIPPET_MAX_BYTES);
        let snippet = generator.snippet_from_doc(&document);
        let fragment = snippet.fragment();
        let fragment_start = text.find(fragment).unwrap();
        let mut highlighted_bytes = Vec::new();
        for range in snippet.highlighted() {
            assert!(fragment.get(range.clone()).is_some(), "{text:?}: {range:?}");
            highlighted_bytes.extend(fragment_start + range.start..fragment_start + range.end);
        }
        assert_eq!(highlighted_bytes, target.collect::<Vec<_>>(), "{text:?}");
    }
    Ok(())
}

#[test]
fn query_stop_words_fall_back_only_if_all_terms_are_removed() {
    assert_eq!(query_terms("the 和"), ["the", "和"]);
    assert_eq!(query_terms("the qqq 和 0050"), ["qqq", "0050"]);
}

#[test]
fn canonicalizes_both_scripts_without_joining_across_separators() {
    assert_eq!(query_terms("繁體"), ["繁体"]);
    assert_eq!(query_terms("繁体"), ["繁体"]);
    for separated in ["繁。體", "繁 體", "繁🧮體", "繁A體", "繁1體"] {
        assert!(!query_terms(separated).iter().any(|term| term == "繁体"));
    }
    assert_eq!(query_terms("cafe\u{301}"), ["café"]);
}

#[test]
fn decimals_codes_and_percentages_preserve_terms_and_exact_offsets() {
    let text = "0.03. 3.5。1.25．００．５％。0050 00864B 4%";
    let mut tokenizer = CjkNorm;
    let mut stream = tokenizer.token_stream(text);
    let mut observed = Vec::new();
    while let Some(token) = stream.next() {
        observed.push((
            &text[token.offset_from..token.offset_to],
            token.text.clone(),
        ));
    }
    let expected = [
        ("0.03", "0.03"),
        ("3.5", "3.5"),
        ("1.25", "1.25"),
        ("００．５％", "00.5%"),
        ("0050", "0050"),
        ("00864B", "00864b"),
        ("4%", "4%"),
    ];
    assert_eq!(
        observed,
        expected.map(|(raw, normalized)| (raw, normalized.to_owned()))
    );
}
