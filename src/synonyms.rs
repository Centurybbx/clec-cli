use std::{collections::BTreeSet, fs, path::Path};

use anyhow::{Context, Result, ensure};

use crate::tokenizer::tokenize;

#[derive(Default)]
pub(crate) struct Synonyms(Vec<Vec<Vec<String>>>);

impl Synonyms {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let groups: Vec<Vec<String>> =
            serde_json::from_slice(bytes).context("invalid synonyms JSON")?;
        let mut normalized = Vec::new();
        for (i, group) in groups.into_iter().enumerate() {
            ensure!(
                group.len() >= 2,
                "synonym group {} needs at least two entries",
                i + 1
            );
            let mut entries = BTreeSet::new();
            for entry in group {
                let terms = tokenize(&entry);
                ensure!(!terms.is_empty(), "empty synonym in group {}", i + 1);
                entries.insert(terms);
            }
            if entries.len() > 1 {
                normalized.push(entries.into_iter().collect());
            }
        }
        Ok(Self(normalized))
    }

    pub fn load(index: &Path) -> Result<Self> {
        match fs::read(index.join("synonyms.json")) {
            Ok(bytes) => Self::parse(&bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn expand(&self, text: &str, terms: &[String]) -> Vec<(String, Vec<Vec<String>>)> {
        if self.0.is_empty() {
            return Vec::new();
        }
        let raw = tokenize(text);
        let mut expansions = Vec::new();
        for group in &self.0 {
            let matches = |alias: &[String]| raw.windows(alias.len()).any(|window| window == alias);
            if let Some(anchor) = group
                .iter()
                .filter(|alias| matches(alias))
                .max_by_key(|alias| alias.len())
                .and_then(|alias| alias.iter().find(|term| terms.contains(term)))
            {
                let aliases: Vec<_> = group
                    .iter()
                    .filter(|alias| !matches(alias))
                    .cloned()
                    .collect();
                if !aliases.is_empty() {
                    expansions.push((anchor.clone(), aliases));
                }
            }
        }
        expansions
    }
}
