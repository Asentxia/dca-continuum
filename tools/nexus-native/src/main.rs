//! One-shot private stdin/stdout bridge. Not a public server, CLI donor or daemon.
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::time::Duration;
#[path = "../../../vendor/nexus/pure-runtime.rs"]
mod runtime;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    wasm: Vec<u8>, path: String, fuel: u64, memory: usize, timeout: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<i32>,
    #[serde(rename = "fuelConsumed", skip_serializing_if = "Option::is_none")]
    fuel_consumed: Option<u64>,
}
fn failure(reason: &str) -> Reply {
    Reply { status: "FAILED".into(), reason: Some(reason.into()), value: None, fuel_consumed: None }
}
fn process(input: &[u8]) -> Reply {
    let r: Request = match serde_json::from_slice(input) {
        Ok(r) => r, Err(_) => return failure("INVALID_REQUEST"),
    };
    if r.wasm.len() > 65536 || r.wasm.get(..4) != Some(b"\0asm")
        || r.path.is_empty() || r.path.len() > 64
        || !r.path.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || r.fuel == 0 || r.fuel > 100_000_000
        || r.memory < 65536 || r.memory > 16 * 1024 * 1024 || r.memory % 65536 != 0
        || r.timeout == 0 || r.timeout > 1000 { return failure("INVALID_REQUEST"); }
    let sandbox = match runtime::WasmSandbox::new() {
        Ok(s) => s, Err(e) => return failure(e),
    };
    match sandbox.execute(&r.wasm, &r.path, r.fuel, r.memory, Duration::from_millis(r.timeout)) {
        Ok((value, fuel_consumed)) => Reply { status: "LOCAL_RESULT".into(), reason: None,
            value: Some(value), fuel_consumed: Some(fuel_consumed) },
        Err(e) => failure(e),
    }
}
fn main() {
    // Bounds before JSON allocation. No path/network/credential inputs.
    let mut input = Vec::new();
    let reply = match io::stdin().take(300_001).read_to_end(&mut input) {
        Ok(_) if input.len() <= 300_000 => process(&input),
        _ => failure("INVALID_REQUEST"),
    };
    println!("{}", serde_json::to_string(&reply).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(wat: &str, fuel: u64, memory: usize, timeout: u64) -> Reply {
        process(&serde_json::to_vec(&serde_json::json!({"wasm":wat::parse_str(wat).unwrap(),
            "path":"run", "fuel":fuel, "memory":memory, "timeout":timeout})).unwrap())
    }
    #[test]
    fn useful_sum_real_wasm() {
        let r = run(r#"(module (func (export "run") (result i32) (local $n i32) (local $s i32)
          i32.const 100 local.set $n
          (loop $again local.get $n local.get $s i32.add local.set $s
            local.get $n i32.const 1 i32.sub local.tee $n br_if $again)
          local.get $s))"#, 100000, 65536, 500);
        assert_eq!(r.status,"LOCAL_RESULT"); assert_eq!(r.value,Some(5050));
        assert!(r.fuel_consumed.unwrap() > 100);
    }
    #[test]
    fn deny_host_imports() {
        for module in ["wasi_snapshot_preview1", "env", "credentials", "network", "filesystem"] {
            let r=run(&format!(r#"(module (import "{module}" "x" (func))
              (func (export "run") (result i32) i32.const 7))"#),1000,65536,500);
            assert_eq!(r.reason.as_deref(),Some("IMPORT_DENIED"));
        }
    }
    #[test]
    fn fuel_stops_guest() {
        let r=run(r#"(module (func (export "run") (result i32) (loop $x br $x) i32.const 0))"#,10,65536,500);
        assert_eq!(r.reason.as_deref(),Some("FUEL_EXHAUSTED"));
    }
    #[test]
    fn epoch_interrupt_stops_guest() {
        let r=run(r#"(module (func (export "run") (result i32) (loop $x br $x) i32.const 0))"#,100000000,65536,1);
        assert_eq!(r.reason.as_deref(),Some("TIMEOUT"));
    }
    #[test]
    fn memory_and_table_limits() {
        for w in [r#"(module (memory 257) (func (export "run") (result i32) i32.const 1))"#,
            r#"(module (table 1025 funcref) (func (export "run") (result i32) i32.const 1))"#] {
            assert_eq!(run(w,1000,65536,500).reason.as_deref(),Some("RESOURCE_LIMIT"));
        }
        assert_eq!(run(r#"(module (memory 1) (func (export "run") (result i32) i32.const 256 memory.grow))"#,
            1000,65536,500).status,"FAILED");
    }
    #[test]
    fn start_is_metered_too() {
        let r=run(r#"(module (func $s (loop $x br $x)) (start $s)
            (func (export "run") (result i32) i32.const 1))"#,10,65536,500);
        assert_eq!(r.reason.as_deref(),Some("FUEL_EXHAUSTED"));
    }
    #[test]
    fn invalid_abi_trap_and_input() {
        assert_eq!(run(r#"(module (func (export "run")))"#,1000,65536,500).reason.as_deref(),Some("ENTRYPOINT_DENIED"));
        assert_eq!(run(r#"(module (func (export "run") (result i32) unreachable))"#,1000,65536,500).reason.as_deref(),Some("TRAP"));
        assert_eq!(process(b"{}").reason.as_deref(),Some("INVALID_REQUEST"));
        assert_eq!(process(b"not-json").reason.as_deref(),Some("INVALID_REQUEST"));
    }
}
