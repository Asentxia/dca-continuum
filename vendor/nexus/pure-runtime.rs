// Adapted from Adaptive-Liquidity/Nexus-temp src/sandbox/wasm_runtime.rs
// pin e1c3d3c75d58f609c617e7a87cb05e84ea437d64. MIT, (c) 2026 Adaptive-Liquidity.
// See LICENSE and docs/integrations/NEXUS-AUDIT.md for reviewed extraction ranges.
// Pure Store/limiter/fuel/empty-Linker/call path only; no WASI or snapshot claims.
use std::sync::{mpsc, Arc};
use std::time::Duration;
use wasmtime::{Config, Engine, Linker, Module, Store, Trap};

pub struct WasmState {
    limits: wasmtime::StoreLimits,
}
impl WasmState {
    pub fn new(max_memory_bytes: usize) -> Self {
        WasmState {
            limits: wasmtime::StoreLimitsBuilder::new()
                .memory_size(max_memory_bytes)
                .table_elements(1024)
                .instances(1)
                .memories(1)
                .tables(1)
                .trap_on_grow_failure(true)
                .build(),
        }
    }
}

pub struct WasmSandbox {
    engine: Arc<Engine>,
}
impl WasmSandbox {
    pub fn new() -> Result<Self, &'static str> {
        let mut cfg = Config::new();
        cfg.consume_fuel(true);
        cfg.epoch_interruption(true);
        // Continuum narrowing: native memory/stack budgets as well as guest limits.
        cfg.max_wasm_stack(256 * 1024);
        cfg.memory_reservation(16 * 1024 * 1024);
        cfg.memory_guard_size(65536);
        cfg.memory_reservation_for_growth(0);
        cfg.wasm_memory64(false);
        cfg.wasm_multi_memory(false);
        let engine = Engine::new(&cfg).map_err(|_| "RUNTIME_UNAVAILABLE")?;
        Ok(WasmSandbox { engine: Arc::new(engine) })
    }

    pub fn execute(
        &self, wasm_bytes: &[u8], entry_point: &str, max_fuel: u64,
        max_memory_bytes: usize, time_limit: Duration,
    ) -> Result<(i32, u64), &'static str> {
        // Compilation is covered by the caller's process kill-and-reap deadline.
        let module = Module::from_binary(&self.engine, wasm_bytes)
            .map_err(|_| "INVALID_MODULE")?;
        if module.imports().next().is_some() { return Err("IMPORT_DENIED"); }
        let mut store = Store::new(&self.engine, WasmState::new(max_memory_bytes));
        store.epoch_deadline_trap();
        store.set_epoch_deadline(1);
        store.limiter(|s| &mut s.limits);
        store.set_fuel(max_fuel).map_err(|_| "RUNTIME_UNAVAILABLE")?;
        let engine = self.engine.clone();
        // Per-process engine, no shared epochs or worker leak after return.
        let (tx, rx) = mpsc::channel::<()>();
        let timer = std::thread::spawn(move || {
            if matches!(rx.recv_timeout(time_limit), Err(mpsc::RecvTimeoutError::Timeout)) {
                engine.increment_epoch();
            }
        });
        let run = || -> Result<(i32, u64), &'static str> {
            let linker = Linker::new(&self.engine);
            let instance = linker.instantiate(&mut store, &module)
                .map_err(|e| classify(&e, "RESOURCE_LIMIT"))?;
            // Intentional strict ABI: no `_start`/`main` fallback or host input.
            let start_func = instance.get_typed_func::<(), i32>(&mut store, entry_point)
                .map_err(|_| "ENTRYPOINT_DENIED")?;
            let call_result = start_func.call(&mut store, ());
            let fuel_remaining = store.get_fuel().unwrap_or(0);
            let fuel_consumed = max_fuel.saturating_sub(fuel_remaining);
            match call_result {
                Ok(value) => Ok((value, fuel_consumed)),
                Err(e) => Err(classify(&e, "TRAP")),
            }
        }();
        let _ = tx.send(());
        let _ = timer.join();
        run
    }
}
fn classify(error: &wasmtime::Error, fallback: &'static str) -> &'static str {
    match error.downcast_ref::<Trap>() {
        Some(Trap::OutOfFuel) => "FUEL_EXHAUSTED",
        Some(Trap::Interrupt) => "TIMEOUT",
        _ => fallback,
    }
}
