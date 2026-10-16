// Explicit offline fixture generation only; never invoked by the runtime.
fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("fixture directory"));
    for name in ["sum", "loop", "import", "memory", "grow", "trap"] {
        let wat = std::fs::read_to_string(dir.join(format!("{name}.wat"))).unwrap();
        let wasm = wat::parse_str(wat).unwrap();
        std::fs::write(dir.join(format!("{name}.wasm")), wasm).unwrap();
    }
}
