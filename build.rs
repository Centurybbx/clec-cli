use std::{
    collections::BTreeMap,
    env, fs,
    io::{BufWriter, Write},
    path::PathBuf,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    const DICTIONARY: &str = "jieba/dict.txt";
    const EMISSIONS: &str = "jieba/emissions.tsv";
    println!("cargo:rerun-if-changed={DICTIONARY}");
    println!("cargo:rerun-if-changed={EMISSIONS}");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));

    let dictionary = fs::read_to_string(DICTIONARY)?;
    let mut entries = BTreeMap::new();
    let mut total = 0_u64;
    for line in dictionary.lines() {
        let mut fields = line.split_whitespace();
        let word = fields.next().expect("Jieba dictionary word");
        let freq: u64 = fields.next().expect("Jieba dictionary frequency").parse()?;
        total += freq;
        entries.insert(word, freq);
    }
    let mut map = fst::MapBuilder::new(BufWriter::new(fs::File::create(out.join("jieba.fst"))?))?;
    map.extend_iter(entries)?;
    map.finish()?;
    fs::write(out.join("jieba_total.rs"), format!("{total}_u64"))?;

    let mut table = BufWriter::new(fs::File::create(out.join("jieba_emissions.rs"))?);
    writeln!(table, "&[")?;
    for line in fs::read_to_string(EMISSIONS)?.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let [character, begin, end, middle, single] = fields[..] else {
            panic!("invalid Jieba emission row: {line}");
        };
        let character: char = character.parse()?;
        let bits = [begin, end, middle, single].map(|score| {
            score
                .parse::<f64>()
                .expect("valid Jieba emission score")
                .to_bits()
        });
        writeln!(table, "({character:?}, {bits:?}),")?;
    }
    writeln!(table, "]")?;
    table.flush()?;
    Ok(())
}
