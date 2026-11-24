use std::{collections::BTreeMap, fs::File, io::BufReader, path::Path};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub works: usize,
    pub sources: usize,
    pub passages: u64,
    pub by_kind: BTreeMap<String, u64>,
    pub by_quality: BTreeMap<String, u64>,
    pub by_year: BTreeMap<String, u64>,
}

#[derive(Deserialize, Serialize)]
pub struct Metadata {
    pub schema_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
    pub counts: Counts,
    pub known_gaps: Vec<String>,
    pub disclaimer: String,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

impl Metadata {
    pub fn derived(counts: Counts) -> Self {
        Self {
            schema_version: 2,
            pack_name: None,
            pack_version: None,
            built_at: None,
            counts,
            known_gaps: Vec::new(),
            disclaimer: String::new(),
            extra: BTreeMap::new(),
        }
    }

    pub fn load(path: &Path) -> Result<Self> {
        let metadata: Self = serde_json::from_reader(BufReader::new(File::open(path)?))
            .with_context(|| format!("invalid metadata in {}", path.display()))?;
        ensure!(
            metadata.schema_version == 2,
            "unsupported metadata schema version"
        );
        Ok(metadata)
    }
}
